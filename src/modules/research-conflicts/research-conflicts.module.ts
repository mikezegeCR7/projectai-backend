import { Module } from '@nestjs/common';
import { ResearchConflictsController } from './research-conflicts.controller';
import { ResearchConflictsService } from './research-conflicts.service';
import { ProjectsModule } from '../projects/projects.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, ProjectsModule],
  controllers: [ResearchConflictsController],
  providers: [ResearchConflictsService],
})
export class ResearchConflictsModule {}