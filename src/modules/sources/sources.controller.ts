import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { SourcesService } from './sources.service';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { ProjectOwnershipGuard } from '../../common/guards/project-ownership.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

@Controller('api/v1')
@UseGuards(SessionAuthGuard)
export class SourcesController {
  constructor(private readonly sourcesService: SourcesService) {}

  @Get('projects/:projectId/sources')
  @UseGuards(ProjectOwnershipGuard)
  listForProject(@Param('projectId') projectId: string) {
    return this.sourcesService.listForProject(projectId);
  }

  @Get('sources/:sourceId')
  get(
    @Param('sourceId') sourceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sourcesService.getOwned(user.id, sourceId);
  }
}
