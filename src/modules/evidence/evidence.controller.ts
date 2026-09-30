import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { EvidenceService } from './evidence.service';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { ProjectOwnershipGuard } from '../../common/guards/project-ownership.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

@Controller('api/v1')
@UseGuards(SessionAuthGuard)
export class EvidenceController {
  constructor(private readonly evidenceService: EvidenceService) {}

  @Get('projects/:projectId/evidence')
  @UseGuards(ProjectOwnershipGuard)
  listForProject(@Param('projectId') projectId: string) {
    return this.evidenceService.listForProject(projectId);
  }

  @Get('evidence/:evidenceId')
  get(
    @Param('evidenceId') evidenceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.evidenceService.getOwned(user.id, evidenceId);
  }
}