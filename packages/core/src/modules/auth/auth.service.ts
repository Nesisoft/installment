import { PasswordService } from '../../shared/auth/password.service';
import { JwtService } from '../../shared/auth/jwt.service';
import { OtpService } from '../../shared/auth/otp.service';
import { UsersService, type User } from '../users/users.service';
import { UserNotFoundError } from '../users/errors';
import { loginSchema, otpStartSchema, otpVerifySchema, refreshSchema } from './dto';
import {
  AccountInactiveError,
  InvalidCredentialsError,
  InvalidOtpError,
  InvalidTokenError,
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
}

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
