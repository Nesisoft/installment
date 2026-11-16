import jwt from 'jsonwebtoken';

/**
 * `signup` is not a session token. It proves one thing — that this phone
 * answered an OTP — so the registration form can be shown before the account
 * exists. It carries no user id, because there is no user yet.
 */
export type TokenType = 'access' | 'refresh' | 'signup';

export interface JwtClaims {
  /** Subject — the user id. */
  sub: string;
  type: TokenType;
  /** User kind, for coarse routing/guards. */
  user_type?: string;
  [key: string]: unknown;
}

/** Claims a caller supplies when signing (the service stamps `type`). */
export interface SignClaims {
  sub: string;
  user_type?: string;
  [key: string]: unknown;
}

export interface JwtOptions {
  accessSecret: string;
  refreshSecret: string;
  /** Access token lifetime in seconds. Default 15 min. */
  accessTtlSeconds?: number;
  /** Refresh token lifetime in seconds. Default 30 days. */
  refreshTtlSeconds?: number;
  /**
   * Signup-ticket lifetime in seconds. Default 15 min — long enough to fill in
   * a registration form without rushing, short enough that a leaked ticket is
   * not a standing right to claim the number.
   */
  signupTtlSeconds?: number;
  issuer?: string;
  audience?: string;
}

export class JwtInvalidError extends Error {
  constructor(message = 'Invalid token') {
    super(message);
    this.name = 'JwtInvalidError';
  }
}

export class JwtExpiredError extends Error {
  constructor() {
    super('Token expired');
    this.name = 'JwtExpiredError';
  }
}

const DEFAULT_ACCESS_TTL = 15 * 60;
const DEFAULT_REFRESH_TTL = 30 * 24 * 60 * 60;
const DEFAULT_SIGNUP_TTL = 15 * 60;

/** HS256 access/refresh token signer & verifier. */
/**
 * Which flow a phone ticket belongs to. `merchant-reset` proves a seller's
 * phone for a password reset; it cannot open a shop, and a signup ticket
 * cannot reset a password.
 */
export type SignupScope = 'customer' | 'merchant' | 'merchant-reset';

export class JwtService {
  private readonly accessTtl: number;
  private readonly refreshTtl: number;
  private readonly signupTtl: number;

  constructor(private readonly opts: JwtOptions) {
    if (!opts.accessSecret || !opts.refreshSecret) {
      throw new Error('JwtService: accessSecret and refreshSecret are required');
    }
    this.accessTtl = opts.accessTtlSeconds ?? DEFAULT_ACCESS_TTL;
    this.refreshTtl = opts.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL;
    this.signupTtl = opts.signupTtlSeconds ?? DEFAULT_SIGNUP_TTL;
  }

  signAccess(claims: SignClaims): string {
    return this.sign({ ...claims, type: 'access' }, this.opts.accessSecret, this.accessTtl);
  }

  signRefresh(claims: SignClaims): string {
    return this.sign({ ...claims, type: 'refresh' }, this.opts.refreshSecret, this.refreshTtl);
  }

  /**
   * Ticket proving a phone passed OTP verification. `sub` is the phone, not a
   * user id. Signed with the ACCESS secret but stamped `type: 'signup'`, so
   * verifyAccess rejects it — it can never be presented as a session.
   */
  /**
   * A ticket saying "this phone has been proven", for the last step of signup.
   *
   * Scoped, because there is more than one kind of signup now. Without it a
   * ticket minted by the customer flow would be accepted by the merchant flow
   * and the other way round: same `type: 'signup'`, same secret, same subject.
   * The holder owns that phone either way, so it is confusion rather than
   * escalation — but "the two flows cannot be crossed" is worth being true
   * rather than worth arguing about.
   *
   * Defaults to `customer` on both sides so tickets already in flight, and
   * callers that never knew about scopes, keep working.
   */
  signSignup(phone: string, scope: SignupScope = 'customer'): string {
    return this.sign({ sub: phone, type: 'signup', scope }, this.opts.accessSecret, this.signupTtl);
  }

  /** Returns the verified phone, or throws — including on the wrong scope. */
  verifySignup(token: string, scope: SignupScope = 'customer'): string {
    const claims = this.verify<JwtClaims & { scope?: SignupScope }>(
      token,
      this.opts.accessSecret,
      'signup',
    );
    if ((claims.scope ?? 'customer') !== scope) {
      throw new Error(`signup token is for ${claims.scope ?? 'customer'}, not ${scope}`);
    }
    return claims.sub;
  }

  verifyAccess<T extends JwtClaims = JwtClaims>(token: string): T {
    return this.verify<T>(token, this.opts.accessSecret, 'access');
  }

  verifyRefresh<T extends JwtClaims = JwtClaims>(token: string): T {
    return this.verify<T>(token, this.opts.refreshSecret, 'refresh');
  }

  private sign(payload: SignClaims & { type: TokenType }, secret: string, ttl: number): string {
    return jwt.sign(payload, secret, {
      algorithm: 'HS256',
      expiresIn: ttl,
      ...(this.opts.issuer ? { issuer: this.opts.issuer } : {}),
      ...(this.opts.audience ? { audience: this.opts.audience } : {}),
    });
  }

  private verify<T extends JwtClaims>(token: string, secret: string, expected: TokenType): T {
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        ...(this.opts.issuer ? { issuer: this.opts.issuer } : {}),
        ...(this.opts.audience ? { audience: this.opts.audience } : {}),
      });
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw new JwtExpiredError();
      throw new JwtInvalidError(err instanceof Error ? err.message : undefined);
    }
    const claims = decoded as T;
    if (claims.type !== expected) {
      throw new JwtInvalidError(`Expected a ${expected} token but got "${claims.type}"`);
    }
    return claims;
  }
}
