import { PasswordService } from '../../shared/auth/password.service';
import { JwtService } from '../../shared/auth/jwt.service';
import { OtpService } from '../../shared/auth/otp.service';
import { UsersService, type User } from '../users/users.service';
import { UserNotFoundError } from '../users/errors';
import { CustomersService } from '../customers/customers.service';
import { MerchantsService } from '../merchants/merchants.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { type GhanaRegion, type MomoProviderCode } from '../../shared/validators/ghana';
import {
  loginSchema,
  otpStartSchema,
  otpVerifySchema,
  refreshSchema,
  signupStartSchema,
  signupVerifySchema,
  signupVerifyCodeSchema,
  signupCompleteSchema,
  merchantSignupStartSchema,
  merchantSignupVerifyCodeSchema,
  merchantSignupCompleteSchema,
} from './dto';
import {
  AccountInactiveError,
  InvalidCredentialsError,
  InvalidOtpError,
  InvalidTokenError,
  PhoneAlreadyRegisteredError,
  EmailAlreadyRegisteredError,
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
  /** Required for merchant self-signup; without it the merchant methods refuse. */
  merchants?: MerchantsService;
  /**
   * Gives a newly signed-up merchant their shopfront.
   *
   * A callback rather than a StoresService, because stores live in
   * `@installment/commerce`, which depends on core — taking the service
   * directly would invert that. The API wires it; core never learns what a
   * store is beyond "somebody else provisions one".
   *
   * Called after the merchant and its login exist, in its own transaction, so a
   * failure here leaves a merchant with no shopfront rather than no account.
   * That state is recoverable and visible: the portal answers "no store has
   * been created for this merchant yet", and an admin reviews every signup
   * before it can trade anyway.
   */
  provisionStore?: (input: {
    merchantId: string;
    shopName: string;
    categorySlug?: string;
    city?: string;
    region?: GhanaRegion;
  }) => Promise<void>;
  /**
   * Refuses a shop category that does not exist, before anything is written.
   *
   * Separate from `provisionStore` and called first, because that one runs
   * after the merchant and its login are committed: a bad slug there would cost
   * somebody an account they then cannot re-register with. Commerce owns what a
   * valid shop category is; core only asks.
   */
  assertShopCategory?: (slug: string) => Promise<void>;
  /**
   * Turns the MoMo number a merchant gave at signup into a real payout
   * destination.
   *
   * A callback for the same reason as `provisionStore`, and one more: it is the
   * only thing in signup that talks to a payment provider, and taking
   * `PayoutAccountService` directly would make every AuthService fixture grow a
   * Paystack stub.
   *
   * Called after the account exists and allowed to fail. A merchant who mistyped
   * a digit, or a provider having a bad afternoon, must not cost somebody their
   * shop — and the failure is visible and recoverable: the payout-account screen
   * says "not connected" and the settlement run skips them until it is.
   */
  setMobileMoneyPayout?: (input: {
    merchantId: string;
    momoNumber: string;
    momoProvider: MomoProviderCode;
  }) => Promise<void>;
}

/** Signup codes live in their own keyspace so a login code cannot create an account. */
const signupTarget = (phone: string): string => `signup:${phone}`;

/**
 * And merchant signup codes in their own again, so a code sent to open a
 * shopper account cannot be burned to register a business on the same number.
 */
const merchantSignupTarget = (phone: string): string => `merchant-signup:${phone}`;

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
      date_of_birth: input.date_of_birth,
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

  // --- Merchant self-signup -------------------------------------------------
  //
  // The same three steps as the customer flow, on the same OTP machinery: a
  // Ghanaian trader has a phone, and this system has no email delivery. The
  // phone proves a person is behind the account before any row is written;
  // email and password are what they log in with afterwards.
  //
  // Everything created here is inert. The merchant lands `pending_kyc` and the
  // shopfront `draft`, so a merchant can do all their own setup — branding,
  // products, photos, stock — and none of it is visible or purchasable until an
  // admin activates them. Since #61 that is enforced on both the storefront and
  // checkout, which is what makes self-signup safe to open at all.

  /**
   * Step 1: send a code. Refuses a phone that already backs a merchant.
   *
   * `merchants.findByPhone`, not `users.findByPhone`: a merchant's phone lives
   * on the merchant row and never on their `users` row, because merchants log
   * in with email and password and `createMerchantUser` takes no phone. The
   * users lookup looked right, sent the SMS, let the applicant fill in the
   * whole form, and only failed at the last step on `merchants_phone_key`.
   *
   * Scoped to merchants on purpose: a shopper who decides to open a shop should
   * not be turned away for already buying here on that number.
   */
  async merchantSignupStart(rawInput: unknown): Promise<{ expiresAt: Date }> {
    const { phone } = merchantSignupStartSchema.parse(rawInput);
    const merchants = this.deps.merchants;
    if (!merchants) {
      throw new Error('AuthService: merchants dependency is required for merchant signup');
    }
    if (await merchants.findByPhone(phone)) throw new PhoneAlreadyRegisteredError();

    const { code, expiresAt } = await this.deps.otp.start(merchantSignupTarget(phone));
    if (this.deps.sms) {
      await this.deps.sms.send({
        to: phone,
        sender: this.deps.smsSenderId ?? 'Installmt',
        message: (this.deps.otpMessage ?? defaultOtpMessage)(code),
      });
    }
    return { expiresAt };
  }

  /** Step 2: prove the code, before the business form is shown. */
  async merchantSignupVerifyCode(rawInput: unknown): Promise<{ signupToken: string }> {
    const input = merchantSignupVerifyCodeSchema.parse(rawInput);
    if (await this.deps.merchants?.findByPhone(input.phone)) {
      throw new PhoneAlreadyRegisteredError();
    }

    const ok = await this.deps.otp.verify(merchantSignupTarget(input.phone), input.code);
    if (!ok) throw new InvalidOtpError();

    return { signupToken: this.deps.jwt.signSignup(input.phone, 'merchant') };
  }

  /**
   * Step 3: the ticket plus the business — the call that creates the merchant,
   * its login and its shopfront.
   *
   * The phone comes from the ticket, never from the body, so a caller cannot
   * verify one number and register another. The ticket is scoped, so one minted
   * by the customer flow is refused here.
   */
  async merchantSignupComplete(rawInput: unknown): Promise<AuthResult> {
    const input = merchantSignupCompleteSchema.parse(rawInput);
    const merchants = this.deps.merchants;
    if (!merchants) {
      throw new Error('AuthService: merchants dependency is required for merchant signup');
    }

    let phone: string;
    try {
      phone = this.deps.jwt.verifySignup(input.signupToken, 'merchant');
    } catch {
      throw new InvalidTokenError();
    }

    // Re-check under the proven phone and the claimed email: another signup may
    // have won the race between step 2 and step 3. The email is checked against
    // logins, because that is what a merchant signs in with and `users.email`
    // is unique across every actor class.
    if (await merchants.findByPhone(phone)) throw new PhoneAlreadyRegisteredError();
    if (await this.deps.users.findByEmail(input.email)) throw new EmailAlreadyRegisteredError();

    // Before the first write, for the reason on the dep itself.
    if (input.primary_category_slug && this.deps.assertShopCategory) {
      await this.deps.assertShopCategory(input.primary_category_slug);
    }

    const systemActor = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

    // No commercial terms in the input, so the platform's defaults apply. A
    // merchant naming their own take-rate at signup would be the business model
    // handed over in a request body.
    const merchant = await merchants.create(
      {
        business_name: input.business_name,
        legal_name: input.legal_name,
        email: input.email,
        phone,
        ...(input.tin ? { tin: input.tin } : {}),
        ...(input.registration_number ? { registration_number: input.registration_number } : {}),
      },
      systemActor,
    );

    const user = await this.deps.users.createMerchantUser(
      {
        email: input.email,
        name: input.business_name,
        password: input.password,
        merchant_id: merchant.id,
      },
      systemActor,
    );

    if (this.deps.provisionStore) {
      await this.deps.provisionStore({
        merchantId: merchant.id,
        shopName: input.business_name,
        categorySlug: input.primary_category_slug,
        city: input.city,
        region: input.region,
      });
    }

    // Last, and swallowed. Everything above is this person's account; this is a
    // convenience that saves them a trip to the payout screen, and it reaches a
    // third party over the network to do it. A merchant with a shop and no
    // payout account is a state the portal already explains and already lets
    // them fix. A merchant with no shop because Paystack timed out is not.
    if (this.deps.setMobileMoneyPayout && input.momo_number && input.momo_provider) {
      try {
        await this.deps.setMobileMoneyPayout({
          merchantId: merchant.id,
          momoNumber: input.momo_number,
          momoProvider: input.momo_provider,
        });
      } catch {
        // Nothing was written: `set` resolves and creates the recipient before
        // it touches the row, so a failure here leaves the bank columns null
        // rather than holding an unverified number that looks like a
        // destination.
      }
    }

    await this.deps.users.recordLogin(user.id);
    return this.result(user);
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
    /**
     * Required on the way in, because `gate.age_range` is a hard gate that
     * declines an unknown age and this column is the only thing it reads.
     */
    date_of_birth: string;
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
              date_of_birth: input.date_of_birth,
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
