import { IsString } from 'class-validator';

export class CreateResearchRunDto {
  @IsString()
  researchPlanId!: string;
}
