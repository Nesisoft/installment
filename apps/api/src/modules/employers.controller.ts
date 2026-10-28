import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { CustomerEmploymentService, EmployersService, PERMISSIONS } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf, numOrUndefined } from '../auth/current-actor';
import {
  createEmployerSchema,
  updateEmployerSchema,
  transitionEmployerSchema,
  linkEmploymentSchema,
  transitionEmploymentSchema,
  recordPayrollConsentSchema,
  unverifyEmploymentSchema,
  verifyEmploymentSchema,
} from '@installment/core';
import { ApiZodBody } from '../common/api-zod';
import { ApiModel } from '../common/api-model';

@ApiTags('employers')
@ApiBearerAuth()
@Controller('admin/employers')
export class EmployersController {
  // By explicit token: the test build ignores `emitDecoratorMetadata`.
  constructor(
    @Inject(EmployersService) private readonly employers: EmployersService,
    @Inject(CustomerEmploymentService) private readonly employment: CustomerEmploymentService,
  ) {}

  @Post()
  @ApiModel('Employer', { created: true })
  @ApiZodBody(createEmployerSchema)
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  @HttpCode(201)
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.employers.create(body, actorOf(user));
  }

  @Get()
  @ApiModel('Employer', { array: true })
  @RequirePermissions(PERMISSIONS.EMPLOYERS_READ)
  list(@Query() query: Record<string, string>) {
    return this.employers.list({
      status: query.status,
      limit: numOrUndefined(query.limit),
      offset: numOrUndefined(query.offset),
    });
  }

  // `summary`, `counts` and `employment` are declared before `:id`, which would
  // otherwise take them as employer ids.
  @Get('summary')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_READ)
  @ApiOperation({
    summary: 'Employers with how many of their staff are linked, verified and consenting',
    description: 'Filter by `status` or `q` (part of the name). Answers `{ rows, total }`.',
  })
  summary(@Query() query: Record<string, string>) {
    return this.employers.listForConsole(query);
  }

  @Get('counts')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_READ)
  @ApiOperation({ summary: 'How many employers are in each status' })
  counts() {
    return this.employers.counts();
  }

  @Get('employment')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_READ)
  @ApiOperation({
    summary: 'Employment links with the customer and employer named',
    description:
      'Filter by `customer_id`, `employer_id`, `status` or `verified=true|false`. With ' +
      '`verified=false` the oldest come first — the verification queue. Answers `{ rows, total }`.',
  })
  listEmploymentForConsole(@Query() query: Record<string, string>) {
    return this.employment.listForConsole(query);
  }

  @Get(':id')
  @ApiModel('Employer')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_READ)
  get(@Param('id') id: string) {
    return this.employers.get(id);
  }

  @Patch(':id')
  @ApiModel('Employer')
  @ApiZodBody(updateEmployerSchema)
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  update(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.employers.update(id, body, actorOf(user));
  }

  @Post(':id/transition')
  @ApiModel('Employer')
  @ApiZodBody(transitionEmployerSchema)
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
  @ApiModel('Employment', { created: true })
  @ApiZodBody(linkEmploymentSchema)
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  @HttpCode(201)
  link(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.employment.link(body, actorOf(user));
  }

  @Get('employment/list')
  @ApiModel('Employment', { array: true })
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
  @ApiModel('Employment')
  @RequirePermissions(PERMISSIONS.EMPLOYERS_READ)
  getEmployment(@Param('id') id: string) {
    return this.employment.get(id);
  }

  @Post('employment/:id/transition')
  @ApiModel('Employment')
  @ApiZodBody(transitionEmploymentSchema)
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
  @ApiModel('Employment')
  @ApiZodBody(recordPayrollConsentSchema)
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  @HttpCode(200)
  consent(@Param('id') id: string, @Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.employment.recordPayrollConsent(id, body, actorOf(user));
  }

  @Post('employment/:id/verify')
  @ApiModel('Employment')
  @ApiZodBody(verifyEmploymentSchema)
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirm the customer holds this job, saying how',
    description:
      'Raises a first-time customer to the employer tier of the starter limit. 409 if the ' +
      'customer no longer holds the job, or the employer partnership has ended.',
  })
  verifyEmployment(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employment.markVerified(id, body, actorOf(user));
  }

  @Post('employment/:id/unverify')
  @ApiModel('Employment')
  @ApiZodBody(unverifyEmploymentSchema)
  @RequirePermissions(PERMISSIONS.EMPLOYERS_WRITE)
  @HttpCode(200)
  @ApiOperation({ summary: 'Withdraw a verification that turned out to be wrong' })
  unverifyEmployment(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.employment.unverify(id, body, actorOf(user));
  }
}
