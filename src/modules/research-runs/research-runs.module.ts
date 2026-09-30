import { Module } from '@nestjs/common';
import { ResearchRunsController } from './research-runs.controller';
import { ResearchRunsService } from './research-runs.service';
import { ResearchRunProcessor } from './processors/research-run.processor';
import { ProjectsModule } from '../projects/projects.module';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { SearchModule } from '../../infrastructure/search/search.module';
import { ContentModule } from '../../infrastructure/content/content.module';
import { AiModule } from '../../infrastructure/ai/ai.module';

@Module({
  imports: [AuthModule, ProjectsModule, QueueModule, SearchModule, ContentModule, AiModule],
  controllers: [ResearchRunsController],
  providers: [ResearchRunsService, ResearchRunProcessor],
})
export class ResearchRunsModule {}