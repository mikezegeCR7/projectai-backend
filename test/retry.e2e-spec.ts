import { fetchWithRetry, parseRetryAfterMs } from '../src/infrastructure/http/retry';

/**
 * Pure unit spec (no AppModule, no network, no Redis): fetch and sleep are
 * stubbed, so it runs in milliseconds and needs no closeTestApp. It lives
 * under test/ with the .e2e-spec.ts suffix only because that is the one
 * pattern jest-e2e.json picks up. Covers fetchWithRetry itself, which
 * both GeminiProvider and SemanticScholarProvider now use.
 */

const OPTS = { maxAttempts: 4, baseDelayMs: 2000, maxDelayMs: 30000, timeoutMs: 1000 };

type Step = () => Response;
const res = (status: number, body = '', headers: Record<string, string> = {}): Step => () =>
  new Response(body, { status, headers });
const boom = (message: string): Step => () => {
  throw new TypeError(message);
};

function harness(steps: Step[]) {
  const calls: string[] = [];
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    opts: {
      ...OPTS,
      fetchImpl: async (url: string) => {
        calls.push(url);
        return steps[Math.min(calls.length - 1, steps.length - 1)]();
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
}

describe('fetchWithRetry', () => {
  it('returns a successful response immediately, without sleeping', async () => {
    const h = harness([res(200, 'ok')]);
    const r = await fetchWithRetry('https://x', { method: 'POST' }, h.opts);
    expect(r.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toHaveLength(0);
  });

  it('retries a 503 with growing backoff, then returns the success', async () => {
    const h = harness([res(503, 'busy'), res(503, 'busy'), res(200, 'ok')]);
    const r = await fetchWithRetry('https://x', { method: 'POST' }, h.opts);
    expect(r.status).toBe(200);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(2000);
    expect(h.sleeps[0]).toBeLessThanOrEqual(2500);
    expect(h.sleeps[1]).toBeGreaterThanOrEqual(4000);
    expect(h.sleeps[1]).toBeLessThanOrEqual(5000);
  });

  it('does not retry a 404 or a 400 (our request or config is wrong)', async () => {
    for (const status of [404, 400, 403]) {
      const h = harness([res(status, 'nope'), res(200)]);
      const r = await fetchWithRetry('https://x', { method: 'POST' }, h.opts);
      expect(r.status).toBe(status);
      expect(h.calls).toHaveLength(1);
      expect(h.sleeps).toHaveLength(0);
    }
  });

  it('gives up after maxAttempts and returns the last failing response with its body intact', async () => {
    const h = harness([res(503, 'still busy')]);
    const r = await fetchWithRetry('https://x', { method: 'POST' }, h.opts);
    expect(r.status).toBe(503);
    expect(await r.text()).toBe('still busy');
    expect(h.calls).toHaveLength(4);
    expect(h.sleeps).toHaveLength(3);
  });

  it('honours Retry-After on a 429', async () => {
    const h = harness([res(429, 'slow down', { 'retry-after': '3' }), res(200)]);
    await fetchWithRetry('https://x', { method: 'POST' }, h.opts);
    expect(h.sleeps[0]).toBeGreaterThanOrEqual(3000);
    expect(h.sleeps[0]).toBeLessThanOrEqual(3750);
  });

  it('caps an unreasonable Retry-After at maxDelayMs', async () => {
    const h = harness([res(429, '', { 'retry-after': '600' }), res(200)]);
    await fetchWithRetry('https://x', { method: 'POST' }, { ...h.opts, maxDelayMs: 10000 });
    expect(h.sleeps[0]).toBeLessThanOrEqual(12500);
  });

  it('retries a network error, then returns the success', async () => {
    const h = harness([boom('fetch failed'), res(200)]);
    const r = await fetchWithRetry('https://x', { method: 'POST' }, h.opts);
    expect(r.status).toBe(200);
    expect(h.calls).toHaveLength(2);
  });

  it('rethrows the network error once attempts are exhausted', async () => {
    const h = harness([boom('fetch failed')]);
    await expect(fetchWithRetry('https://x', { method: 'POST' }, h.opts)).rejects.toThrow('fetch failed');
    expect(h.calls).toHaveLength(4);
  });

  it('aborts a hung request after timeoutMs and retries it', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const r = await fetchWithRetry(
      'https://x',
      { method: 'POST' },
      {
        ...OPTS,
        maxAttempts: 2,
        timeoutMs: 20,
        fetchImpl: (_url, init) => {
          calls++;
          if (calls === 2) return Promise.resolve(new Response('ok', { status: 200 }));
          return new Promise((_resolve, reject) => {
            init.signal!.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          });
        },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    expect(r.status).toBe(200);
    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses seconds, HTTP dates, and ignores junk', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    const now = Date.parse('2026-09-28T12:00:00Z');
    expect(parseRetryAfterMs('Mon, 28 Sep 2026 12:00:10 GMT', now)).toBe(10000);
  });
});