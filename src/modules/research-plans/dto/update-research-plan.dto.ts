import { IsIn, IsOptional } from 'class-validator';
import { CreateResearchPlanDto } from './create-research-plan.dto';

const PLAN_STATUSES = ['DRAFT', 'READY', 'ARCHIVED'] as const;

export class UpdateResearchPlanDto extends CreateResearchPlanDto {
  @IsOptional()
  @IsIn(PLAN_STATUSES)
  status?: (typeof PLAN_STATUSES)[number];
}
