import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';

export const PUBLIC_KEY = 'isPublic';
/** Marks a route as not requiring authentication (skips the global JWT guard). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

export const PERMISSIONS_KEY = 'requiredPermissions';
/** Require the caller to hold every listed permission (checked by PermissionsGuard). */
export const RequirePermissions = (...permissions: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(PERMISSIONS_KEY, permissions);

export interface AuthenticatedUser {
  id: string;
  userType: string;
}

/** Injects the authenticated user attached to the request by JwtAuthGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser | undefined => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    return req.user;
  },
);

/** Injects the merchant id resolved by MerchantScopeGuard for the current caller. */
export const CurrentMerchantId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest<{ merchantId?: string }>();
    return req.merchantId;
  },
);
