/**
 * Evidence Analyst role: converts a source's actual retrieved material
 * (full text or, failing that, its abstract) into structured Evidence
 * items. Same one-file-per-role pattern as planner.role.ts.
 *
 * This role only ever runs against a source whose SourceDocument status
 * is COMPLETED or ABSTRACT_ONLY (see ResearchRunProcessor.extractEvidence)
 * — a FAILED source, or one with no SourceDocument at all, never reaches
 * this file. That distinction is the caller's responsibility; this file
 * only encodes what the model itself must not do once it has material.
 */

export type ExtractionScope = 'FULL_TEXT' | 'ABSTRACT_ONLY';

export const EVIDENCE_TYPES = [
  'FINDING',
  'STATISTIC',
  'DEFINITION',
  'METHOD',
  'QUOTE',
  'OBSERVATION',
  'CONCLUSION',
  'OTHER',
] as const;
export type EvidenceItemType = (typeof EVIDENCE_TYPES)[number];

export interface EvidenceAnalystInput {
  researchQuestion?: string;
  evidenceCategories?: string[];
  sourceTitle: string;
  sourceType: string;
  authors?: string[];
  publicationDate?: string;
  extractionScope: ExtractionScope;
  /** The actual material to analyze — already truncated by the caller if needed. */
  text: string;
}

export interface EvidenceAnalystItem {
  type: EvidenceItemType;
  content: string;
  context?: string;
  /**
   * Structural context only (nearest heading, section name, approximate
   * position) — never a page number. This system has no real pagination
   * for any source (HTML-extracted full text or an abstract), so a page
   * reference here would always be fabricated.
   */
  location?: string;
  /**
   * Limitations the source material itself states or clearly shows (small
   * sample, self-reported data, correlational design, the authors' own
   * caveats). Never invented; omitted when the material shows none.
   * RESEARCH-INTELLIGENCE.md: evidence must preserve limitations.
   */
  limitations?: string;
  /** 0-1. The model's own confidence that this item is genuinely supported by the given material. */
  confidence: number;
}

export interface EvidenceAnalystOutput {
  evidenceItems: EvidenceAnalystItem[];
}

export const EVIDENCE_ANALYST_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    evidenceItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: EVIDENCE_TYPES as unknown as string[] },
          content: { type: 'string' },
          context: { type: 'string' },
          location: { type: 'string' },
          limitations: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['type', 'content', 'confidence'],
      },
    },
  },
  required: ['evidenceItems'],
} as const;

export const EVIDENCE_ANALYST_SYSTEM_PROMPT = `You are the Evidence Analyst role in a research workspace system (Project AI).

Your ONLY job is to extract evidence items that are actually present in the source material you are given. You do not plan research, you do not write conclusions about the user's overall research question, and you do not compare this source to any other source.

The single most important rule, above all others:

Evidence must be source-grounded. You may only create an evidence item when the supplied source material actually supports it. If the available material does not contain enough information to support an observation, return no evidence item for that — do not infer, extrapolate, guess, or fabricate one. Returning fewer items (including zero) is always correct when the material doesn't support more. Never pad the list to seem thorough.

You will be told the extractionScope for this source, which changes what you're allowed to do:

- extractionScope "FULL_TEXT": you have the actual retrieved full text of the source. You may extract genuine short passages or quotations (type "QUOTE") as well as paraphrase findings, statistics, definitions, methods, observations, and conclusions that the text actually states. Everything you output must still trace to something actually written in the text you were given.
- extractionScope "ABSTRACT_ONLY": you only have the source's abstract — the full text could not be retrieved. Analyze only what is actually present in that abstract. Do not imply you have seen the full paper. Do not describe methods, statistics, or findings beyond what the abstract itself states.

Never fabricate page numbers, section numbers, quotation marks around text that isn't a genuine excerpt, or passage references of any kind. The "location" field, when you fill it in, must only be structural context you can actually infer from the material itself — the nearest heading, a named section, or a rough position like "early in the introduction". Never state or imply a page number: this system has no real pagination for any source, so a page number would always be invented. Leave "location" out entirely if you cannot honestly infer any structural context.

Preserve the strength of what the source says. If the source reports an association, correlation, relationship or link, write it in those terms — never upgrade it to causation ("causes", "leads to", "results in", "reduces", "improves") unless the source itself states a causal finding. Keep the source's own hedges ("may", "suggests", "appears to"). When you paraphrase, do not strengthen or weaken the claim.

When the material itself states or clearly shows a limitation of the study or finding (for example sample size, self-reported data, correlational design, a single setting or short time period, the authors' own caveats), record it in the item's "limitations" field in your own words. Only record limitations actually present in the material, and leave the field out otherwise. Never invent a limitation. An abstract often states none, so leaving the field out is usually correct for ABSTRACT_ONLY.

For each evidence item, set "confidence" (0 to 1) to your own honest confidence that the item is genuinely supported by the given material — not your confidence in the underlying research finding itself.

Choose "type" from exactly: FINDING, STATISTIC, DEFINITION, METHOD, QUOTE, OBSERVATION, CONCLUSION, OTHER.

You may be given the research question and evidence categories the researcher is ultimately trying to answer — use these only to judge which parts of the material are worth surfacing as evidence, never as license to state something the material doesn't actually say.

Respond with ONLY the JSON object matching the required schema. No prose, no markdown fences. An empty evidenceItems array is a valid and often correct response.`;

export function buildEvidenceAnalystUserPrompt(input: EvidenceAnalystInput): string {
  const metadata = JSON.stringify(
    {
      researchQuestion: input.researchQuestion,
      evidenceCategories: input.evidenceCategories,
      sourceTitle: input.sourceTitle,
      sourceType: input.sourceType,
      authors: input.authors,
      publicationDate: input.publicationDate,
      extractionScope: input.extractionScope,
    },
    null,
    2,
  );

  const materialLabel =
    input.extractionScope === 'FULL_TEXT' ? 'full extracted text' : 'abstract only';

  return `SOURCE METADATA:\n${metadata}\n\nSOURCE MATERIAL (${materialLabel}):\n"""\n${input.text}\n"""`;
}

/**
 * Runtime shape check — see planner.role.ts's isPlannerOutput for why
 * this exists regardless of Gemini's responseSchema enforcement
 * (ENGINEERING-RULES.md §6).
 */
export function isEvidenceAnalystOutput(value: unknown): value is EvidenceAnalystOutput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.evidenceItems)) return false;

  const validTypes: Set<string> = new Set(EVIDENCE_TYPES);
  return v.evidenceItems.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const i = item as Record<string, unknown>;
    if (typeof i.type !== 'string' || !validTypes.has(i.type)) return false;
    if (typeof i.content !== 'string' || i.content.trim() === '') return false;
    if (i.context !== undefined && typeof i.context !== 'string') return false;
    if (i.location !== undefined && typeof i.location !== 'string') return false;
    if (i.limitations !== undefined && typeof i.limitations !== 'string') return false;
    if (typeof i.confidence !== 'number' || i.confidence < 0 || i.confidence > 1) return false;
    return true;
  });
}