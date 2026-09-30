import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ResearchConflictsService } from './research-conflicts.service';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { ProjectOwnershipGuard } from '../../common/guards/project-ownership.guard';

@Controller('api/v1')
@UseGuards(SessionAuthGuard)
export class ResearchConflictsController {
  constructor(
    private readonly researchConflictsService: ResearchConflictsService,
  ) {}

  @Get('projects/:projectId/research-conflicts')
  @UseGuards(ProjectOwnershipGuard)
  listForProject(@Param('projectId') projectId: string) {
    return this.researchConflictsService.listForProject(projectId);
  }
}