/**
 * Planner role (AI-SYSTEM.md §2): converts a Research Brief
 * (ProjectRequirement) into a structured ResearchPlan. This file is the
 * complete contract for that one role — input shape, output shape, the
 * JSON Schema sent to the provider, the prompt, and a runtime validator.
 * Every other role (Evidence Analyst, Writer, Reviewer, Tutor) should
 * follow this same file-per-role pattern rather than growing one giant
 * "AI stuff" file.
 */

export interface PlannerInput {
  topic: string;
  researchArea?: string | null;
  population?: string | null;
  geographicFocus?: string | null;
  academicLevel?: string | null;
  discipline?: string | null;
  deliverableType?: string | null;
  citationStyle?: string | null;
  wordCount?: number | null;
}

export interface PlannerOutput {
  mainQuestion: string;
  subQuestions: string[];
  keywords: string[];
  searchConcepts: string[];
  sourceTypes: string[];
  inclusionCriteria: string[];
  exclusionCriteria: string[];
  evidenceCategories: string[];
}

export const PLANNER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    mainQuestion: { type: 'string' },
    subQuestions: { type: 'array', items: { type: 'string' } },
    keywords: { type: 'array', items: { type: 'string' } },
    searchConcepts: { type: 'array', items: { type: 'string' } },
    sourceTypes: { type: 'array', items: { type: 'string' } },
    inclusionCriteria: { type: 'array', items: { type: 'string' } },
    exclusionCriteria: { type: 'array', items: { type: 'string' } },
    evidenceCategories: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'mainQuestion',
    'subQuestions',
    'keywords',
    'searchConcepts',
    'sourceTypes',
    'inclusionCriteria',
    'exclusionCriteria',
    'evidenceCategories',
  ],
} as const;

export const PLANNER_SYSTEM_PROMPT = `You are the Planner role in a research workspace system (Project AI).

Your ONLY job is to convert a research brief into a structured research plan. You do not write research content, you do not invent findings, and you do not cite sources — you only plan how research should be conducted.

Rules you must follow:
- Base the plan strictly on the brief given to you. Do not assume facts, statistics, or prior findings about the topic.
- mainQuestion must be a single, specific, answerable research question derived from the topic — not a restatement of the topic itself.
- subQuestions should break the main question into 3-6 investigable parts.
- keywords and searchConcepts are terms a search engine or academic database would actually be queried with — concrete, not vague.
- sourceTypes should name the kinds of sources appropriate for this brief (e.g. "journal_article", "government_report", "news") given its academic level and discipline.
- inclusionCriteria and exclusionCriteria should be concrete scoping rules (e.g. publication date range reasoning, geographic scope, study type) — not generic boilerplate.
- evidenceCategories should name the kinds of evidence this research would need to gather (e.g. "statistics", "case studies", "expert opinion", "legal precedent") appropriate to the brief.
- Respond with ONLY the JSON object matching the required schema. No prose, no markdown fences.`;

export function buildPlannerUserPrompt(input: PlannerInput): string {
  return JSON.stringify(
    {
      topic: input.topic,
      researchArea: input.researchArea ?? undefined,
      population: input.population ?? undefined,
      geographicFocus: input.geographicFocus ?? undefined,
      academicLevel: input.academicLevel ?? undefined,
      discipline: input.discipline ?? undefined,
      deliverableType: input.deliverableType ?? undefined,
      citationStyle: input.citationStyle ?? undefined,
      wordCount: input.wordCount ?? undefined,
    },
    null,
    2,
  );
}

/**
 * Runtime shape check. Gemini's responseSchema constrains output at
 * generation time, but ENGINEERING-RULES.md §6 ("Never trust raw AI
 * output as application truth") means the caller validates independently
 * regardless — this catches a malformed/truncated response, a provider
 * bug, or a future provider that doesn't enforce schemas as strictly.
 */
export function isPlannerOutput(value: unknown): value is PlannerOutput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const stringArrayFields: (keyof PlannerOutput)[] = [
    'subQuestions',
    'keywords',
    'searchConcepts',
    'sourceTypes',
    'inclusionCriteria',
    'exclusionCriteria',
    'evidenceCategories',
  ];
  if (typeof v.mainQuestion !== 'string' || v.mainQuestion.trim() === '') {
    return false;
  }
  return stringArrayFields.every(
    (field) =>
      Array.isArray(v[field]) &&
      (v[field] as unknown[]).every((item) => typeof item === 'string'),
  );
}