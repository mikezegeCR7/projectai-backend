import { Type } from 'class-transformer';
import {
  IsArray,
  IsDate,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Fields mirror ProjectRequirement in DATABASE.md / the "Research Brief"
 * in PRD.md §5. PRD.md is explicit that the user should not be forced to
 * supply all of these up front ("ask for missing information only when
 * necessary") — so only `topic` is required here; everything else is
 * optional and can be filled in across multiple PUTs as the brief is
 * refined. `researchQuestions` and `additionalRequirements` are free-form
 * JSON per the schema, not modeled further at this layer.
 */
export class SaveRequirementsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  topic!: string;

  @IsOptional()
  @IsArray()
  researchQuestions?: unknown[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  researchArea?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  population?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  geographicFocus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  academicLevel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  discipline?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  deliverableType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  citationStyle?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  wordCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  pageCount?: number;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  deadline?: Date;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  institution?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  department?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  researchStartDate?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  researchEndDate?: Date;

  @IsOptional()
  @IsObject()
  additionalRequirements?: Record<string, unknown>;
}
