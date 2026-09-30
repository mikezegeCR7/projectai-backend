import {
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Mirrors ResearchPlan in DATABASE.md. This slice takes the plan as
 * structured input (from the user, or a later AI Planner role) rather
 * than generating it — the AI Gateway / Planner role is a separate slice
 * per the roadmap, deliberately not wired in here.
 */
export class CreateResearchPlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  mainQuestion?: string;

  @IsOptional()
  @IsArray()
  subQuestions?: string[];

  @IsOptional()
  @IsArray()
  keywords?: string[];

  @IsOptional()
  @IsArray()
  searchConcepts?: string[];

  @IsOptional()
  @IsArray()
  sourceTypes?: string[];

  @IsOptional()
  @IsArray()
  inclusionCriteria?: string[];

  @IsOptional()
  @IsArray()
  exclusionCriteria?: string[];

  @IsOptional()
  @IsObject()
  geographicConstraints?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  dateConstraints?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  evidenceCategories?: string[];
}
