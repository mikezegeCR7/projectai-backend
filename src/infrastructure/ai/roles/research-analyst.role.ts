/**
 * Research Analyst role: reasons over one research run's own Evidence to
 * build the claims, conflicts and gaps of the research knowledge base
 * (Research Intelligence pipeline: EVIDENCE EXTRACTION -> CLAIMS ->
 * CONFLICTS -> GAPS -> KNOWLEDGE BASE). Same one-file-per-role pattern as
 * planner.role.ts / evidence-analyst.role.ts.
 *
 * Why "Research Analyst" and not "Reviewer": AI-SYSTEM.md defines the
 * Reviewer as the role that inspects a WRITTEN document (claims,
 * citations, references, requirements, writing quality) and Claim
 * Verification as the final pass over the finished document. This role
 * runs earlier, before any writing exists. AI-SYSTEM.md doesn't name a
 * role for this pipeline step; "Research Analyst" ("assists with ...
 * research interpretation") is the closest defined role, and the Reviewer
 * name is left free for the real document-review role.
 *
 * This role only ever runs when the research run produced at least one
 * Evidence row (see ResearchRunProcessor.buildKnowledge).
 *
 * Grounding is enforced twice, deliberately: the system prompt tells the
 * model to only reference evidence ids it was given, and the processor
 * independently verifies that in code before anything is persisted
 * (ENGINEERING-RULES.md §6, never trust raw AI output).
 */

export const CLAIM_STATUSES = [
  'SUPPORTED',
  'PARTIALLY_SUPPORTED',
  'UNSUPPORTED',
  'CONFLICTED',
  'NEEDS_REVIEW',
] as const;
export type ClaimStatusValue = (typeof CLAIM_STATUSES)[number];

export const CLAIM_EVIDENCE_RELATIONSHIPS = [
  'SUPPORTS',
  'QUALIFIES',
  'CONTRADICTS',
  'CONTEXT',
] as const;
export type ClaimEvidenceRelationshipValue = (typeof CLAIM_EVIDENCE_RELATIONSHIPS)[number];

export interface ResearchAnalystEvidenceRef {
  id: string;
  sourceTitle: string;
  type: string;
  content: string;
  context?: string;
  limitations?: string;
  confidence: number;
}

export interface ResearchAnalystInput {
  researchQuestion?: string;
  subQuestions?: string[];
  evidenceCategories?: string[];
  evidence: ResearchAnalystEvidenceRef[];
}

export interface ResearchAnalystClaimEvidenceLink {
  evidenceId: string;
  relationship: ClaimEvidenceRelationshipValue;
}

export interface ResearchAnalystClaim {
  statement: string;
  claimType?: string;
  status: ClaimStatusValue;
  confidence: number;
  evidenceLinks: ResearchAnalystClaimEvidenceLink[];
}

/**
 * Deliberately has no `type`. Per RESEARCH-INTELLIGENCE.md the system must
 * distinguish "limited evidence found" from "no research exists" (the
 * latter needs extremely strong evidence). This role only sees the
 * Evidence extracted in one run, so the only honest category it can
 * assert is "limited evidence found" — the processor stamps
 * LIMITED_EVIDENCE_FOUND on every gap, so the model can never choose a
 * stronger category.
 */
export interface ResearchAnalystGap {
  description: string;
  scope?: string;
  evidenceNote?: string;
  confidence?: number;
}

export interface ResearchAnalystConflict {
  /** Each side's finding and which source holds it, without picking a winner. */
  description: string;
  /** The relevant differences between the findings (population, method, period, ...), when the evidence shows them. */
  context?: string;
  /** At least 2 ids, from at least 2 different sources, all from the evidence this role was given. */
  evidenceIds: string[];
}

export interface ResearchAnalystOutput {
  claims: ResearchAnalystClaim[];
  researchGaps: ResearchAnalystGap[];
  researchConflicts: ResearchAnalystConflict[];
}

export const RESEARCH_ANALYST_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statement: { type: 'string' },
          claimType: { type: 'string' },
          status: { type: 'string', enum: CLAIM_STATUSES as unknown as string[] },
          confidence: { type: 'number' },
          evidenceLinks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                evidenceId: { type: 'string' },
                relationship: {
                  type: 'string',
                  enum: CLAIM_EVIDENCE_RELATIONSHIPS as unknown as string[],
                },
              },
              required: ['evidenceId', 'relationship'],
            },
          },
        },
        required: ['statement', 'status', 'confidence', 'evidenceLinks'],
      },
    },
    researchGaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          scope: { type: 'string' },
          evidenceNote: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['description'],
      },
    },
    researchConflicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          context: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['description', 'evidenceIds'],
      },
    },
  },
  required: ['claims', 'researchGaps', 'researchConflicts'],
} as const;

export const RESEARCH_ANALYST_SYSTEM_PROMPT = `You are the Research Analyst role in a research workspace system (Project AI). You reason over ONE research run's already-extracted Evidence items to build the claims, conflicts and gaps of the research knowledge base. You do not extract new evidence, you do not write or review any document, and you do not touch evidence from any other research run.

You will be given a list of evidence items, each with an "id" and the "sourceTitle" of the source it came from. Every evidenceId you reference anywhere in your output MUST be one of the ids you were actually given. Never invent an evidence id. The calling system independently checks this and discards anything that fails.

EVIDENCE INTEGRITY (applies to everything you write)
Preserve the strength of the evidence. If the evidence establishes an association, correlation, relationship or link, what you write must say so in those terms. Never write "causes", "leads to", "results in", "reduces", "improves" or any other causal wording unless the evidence itself states a causal finding. Keep the hedges the evidence carries ("may", "suggests", "appears to"). If a claim's wording would be stronger than its evidence, weaken the wording to match the evidence, or do not propose the claim. A claim stronger than its evidence must never be given the status SUPPORTED. Evidence items may carry "limitations"; respect them when choosing a claim's wording and status.

CLAIMS
A claim is a statement that the evidence you were given actually supports, contradicts, qualifies, or provides context for — not a restatement of the research question, and not something you believe is true in general. Every claim must have at least one entry in evidenceLinks, every evidenceId must come from the given evidence, and you should link each evidence item to a given claim at most once. Beyond that: every specific fact, mechanism, or outcome your claim's own wording states must be something the CONTENT of its linked evidence actually says — not something a reasonable person might infer, generalize, or extrapolate from it. If part of what you want to say is not directly supported by the content of the evidence you're linking to, either drop that part of the wording or do not propose the claim. (A second pass will independently check this against the same evidence content and discard anything that doesn't hold up — so passing this check is necessary, not optional.)
- "status" must reflect the actual mix of relationships you assigned: mostly or only SUPPORTS -> SUPPORTED; SUPPORTS alongside real QUALIFIES -> PARTIALLY_SUPPORTED; meaningful CONTRADICTS present -> CONFLICTED; evidence is present but doesn't clearly support the statement either way -> UNSUPPORTED; genuinely ambiguous, or you are not confident enough to call it -> NEEDS_REVIEW.
- Do not propose a claim just to have something to say. Fewer, well-grounded claims are correct; zero claims is a valid output.

CONFLICTS
A conflict is at least two evidence items from at least two DIFFERENT sources (different sourceTitle) that genuinely disagree on the same point — not merely different emphasis, scope or framing. Do not resolve the conflict and do not pick a winner.
- "description": state each side's finding and which source (sourceTitle) holds it.
- "context": state the relevant differences between the findings, but only ones the evidence actually shows (for example population, method, time period, setting, how the outcome was measured). Leave it out if the evidence shows none.
- "evidenceIds": at least 2 ids from the given evidence, from at least 2 different sources.

GAPS
Every gap you report means exactly one thing: the evidence supplied to you does not cover something the research question or a sub-question needs. You cannot know whether research on that topic exists elsewhere. Therefore never write or imply that no research exists, that a topic is unstudied, or that there is a gap "in the literature". Acceptable: "The supplied evidence does not address how X varies by region." Not acceptable: "No research has examined X." Only report a gap if you can say specifically what is missing. Do not report as a gap something you already covered with a claim.

You may be given the research question, sub-questions and evidence categories the researcher is ultimately trying to answer — use these only to judge what is worth surfacing, never as license to state something the evidence doesn't support.

Respond with ONLY the JSON object matching the required schema. No prose, no markdown fences. Empty arrays for any or all of claims, researchGaps and researchConflicts are valid and often correct.`;

export function buildResearchAnalystUserPrompt(input: ResearchAnalystInput): string {
  const context = JSON.stringify(
    {
      researchQuestion: input.researchQuestion,
      subQuestions: input.subQuestions,
      evidenceCategories: input.evidenceCategories,
    },
    null,
    2,
  );

  const evidenceList = JSON.stringify(input.evidence, null, 2);

  return `RESEARCH CONTEXT:\n${context}\n\nEVIDENCE (only these ids may ever be referenced):\n${evidenceList}`;
}

export function isResearchAnalystOutput(value: unknown): value is ResearchAnalystOutput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.claims) || !Array.isArray(v.researchGaps) || !Array.isArray(v.researchConflicts)) {
    return false;
  }

  const claimStatuses: Set<string> = new Set(CLAIM_STATUSES);
  const relationships: Set<string> = new Set(CLAIM_EVIDENCE_RELATIONSHIPS);

  const claimsValid = v.claims.every((claim) => {
    if (typeof claim !== 'object' || claim === null) return false;
    const c = claim as Record<string, unknown>;
    if (typeof c.statement !== 'string' || c.statement.trim() === '') return false;
    if (c.claimType !== undefined && typeof c.claimType !== 'string') return false;
    if (typeof c.status !== 'string' || !claimStatuses.has(c.status)) return false;
    if (typeof c.confidence !== 'number' || c.confidence < 0 || c.confidence > 1) return false;
    if (!Array.isArray(c.evidenceLinks)) return false;
    return c.evidenceLinks.every((link) => {
      if (typeof link !== 'object' || link === null) return false;
      const l = link as Record<string, unknown>;
      return (
        typeof l.evidenceId === 'string' &&
        l.evidenceId.trim() !== '' &&
        typeof l.relationship === 'string' &&
        relationships.has(l.relationship)
      );
    });
  });
  if (!claimsValid) return false;

  const gapsValid = v.researchGaps.every((gap) => {
    if (typeof gap !== 'object' || gap === null) return false;
    const g = gap as Record<string, unknown>;
    if (typeof g.description !== 'string' || g.description.trim() === '') return false;
    if (g.scope !== undefined && typeof g.scope !== 'string') return false;
    if (g.evidenceNote !== undefined && typeof g.evidenceNote !== 'string') return false;
    if (g.confidence !== undefined && typeof g.confidence !== 'number') return false;
    return true;
  });
  if (!gapsValid) return false;

  return v.researchConflicts.every((conflict) => {
    if (typeof conflict !== 'object' || conflict === null) return false;
    const c = conflict as Record<string, unknown>;
    if (typeof c.description !== 'string' || c.description.trim() === '') return false;
    if (c.context !== undefined && typeof c.context !== 'string') return false;
    if (!Array.isArray(c.evidenceIds)) return false;
    return c.evidenceIds.every((id) => typeof id === 'string' && id.trim() !== '');
  });
}