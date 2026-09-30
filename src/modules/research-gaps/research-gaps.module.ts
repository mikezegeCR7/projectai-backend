import { Module } from '@nestjs/common';
import { ResearchGapsController } from './research-gaps.controller';
import { ResearchGapsService } from './research-gaps.service';
import { ProjectsModule } from '../projects/projects.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule, ProjectsModule],
  controllers: [ResearchGapsController],
  providers: [ResearchGapsService],
})
export class ResearchGapsModule {}