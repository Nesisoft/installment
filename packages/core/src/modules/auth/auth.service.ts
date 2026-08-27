import { PasswordService } from '../../shared/auth/password.service';
import { JwtService } from '../../shared/auth/jwt.service';
import { OtpService } from '../../shared/auth/otp.service';
import { UsersService, type User } from '../users/users.service';
import { UserNotFoundError } from '../users/errors';
import { CustomersService } from '../customers/customers.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import {
  loginSchema,
  otpStartSchema,
  otpVerifySchema,
  refreshSchema,
  signupStartSchema,
  signupVerifySchema,
  signupVerifyCodeSchema,
  signupCompleteSchema,
} from './dto';
import {
  AccountInactiveError,
  InvalidCredentialsError,
  InvalidOtpError,
  InvalidTokenError,
  PhoneAlreadyRegisteredError,
} from './errors';

/** Minimal SMS port — @installment/sms-client's clients satisfy it structurally. */
export interface SmsSender {
  send(message: { to: string; sender: string; message: string }): Promise<unknown>;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResult {
  userId: string;
  userType: string;
  tokens: AuthTokens;
  permissions: string[];
}

export interface AuthServiceDeps {
  users: UsersService;
  passwords: PasswordService;
  jwt: JwtService;
  otp: OtpService;
  /** Optional SMS delivery for customer OTP. If absent, OTP is generated but not sent. */
  sms?: SmsSender;
  /** Registered SMS sender id. Default 'Installmt'. */
  smsSenderId?: string;
  /** Override the OTP SMS body. */
  otpMessage?: (code: string) => string;
  /** Required for customer self-signup; without it the signup methods refuse. */
  customers?: CustomersService;
}

/** Signup codes live in their own keyspace so a login code cannot create an account. */
const signupTarget = (phone: string): string => `signup:${phone}`;

const defaultOtpMessage = (code: string): string =>
  `Your Installment verification code is ${code}. It expires in 5 minutes.`;

/**
 * Authentication for the three actor classes:
 *   * staff (admin/agent) and merchants → email + password
 *   * customers → phone + OTP
 * Issues HS256 access/refresh JWTs; refresh() rotates the pair (stateless).
 */
export class AuthService {
  constructor(private readonly deps: AuthServiceDeps) {}

  async passwordLogin(rawInput: unknown): Promise<AuthResult> {
    const { email, password } = loginSchema.parse(rawInput);
    const user = await this.deps.users.findByEmail(email);
    if (!user || !user.password_hash) throw new InvalidCredentialsError();
    if (!user.is_active || user.deleted_at) throw new AccountInactiveError();

    const ok = await this.deps.passwords.verify(password, user.password_hash);
    if (!ok) throw new InvalidCredentialsError();

    await this.deps.users.recordLogin(user.id);
    return this.result(user);
  }

  async customerOtpStart(rawInput: unknown): Promise<{ expiresAt: Date }> {
    const { phone } = otpStartSchema.parse(rawInput);
    const user = await this.deps.users.findByPhone(phone);
    if (!user || !user.is_active) throw new UserNotFoundError(phone);

    const { code, expiresAt } = await this.deps.otp.start(phone);
    if (this.deps.sms) {
      await this.deps.sms.send({
        to: phone,
        sender: this.deps.smsSenderId ?? 'Installmt',
        message: (this.deps.otpMessage ?? defaultOtpMessage)(code),
      });
    }
    return { expiresAt };
  }

  async customerOtpVerify(rawInput: unknown): Promise<AuthResult> {
    const { phone, code } = otpVerifySchema.parse(rawInput);
    const ok = await this.deps.otp.verify(phone, code);
    if (!ok) throw new InvalidOtpError();

    const user = await this.deps.users.findByPhone(phone);
    if (!user || !user.is_active) throw new InvalidOtpError();

    await this.deps.users.recordLogin(user.id);
    return this.result(user);
  }

  /**
   * Step 1 of self-signup: send a code, create nothing.
   *
   * Verify-then-create, deliberately. If rows were written here, every bot that
   * hit this endpoint would leave a customer record and an SMS bill behind, and
   * an abandoned signup would squat the phone number that a real customer needs.
   */
  async customerSignupStart(rawInput: unknown): Promise<{ expiresAt: Date }> {
    const { phone } = signupStartSchema.parse(rawInput);
    const existing = await this.deps.users.findByPhone(phone);
    if (existing) throw new PhoneAlreadyRegisteredError();

    const { code, expiresAt } = await this.deps.otp.start(signupTarget(phone));
    if (this.deps.sms) {
      await this.deps.sms.send({
        to: phone,
        sender: this.deps.smsSenderId ?? 'Installmt',
        message: (this.deps.otpMessage ?? defaultOtpMessage)(code),
      });
    }
    return { expiresAt };
  }

  /**
   * Step 2: the code checks out, so create the account and sign them in.
   *
   * The customer record and the login are written in separate transactions
   * (each service owns its own). A crash between them leaves an unlinked
   * customer rather than a broken account, and the reuse branch below adopts it
   * on the next attempt instead of colliding with the unique phone.
   */
  /**
   * Step 2: prove the code before the registration form is shown.
   *
   * The code is burned here, and a short-lived ticket takes its place. Doing it
   * this way means someone cannot be asked to fill in a whole form only to be
   * told at the end that the code was wrong or had expired — and because the
   * OTP itself lives five minutes, the ticket is what gives them time to type.
   *
   * Still creates nothing: the ticket is a claim about a phone, not an account.
   */
  async customerSignupVerifyCode(rawInput: unknown): Promise<{ signupToken: string }> {
    const input = signupVerifyCodeSchema.parse(rawInput);

    if (await this.deps.users.findByPhone(input.phone)) throw new PhoneAlreadyRegisteredError();

    const ok = await this.deps.otp.verify(signupTarget(input.phone), input.code);
    if (!ok) throw new InvalidOtpError();

    return { signupToken: this.deps.jwt.signSignup(input.phone) };
  }

  /**
   * Step 3: the ticket plus the profile — the call that actually creates the
   * account. The phone comes from the ticket, never from the request body, so a
   * caller cannot verify one number and register a different one.
   */
  async customerSignupComplete(rawInput: unknown): Promise<AuthResult> {
    const input = signupCompleteSchema.parse(rawInput);

    let phone: string;
    try {
      phone = this.deps.jwt.verifySignup(input.signupToken);
    } catch {
      throw new InvalidTokenError();
    }

    return this.createVerifiedCustomer({
      phone,
      first_name: input.first_name,
      last_name: input.last_name,
      ...(input.email ? { email: input.email } : {}),
      consents: input.consents,
    });
  }

  /**
   * Single-call signup: code and profile together. Kept for callers that submit
   * both at once; the three-step flow (start -> verify-code -> complete) is what
   * the customer app uses, so a bad code is caught before the form is filled.
   */
  async customerSignupVerify(rawInput: unknown): Promise<AuthResult> {
    const input = signupVerifySchema.parse(rawInput);

    const ok = await this.deps.otp.verify(signupTarget(input.phone), input.code);
    if (!ok) throw new InvalidOtpError();

    return this.createVerifiedCustomer(input);
  }

  /**
   * Creates the account for a phone whose ownership has already been proven —
   * by a burned OTP or by a signup ticket. Never call this without one.
   */
  private async createVerifiedCustomer(input: {
    phone: string;
    first_name: string;
    last_name: string;
    email?: string;
    consents: { marketing?: boolean };
  }): Promise<AuthResult> {
    const customers = this.deps.customers;
    if (!customers) throw new Error('AuthService: customers dependency is required for signup');

    // Re-check under the proven phone: another signup may have won the race.
    if (await this.deps.users.findByPhone(input.phone)) throw new PhoneAlreadyRegisteredError();

    const systemActor = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };
    const existing = await customers.findByPhone(input.phone);
    const customer =
      existing && !existing.user_id
        ? existing // adopt an earlier attempt that never got its login
        : await customers.register(
            {
              first_name: input.first_name,
              last_name: input.last_name,
              email: input.email ?? `${input.phone}@customer.installment.local`,
              phone: input.phone,
            },
            systemActor,
          );

    // Links the customer by phone (claiming only an unlinked one) and grants
    // the customer role.
    const user = await this.deps.users.createCustomerUser(
      {
        phone: input.phone,
        name: `${input.first_name} ${input.last_name}`,
        ...(input.email ? { email: input.email } : {}),
      },
      systemActor,
    );

    // Now that the person has an identity, their consents are recorded as their
    // own act rather than the system's.
    const selfActor = { actorId: customer.id, actorType: 'customer' as const };
    await customers.recordConsent(customer.id, { type: 'data_processing' }, selfActor);
    await customers.recordConsent(customer.id, { type: 'credit_scoring' }, selfActor);
    if (input.consents.marketing) {
      await customers.recordConsent(customer.id, { type: 'marketing' }, selfActor);
    }

    await this.deps.users.recordLogin(user.id);
    return this.result(user);
  }

  async refresh(rawInput: unknown): Promise<AuthTokens> {
    const { refreshToken } = refreshSchema.parse(rawInput);
    let sub: string;
    try {
      sub = this.deps.jwt.verifyRefresh(refreshToken).sub;
    } catch {
      throw new InvalidTokenError();
    }

    const user = await this.deps.users.getById(sub).catch(() => null);
    if (!user || !user.is_active || user.deleted_at) throw new AccountInactiveError();
    return this.issueTokens(user);
  }

  private issueTokens(user: User): AuthTokens {
    const claims = { sub: user.id, user_type: user.user_type };
    return {
      accessToken: this.deps.jwt.signAccess(claims),
      refreshToken: this.deps.jwt.signRefresh(claims),
    };
  }

  private async result(user: User): Promise<AuthResult> {
    const permissions = await this.deps.users.getPermissions(user.id);
    return {
      userId: user.id,
      userType: user.user_type,
      tokens: this.issueTokens(user),
      permissions: [...permissions],
    };
  }
}
