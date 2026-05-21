import jwt from 'jsonwebtoken';

export type TokenType = 'access' | 'refresh';

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

/** HS256 access/refresh token signer & verifier. */
export class JwtService {
  private readonly accessTtl: number;
  private readonly refreshTtl: number;

  constructor(private readonly opts: JwtOptions) {
    if (!opts.accessSecret || !opts.refreshSecret) {
      throw new Error('JwtService: accessSecret and refreshSecret are required');
    }
    this.accessTtl = opts.accessTtlSeconds ?? DEFAULT_ACCESS_TTL;
    this.refreshTtl = opts.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL;
  }

  signAccess(claims: SignClaims): string {
    return this.sign({ ...claims, type: 'access' }, this.opts.accessSecret, this.accessTtl);
  }

  signRefresh(claims: SignClaims): string {
    return this.sign({ ...claims, type: 'refresh' }, this.opts.refreshSecret, this.refreshTtl);
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
