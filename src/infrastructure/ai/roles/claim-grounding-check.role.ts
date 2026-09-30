/**
 * Claim grounding check: a second, narrow AI pass over claims the
 * Research Analyst already proposed, before they're persisted.
 *
 * Why this exists, separately from research-analyst.role.ts: that role
 * already enforces that every evidenceId a claim links to is real (a
 * structural check ResearchRunProcessor verifies in code — see
 * buildKnowledge). But a real id proves nothing about whether the
 * CLAIM'S OWN WORDING stays within what that evidence's content actually
 * says. A live run surfaced exactly this: a claim linked a real,
 * genuinely relevant piece of evidence, but its statement asserted an
 * effect ("undermines trust and rapport") the evidence never mentioned —
 * a real id, ungrounded content. No string check can catch that; it
 * needs a model to actually compare meaning.
 *
 * This role's only job is that comparison, on claims that already passed
 * the structural check. It does not propose claims, does not evaluate
 * whether a claim is true in the world, and does not use any knowledge
 * beyond the evidence content it's given for that specific claim. Per
 * AI-SYSTEM.md's Claim Verification concept ("match claims against
 * stored evidence ... identify unsupported or questionable claims"),
 * applied here at the point claims are first proposed rather than over a
 * final written document (there is no Writer/Document yet for this to
 * run over) — the doc-level version, once a Writer exists, is a
 * separate, later piece of work and should keep the "Claim Verification"
 * name for itself; this role is deliberately named for what it actually
 * checks instead.
 *
 * Like every other role in this codebase, this is itself an AI call, and
 * an AI call checking AI output does not make ungroundedness impossible
 * — a false negative here (calling an ungrounded claim grounded) is
 * still possible. It substantially raises the bar over trusting the
 * first pass alone, which is the honest claim being made, not "solved".
 */

export interface ClaimGroundingCheckEvidenceRef {
  id: string;
  content: string;
}

export interface ClaimGroundingCheckClaimInput {
  /** Caller-assigned id for matching results back to claims — not a persisted Claim id. */
  id: string;
  statement: string;
  linkedEvidence: ClaimGroundingCheckEvidenceRef[];
}

export interface ClaimGroundingCheckInput {
  claims: ClaimGroundingCheckClaimInput[];
}

export interface ClaimGroundingCheckResult {
  id: string;
  grounded: boolean;
}

export interface ClaimGroundingCheckOutput {
  results: ClaimGroundingCheckResult[];
}

export const CLAIM_GROUNDING_CHECK_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          grounded: { type: 'boolean' },
        },
        required: ['id', 'grounded'],
      },
    },
  },
  required: ['results'],
} as const;

export const CLAIM_GROUNDING_CHECK_SYSTEM_PROMPT = `You are a narrow fact-checking pass in a research workspace system (Project AI). You will be given a list of claims, each with the exact evidence content it was linked to. For EACH claim, decide only one thing: does the content of its linked evidence actually say everything the claim's own wording states?

Rules:
- Judge only the specific facts, mechanisms, and outcomes the claim's wording asserts. If every part of the claim is stated in the linked evidence content (allowing for paraphrase, not requiring identical wording), grounded is true.
- If any part of the claim goes beyond the linked evidence content — a stronger effect, an added mechanism, a causal link the evidence doesn't state, an outcome the evidence never mentions — grounded is false, even if the rest of the claim is fine and even if the added part sounds plausible.
- Do not use any knowledge beyond the evidence content you were given for that claim. Do not judge whether the claim is true in general, only whether THIS evidence content actually states it.
- Do not judge relevance, importance, or writing quality. A claim can be true, important, and well-written, and still be ungrounded if its wording outruns its cited evidence.
- Every claim id you were given must appear exactly once in "results". Do not add, omit, or invent an id.

Respond with ONLY the JSON object matching the required schema. No prose, no markdown fences.`;

export function buildClaimGroundingCheckUserPrompt(input: ClaimGroundingCheckInput): string {
  return `CLAIMS TO CHECK:\n${JSON.stringify(input.claims, null, 2)}`;
}

export function isClaimGroundingCheckOutput(value: unknown): value is ClaimGroundingCheckOutput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.results)) return false;
  return v.results.every((r) => {
    if (typeof r !== 'object' || r === null) return false;
    const rr = r as Record<string, unknown>;
    return typeof rr.id === 'string' && rr.id.trim() !== '' && typeof rr.grounded === 'boolean';
  });
}