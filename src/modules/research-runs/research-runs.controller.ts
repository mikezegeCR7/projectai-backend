import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ResearchRunsService } from './research-runs.service';
import { CreateResearchRunDto } from './dto/create-research-run.dto';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { ProjectOwnershipGuard } from '../../common/guards/project-ownership.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.service';

@Controller('api/v1')
@UseGuards(SessionAuthGuard)
export class ResearchRunsController {
  constructor(private readonly researchRunsService: ResearchRunsService) {}

  @Post('projects/:projectId/research-runs')
  @UseGuards(ProjectOwnershipGuard)
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('projectId') projectId: string,
    @Body() dto: CreateResearchRunDto,
  ) {
    return this.researchRunsService.create(projectId, dto);
  }

  @Get('research-runs/:researchRunId')
  get(
    @Param('researchRunId') researchRunId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.researchRunsService.getOwned(user.id, researchRunId);
  }

  @Get('research-runs/:researchRunId/events')
  listEvents(
    @Param('researchRunId') researchRunId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.researchRunsService.listEvents(user.id, researchRunId);
  }

  @Post('research-runs/:researchRunId/cancel')
  cancel(
    @Param('researchRunId') researchRunId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.researchRunsService.cancel(user.id, researchRunId);
  }
}
