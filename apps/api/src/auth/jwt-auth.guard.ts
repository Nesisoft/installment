import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@installment/core';
import { PUBLIC_KEY, type AuthenticatedUser } from './decorators';

/** Verifies the Bearer access token and attaches `req.user`. Honors @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: AuthenticatedUser;
    }>();
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    try {
      const claims = this.jwt.verifyAccess(header.slice('Bearer '.length));
      req.user = { id: claims.sub, userType: String(claims.user_type ?? '') };
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
