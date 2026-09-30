import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './infrastructure/database/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { RequirementsModule } from './modules/requirements/requirements.module';
import { ResearchPlansModule } from './modules/research-plans/research-plans.module';
import { ResearchRunsModule } from './modules/research-runs/research-runs.module';
import { SourcesModule } from './modules/sources/sources.module';
import { EvidenceModule } from './modules/evidence/evidence.module';
import { ClaimsModule } from './modules/claims/claims.module';
import { ResearchGapsModule } from './modules/research-gaps/research-gaps.module';
import { ResearchConflictsModule } from './modules/research-conflicts/research-conflicts.module';

// Slice 3 adds evidence (populated by the pipeline — see
// ResearchRunProcessor.extractEvidence), plus read-only claims/
// research-gaps/research-conflicts layers that stay empty until the AI
// Gateway slice actually writes to them. Writing, citations, review,
// files, exports, subscriptions, usage and notifications are still not
// implemented — see README.md.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    ProjectsModule,
    RequirementsModule,
    ResearchPlansModule,
    ResearchRunsModule,
    SourcesModule,
    EvidenceModule,
    ClaimsModule,
    ResearchGapsModule,
    ResearchConflictsModule,
  ],
})
export class AppModule {}