import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CustomerEmploymentService, EmployersService, PERMISSIONS } from '@installment/core';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf, numOrUndefined } from '../auth/current-actor';

@Controller('admin/employers')
export class EmployersController {
  constructor(
    private readonly employers: EmployersService,
    private readonly employment: CustomerEmploymentService,
  ) {}

  @Post()
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.employers.create(body, actorOf(user));
  }

  @Get()
  @RequirePermissions(PERMISSIONS.EMPLOYERS_READ)
  list(@Query() query: Record<string, string>) {
    return this.employers.list({
      status: query.status,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_READ)
  get(@Param('id') id: string) {
    return this.employers.get(id);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.employers.update(id, body, actorOf(user));
  }

  @Post(':id/transition')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  @HttpCode(200)
  transition(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employers.transition(id, body, actorOf(user));
  }

  // ---- employment links ----

  @Post('employment')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  @HttpCode(201)
  link(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.employment.link(body, actorOf(user));
  }

  @Get('employment/list')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_READ)
  listEmployment(@Query() query: Record<string, string>) {
    return this.employment.list({
      customer_id: query.customer_id,
      employer_id: query.employer_id,
      status: query.status,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  @Get('employment/:id')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_READ)
  getEmployment(@Param('id') id: string) {
    return this.employment.get(id);
  }

  @Post('employment/:id/transition')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  @HttpCode(200)
  transitionEmployment(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employment.transition(id, body, actorOf(user));
  }

  @Post('employment/:id/consent')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  @HttpCode(200)
  consent(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.employment.recordPayrollConsent(id, body, actorOf(user));
  }

  @Post('employment/:id/verify')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  @HttpCode(200)
  verifyEmployment(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.employment.markVerified(id, actorOf(user));
  }
}
