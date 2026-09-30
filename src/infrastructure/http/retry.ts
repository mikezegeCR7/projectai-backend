/**
 * Retry wrapper for calls to third-party HTTP APIs (AI providers, search
 * providers — anything reachable over plain fetch).
 *
 * Why this exists: third-party APIs routinely return transient errors
 * under load. Gemini answers 503 "high demand ... usually temporary" and
 * 429 on free-tier rate limits; Semantic Scholar's unauthenticated pool is
 * shared across all callers worldwide and 429s easily. A research run
 * makes many sequential provider calls, and a single transient failure
 * otherwise either fails the Planner outright, makes the Evidence Analyst
 * silently skip a source, or makes academic discovery silently return
 * zero results — so the run "succeeds" with less than it should have.
 *
 * Behaviour:
 *  - retries on HTTP 429, 500, 502, 503, 504 and on network errors /
 *    timeouts, with exponential backoff plus a little jitter, honouring a
 *    Retry-After header when the provider sends one (capped);
 *  - never retries other statuses (400/401/403/404 mean our request or
 *    config is wrong; retrying only hides that);
 *  - on the final attempt returns the failing response as-is so the
 *    caller reports the provider's own error body, exactly as before;
 *  - the timeout covers time-to-response-headers. For a non-streaming
 *    generateContent call the provider sends headers when generation is
 *    complete, so this bounds the whole call in practice.
 */

// Derived from the global fetch so this file doesn't depend on which
// lib.dom / @types/node combination names RequestInit / Response.
type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type FetchResponse = Awaited<ReturnType<typeof fetch>>;

export interface RetryOptions {
  /** Total attempts including the first (so 4 = 1 try + 3 retries). */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  /** Test seams; default to the real global fetch and setTimeout. */
  fetchImpl?: (url: string, init: FetchInit) => Promise<FetchResponse>;
  sleep?: (ms: number) => Promise<void>;
}

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export function parseRetryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

export async function fetchWithRetry(
  url: string,
  init: FetchInit,
  opts: RetryOptions,
): Promise<FetchResponse> {
  const doFetch = opts.fetchImpl ?? ((u: string, i: FetchInit) => fetch(u, i));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastError: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    const isLast = attempt === opts.maxAttempts;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    let reason: string;
    let retryAfterMs: number | undefined;

    try {
      const response = await doFetch(url, { ...init, signal: controller.signal });
      if (!RETRYABLE_STATUSES.has(response.status)) return response;
      if (isLast) return response; // caller reports the provider's own error body
      reason = `HTTP ${response.status}`;
      retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
      await response.text().catch(() => undefined); // release the connection
    } catch (error) {
      lastError = error;
      if (isLast) throw error;
      reason =
        error instanceof Error && error.name === 'AbortError'
          ? `timed out after ${opts.timeoutMs}ms`
          : `network error: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      clearTimeout(timer);
    }

    const backoff = opts.baseDelayMs * 2 ** (attempt - 1);
    const wait = Math.min(opts.maxDelayMs, retryAfterMs ?? backoff);
    const delayMs = Math.round(wait + Math.random() * wait * 0.25);
    opts.onRetry?.({ attempt, delayMs, reason });
    await sleep(delayMs);
  }

  // Unreachable: the last attempt always returns or throws above.
  throw lastError ?? new Error('fetchWithRetry exhausted its attempts');
}