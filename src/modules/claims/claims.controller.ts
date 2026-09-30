import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ClaimsService } from './claims.service';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { ProjectOwnershipGuard } from '../../common/guards/project-ownership.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

@Controller('api/v1')
@UseGuards(SessionAuthGuard)
export class ClaimsController {
  constructor(private readonly claimsService: ClaimsService) {}

  @Get('projects/:projectId/claims')
  @UseGuards(ProjectOwnershipGuard)
  listForProject(@Param('projectId') projectId: string) {
    return this.claimsService.listForProject(projectId);
  }

  @Get('claims/:claimId')
  get(
    @Param('claimId') claimId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.claimsService.getOwned(user.id, claimId);
  }
}