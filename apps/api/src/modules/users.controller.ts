import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { PERMISSIONS, UsersService, type User } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';
import {
  createStaffSchema,
  createMerchantUserSchema,
  createCustomerUserSchema,
  resetStaffPasswordSchema,
  setUserActiveSchema,
} from '@installment/core';
import { ApiZodBody } from '../common/api-zod';
import { ApiModel } from '../common/api-model';

/** Never expose password_hash over the wire. */
function sanitize(user: User): Omit<User, 'password_hash'> {
  const { password_hash: _omit, ...safe } = user;
  return safe;
}

/**
 * Admin user management. Creating staff/merchant/customer users and assigning
 * roles all require users:write (held by the admin role).
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('admin/users')
export class UsersController {
  // By explicit token: the test build ignores `emitDecoratorMetadata`.
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get('staff')
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @ApiOperation({ summary: 'Everyone who works the console, with their roles' })
  listStaff() {
    return this.users.listStaff();
  }

  @Get('roles')
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @ApiOperation({ summary: 'The roles staff can be given, what each allows, and who holds it' })
  listRoles() {
    return this.users.listStaffRoles();
  }

  @Post('staff')
  @ApiModel('User', { created: true })
  @ApiZodBody(createStaffSchema)
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(201)
  async createStaff(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return sanitize(await this.users.createStaff(body, actorOf(user)));
  }

  @Post('merchant')
  @ApiModel('User', { created: true })
  @ApiZodBody(createMerchantUserSchema)
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(201)
  async createMerchant(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return sanitize(await this.users.createMerchantUser(body, actorOf(user)));
  }

  @Post('customer')
  @ApiModel('User', { created: true })
  @ApiZodBody(createCustomerUserSchema)
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(201)
  async createCustomer(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return sanitize(await this.users.createCustomerUser(body, actorOf(user)));
  }

  @Post(':id/roles/:role')
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Give a login a role',
    description:
      'Staff roles go to staff logins only, and `merchant_owner` and `customer` to their own ' +
      'kinds. 409 for a mismatch, or for a change to your own roles.',
  })
  async assignRole(
    @Param('id') id: string,
    @Param('role') role: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.users.assignRole(id, role, actorOf(user));
  }

  @Delete(':id/roles/:role')
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Take a role away',
    description: "409 for your own roles, or for the last active administrator's admin role.",
  })
  async revokeRole(
    @Param('id') id: string,
    @Param('role') role: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.users.revokeRole(id, role, actorOf(user));
  }

  @Post(':id/password')
  @ApiZodBody(resetStaffPasswordSchema)
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Give a member of staff a temporary password',
    description:
      'Every session they hold stops renewing, and the account holds no permissions until its ' +
      'owner signs in with the temporary password and chooses their own. The reason is kept on ' +
      'the audit row; the password is not. 409 for your own account or a non-staff login.',
  })
  async resetPassword(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.users.resetStaffPassword(id, body, actorOf(user));
  }

  @Post(':id/deactivate')
  @ApiModel('User')
  @ApiZodBody(setUserActiveSchema)
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Switch a staff account off',
    description:
      'It can no longer sign in or refresh, and holds no permissions from its next request. ' +
      '409 for your own account or the last active administrator.',
  })
  deactivate(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.setActive(id, false, body, actorOf(user));
  }

  @Post(':id/reactivate')
  @ApiModel('User')
  @ApiZodBody(setUserActiveSchema)
  @RequirePermissions(PERMISSIONS.USERS_WRITE)
  @HttpCode(200)
  @ApiOperation({ summary: 'Switch a staff account back on' })
  reactivate(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.setActive(id, true, body, actorOf(user));
  }
}
