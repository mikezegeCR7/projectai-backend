import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ResearchGapsService } from './research-gaps.service';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { ProjectOwnershipGuard } from '../../common/guards/project-ownership.guard';

@Controller('api/v1')
@UseGuards(SessionAuthGuard)
export class ResearchGapsController {
  constructor(private readonly researchGapsService: ResearchGapsService) {}

  @Get('projects/:projectId/research-gaps')
  @UseGuards(ProjectOwnershipGuard)
  listForProject(@Param('projectId') projectId: string) {
    return this.researchGapsService.listForProject(projectId);
  }
}