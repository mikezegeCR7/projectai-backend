import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ProjectStatus } from '@prisma/client';

export class ListProjectsQuery {
  /** Opaque cursor: the id of the last project seen on the previous page. */
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @IsEnum(ProjectStatus)
  status?: ProjectStatus;
}
