import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { PERMISSIONS, UsersService, type User } from '@installment/core';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';

/** Never expose password_hash over the wire. */
function sanitize(user: User): Omit<User, 'password_hash'> {
  const { password_hash: _omit, ...safe } = user;
  return safe;
}

/**
 * Admin user management. Creating staff/merchant/customer users and assigning
 * roles all require users:write (held by the admin role).
 */
@Controller('admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post('staff')
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(201)
  async createStaff(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return sanitize(await this.users.createStaff(body, actorOf(user)));
  }

  @Post('merchant')
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(201)
  async createMerchant(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return sanitize(await this.users.createMerchantUser(body, actorOf(user)));
  }

  @Post('customer')
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(201)
  async createCustomer(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return sanitize(await this.users.createCustomerUser(body, actorOf(user)));
  }

  @Post(':id/roles/:role')
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(204)
  async assignRole(
    @Param('id') id: string,
    @Param('role') role: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.users.assignRole(id, role, actorOf(user));
  }
}
