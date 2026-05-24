import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { PERMISSIONS, ScoringService } from '@installment/core';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermissions, type AuthenticatedUser } from '../auth/decorators';
import { actorOf } from '../auth/current-actor';

@ApiTags('scoring')
@ApiBearerAuth()
@Controller('admin/applications/:id')
export class ScoringController {
  constructor(private readonly scoring: ScoringService) {}

  @Post('score')
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  @HttpCode(200)
  @ApiOperation({ summary: 'Score an application, persist the decision, and transition it' })
  score(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.scoring.scoreApplication(id, actorOf(user));
  }

  @Post('score/dry-run')
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  @HttpCode(200)
  @ApiOperation({ summary: 'Score an application against the live signals without persisting' })
  dryRun(@Param('id') id: string) {
    return this.scoring.dryRun(id);
  }

  @Get('decision')
  @RequirePermissions(PERMISSIONS.APPLICATIONS_REVIEW)
  @ApiOperation({ summary: 'View the latest scoring decision with its full rule breakdown' })
  decision(@Param('id') id: string) {
    return this.scoring.latestDecision(id);
  }
}
