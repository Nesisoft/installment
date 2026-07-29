import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from '@installment/core';
import type { AuthenticatedUser } from './decorators';

/**
 * Resolves the caller's own merchant for the /merchant portal and rejects
 * anyone who isn't a merchant linked to one. Runs after the global JwtAuthGuard
 * (which sets req.user); attaches req.merchantId for @CurrentMerchantId().
 *
 * Tenant isolation: portal controllers must only ever use this merchantId (and
 * verify resource ownership against it), never an id from the request path.
 */
@Injectable()
export class MerchantScopeGuard implements CanActivate {
  constructor(private readonly users: UsersService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser; merchantId?: string }>();
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    if (user.userType !== 'merchant') throw new ForbiddenException('Merchant access only');

    const merchantId = await this.users.getMerchantScope(user.id);
    if (!merchantId) throw new ForbiddenException('No merchant is linked to this account');

    req.merchantId = merchantId;
    return true;
  }
}
