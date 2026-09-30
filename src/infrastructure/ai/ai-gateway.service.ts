import { Injectable, Logger } from '@nestjs/common';
import { GeminiProvider } from './providers/gemini.provider';
import { AiProvider } from './ai-provider.interface';
import {
  PLANNER_RESPONSE_SCHEMA,
  PLANNER_SYSTEM_PROMPT,
  PlannerInput,
  PlannerOutput,
  buildPlannerUserPrompt,
  isPlannerOutput,
} from './roles/planner.role';
import {
  EVIDENCE_ANALYST_RESPONSE_SCHEMA,
  EVIDENCE_ANALYST_SYSTEM_PROMPT,
  EvidenceAnalystInput,
  EvidenceAnalystItem,
  buildEvidenceAnalystUserPrompt,
  isEvidenceAnalystOutput,
} from './roles/evidence-analyst.role';
import {
  RESEARCH_ANALYST_RESPONSE_SCHEMA,
  RESEARCH_ANALYST_SYSTEM_PROMPT,
  ResearchAnalystInput,
  ResearchAnalystOutput,
  buildResearchAnalystUserPrompt,
  isResearchAnalystOutput,
} from './roles/research-analyst.role';
import {
  CLAIM_GROUNDING_CHECK_RESPONSE_SCHEMA,
  CLAIM_GROUNDING_CHECK_SYSTEM_PROMPT,
  ClaimGroundingCheckInput,
  ClaimGroundingCheckOutput,
  buildClaimGroundingCheckUserPrompt,
  isClaimGroundingCheckOutput,
} from './roles/claim-grounding-check.role';

/**
 * The only class anything outside infrastructure/ai/ should import.
 * Domain/pipeline code calls planResearch(...) etc. — it never sees
 * GeminiProvider, prompts, or provider-specific response shapes. Adding
 * Anthropic later (per the earlier provider decision) means adding a
 * provider class and switching `this.provider` — no caller changes.
 */
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);
  private readonly provider: AiProvider;

  constructor(gemini: GeminiProvider) {
    // Model selection is configuration-driven per the earlier AI Gateway
    // decision — GEMINI_MODEL env var, read inside GeminiProvider itself.
    // Provider selection itself is currently fixed to Gemini; when a
    // second provider is added, this becomes a config-driven choice too.
    this.provider = gemini;
  }

  async planResearch(input: PlannerInput): Promise<PlannerOutput> {
    const raw = await this.provider.completeJson({
      systemPrompt: PLANNER_SYSTEM_PROMPT,
      userPrompt: buildPlannerUserPrompt(input),
      responseSchema: PLANNER_RESPONSE_SCHEMA,
      temperature: 0.2,
    });

    if (!isPlannerOutput(raw)) {
      this.logger.error(
        `Planner response failed validation: ${JSON.stringify(raw).slice(0, 500)}`,
      );
      throw new Error(
        'AI Planner response did not match the expected shape — refusing to persist it.',
      );
    }

    return raw;
  }

  /**
   * Evidence Analyst role. Per the locked Slice 3 decisions: still
   * Gemini (no reason to introduce OpenAI now that Gemini is already
   * working and OpenAI billing isn't set up) — this is exactly why the
   * Gateway stays provider-agnostic: adding OpenAI/Anthropic later means
   * a new provider class and a config-driven choice here, no caller
   * changes, same as planResearch above.
   */
  async analyzeEvidence(input: EvidenceAnalystInput): Promise<EvidenceAnalystItem[]> {
    const raw = await this.provider.completeJson({
      systemPrompt: EVIDENCE_ANALYST_SYSTEM_PROMPT,
      userPrompt: buildEvidenceAnalystUserPrompt(input),
      responseSchema: EVIDENCE_ANALYST_RESPONSE_SCHEMA,
      temperature: 0.1,
    });

    if (!isEvidenceAnalystOutput(raw)) {
      this.logger.error(
        `Evidence Analyst response failed validation: ${JSON.stringify(raw).slice(0, 500)}`,
      );
      throw new Error(
        'AI Evidence Analyst response did not match the expected shape — refusing to persist it.',
      );
    }

    return raw.evidenceItems;
  }

  /**
   * Research Analyst role: builds claims, conflicts and gaps from one
   * run's Evidence. (Named for AI-SYSTEM.md's "Research Analyst" —
   * "research interpretation" — rather than "Reviewer", which that doc
   * reserves for reviewing a written document.) Still Gemini, same
   * reasoning as analyzeEvidence above.
   */
  async analyzeResearch(input: ResearchAnalystInput): Promise<ResearchAnalystOutput> {
    const raw = await this.provider.completeJson({
      systemPrompt: RESEARCH_ANALYST_SYSTEM_PROMPT,
      userPrompt: buildResearchAnalystUserPrompt(input),
      responseSchema: RESEARCH_ANALYST_RESPONSE_SCHEMA,
      temperature: 0.1,
    });

    if (!isResearchAnalystOutput(raw)) {
      this.logger.error(
        `Research Analyst response failed validation: ${JSON.stringify(raw).slice(0, 500)}`,
      );
      throw new Error(
        'AI Research Analyst response did not match the expected shape — refusing to persist it.',
      );
    }

    return raw;
  }

  /**
   * Second-pass check of claim wording against the content of its own
   * linked evidence — see claim-grounding-check.role.ts for why this is
   * separate from analyzeResearch. Still Gemini, same reasoning as the
   * other roles above.
   */
  async checkClaimGrounding(input: ClaimGroundingCheckInput): Promise<ClaimGroundingCheckOutput> {
    const raw = await this.provider.completeJson({
      systemPrompt: CLAIM_GROUNDING_CHECK_SYSTEM_PROMPT,
      userPrompt: buildClaimGroundingCheckUserPrompt(input),
      responseSchema: CLAIM_GROUNDING_CHECK_RESPONSE_SCHEMA,
      temperature: 0,
    });

    if (!isClaimGroundingCheckOutput(raw)) {
      this.logger.error(
        `Claim grounding check response failed validation: ${JSON.stringify(raw).slice(0, 500)}`,
      );
      throw new Error(
        'AI claim grounding check response did not match the expected shape — refusing to trust it.',
      );
    }

    return raw;
  }
}