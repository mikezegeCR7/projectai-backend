import { Injectable, Logger } from '@nestjs/common';
import {
  AiCompletionRequest,
  AiProvider,
} from '../ai-provider.interface';
import { fetchWithRetry } from '../../http/retry';

// 1 try + 3 retries. Worst case spends roughly 2+4+8s waiting on backoff.
const MAX_ATTEMPTS = 4;

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

/**
 * Uses the legacy (still fully supported, per Google's own docs as of
 * mid-2026) `generateContent` endpoint rather than the newer Interactions
 * API — simpler request/response shape for a single-turn structured call,
 * which is all every role in this system needs. Model is configurable
 * (GEMINI_MODEL) since Google ships new model IDs frequently and retires
 * old ones (gemini-2.5-flash started returning 404 "no longer available to
 * new users" in Sept 2026); defaults to gemini-3.8-flash, which has a real
 * free tier via AI Studio.
 *
 * Calls go through fetchWithRetry: Gemini answers 503 ("high demand") and
 * 429 (free-tier rate limit) transiently, and a single failed call would
 * otherwise fail the Planner or make the Evidence Analyst skip a source.
 */
@Injectable()
export class GeminiProvider implements AiProvider {
  readonly name = 'gemini';
  private readonly logger = new Logger(GeminiProvider.name);
  private readonly apiKey = process.env.GEMINI_API_KEY;
  private readonly model = process.env.GEMINI_MODEL ?? 'gemini-3.8-flash';

  async completeJson(request: AiCompletionRequest): Promise<unknown> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is not set — cannot call the AI Gateway.');
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

    const response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            role: 'system',
            parts: [{ text: request.systemPrompt }],
          },
          contents: [{ role: 'user', parts: [{ text: request.userPrompt }] }],
          generationConfig: {
            temperature: request.temperature ?? 0.2,
            responseMimeType: 'application/json',
            responseSchema: request.responseSchema,
          },
        }),
      },
      {
        maxAttempts: MAX_ATTEMPTS,
        baseDelayMs: 2000,
        maxDelayMs: 30000,
        timeoutMs: 120000,
        onRetry: ({ attempt, delayMs, reason }) =>
          this.logger.warn(
            `Gemini call failed (${reason}); retry ${attempt} of ${MAX_ATTEMPTS - 1} in ${Math.round(delayMs / 1000)}s`,
          ),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Gemini request failed: ${response.status} ${response.statusText} ${body.slice(0, 500)}`,
      );
    }

    const body = (await response.json()) as GeminiResponse;

    if (body.promptFeedback?.blockReason) {
      throw new Error(
        `Gemini blocked the request: ${body.promptFeedback.blockReason}`,
      );
    }

    const candidate = body.candidates?.[0];
    const text = candidate?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error(
        `Gemini returned no content (finishReason: ${candidate?.finishReason ?? 'unknown'}).`,
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      this.logger.error(`Gemini returned non-JSON despite responseSchema: ${text.slice(0, 500)}`);
      throw new Error('Gemini returned a response that was not valid JSON.');
    }
  }
}