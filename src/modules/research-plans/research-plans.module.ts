import { Module } from '@nestjs/common';
import { ResearchPlansController } from './research-plans.controller';
import { ResearchPlansService } from './research-plans.service';
import { ProjectsModule } from '../projects/projects.module';
import { AuthModule } from '../auth/auth.module';
import { RequirementsModule } from '../requirements/requirements.module';
import { AiModule } from '../../infrastructure/ai/ai.module';

@Module({
  imports: [AuthModule, ProjectsModule, RequirementsModule, AiModule],
  controllers: [ResearchPlansController],
  providers: [ResearchPlansService],
  exports: [ResearchPlansService],
})
export class ResearchPlansModule {}