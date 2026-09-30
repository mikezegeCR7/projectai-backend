import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { RequirementsService } from './requirements.service';
import { SaveRequirementsDto } from './dto/save-requirements.dto';
import { SessionAuthGuard } from '../../common/guards/session-auth.guard';
import { ProjectOwnershipGuard } from '../../common/guards/project-ownership.guard';

@Controller('api/v1/projects/:projectId/requirements')
@UseGuards(SessionAuthGuard, ProjectOwnershipGuard)
export class RequirementsController {
  constructor(private readonly requirementsService: RequirementsService) {}

  @Put()
  save(
    @Param('projectId') projectId: string,
    @Body() dto: SaveRequirementsDto,
  ) {
    return this.requirementsService.save(projectId, dto);
  }

  @Get()
  get(@Param('projectId') projectId: string) {
    return this.requirementsService.get(projectId);
  }
}
