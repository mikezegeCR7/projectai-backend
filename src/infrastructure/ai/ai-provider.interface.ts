/**
 * What every AI provider adapter must implement. Nothing above this layer
 * (AiGatewayService, and everything that calls it) ever sees a
 * Gemini/OpenAI/Anthropic-shaped request or response — TRD.md §5:
 * "Use an internal AI Gateway abstraction... Avoid AIService.generate(...)
 * as a generic giant abstraction." completeJson is intentionally the only
 * entry point: every AI call in this system is for structured application
 * state, never free-form chat, so there is no separate "complete text"
 * method to accidentally reach for instead.
 */
export interface AiCompletionRequest {
  /** Frames the role and constraints — the Planner/Evidence Analyst/etc. persona and rules. */
  systemPrompt: string;
  /** The actual task input, already rendered to text by the caller. */
  userPrompt: string;
  /**
   * JSON Schema (subset each provider supports) the response must conform
   * to. Providers that support schema-constrained output should use it;
   * callers MUST still runtime-validate the parsed result themselves
   * (AI-SYSTEM.md §4, ENGINEERING-RULES.md §6) — a provider enforcing its
   * own schema is not a substitute for the caller checking the shape it
   * actually needs.
   */
  responseSchema: Record<string, unknown>;
  temperature?: number;
}

export interface AiProvider {
  readonly name: string;
  /** Returns already-parsed JSON. Throws on a provider/network failure — never returns a partial or malformed result silently. */
  completeJson(request: AiCompletionRequest): Promise<unknown>;
}