#!/usr/bin/env node
/**
 * Asks Gemini which models are actually answering right now, using the
 * same request shape the backend uses (system prompt + JSON responseSchema
 * via generateContent) so a "200 OK" here means the model works for us.
 * One raw attempt per try, deliberately NO retries: the point is to see
 * the real status each model returns at this moment.
 *
 * Usage (from apps/api):
 *   node scripts/probe-gemini.mjs
 *   node scripts/probe-gemini.mjs gemini-3.7-flash gemini-3.5-flash
 *   node scripts/probe-gemini.mjs --tries 4 gemini-3.8-flash
 *
 * Reads GEMINI_API_KEY from apps/api/.env (or the environment).
 */
try {
  await import('dotenv/config');
} catch {
  // optional
}

// Verified against Google's own docs (ai.google.dev), not guessed:
// gemini-3.8-flash (Sept 2, 2026), gemini-3.5-flash and gemini-3.5-flash-lite
// (July 21, 2026, still shown in Google's current curl examples),
// gemini-3.1-pro-preview (Feb 19, 2026). If Google ships a new name later,
// pass it explicitly as an argument instead of relying on this list.
const DEFAULT_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview',
];

const args = process.argv.slice(2);
let tries = 2;
const models = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tries') tries = Number(args[++i]) || 2;
  else models.push(args[i]);
}
if (!models.length) models.push(...DEFAULT_MODELS);

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error('GEMINI_API_KEY is not set (looked in the environment and apps/api/.env).');
  process.exit(2);
}
const BASE = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');

const body = JSON.stringify({
  systemInstruction: { role: 'system', parts: [{ text: 'You reply with JSON only.' }] },
  contents: [{ role: 'user', parts: [{ text: 'Return ok=true and word="ready".' }] }],
  generationConfig: {
    temperature: 0,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' }, word: { type: 'string' } },
      required: ['ok', 'word'],
    },
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summary = [];

console.log(`Probing ${models.length} model(s), ${tries} attempt(s) each, no retries.\n`);
for (const model of models) {
  const statuses = [];
  for (let t = 1; t <= tries; t++) {
    const started = Date.now();
    let line;
    try {
      const res = await fetch(`${BASE}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      if (res.ok) {
        let out = '';
        try {
          out = JSON.parse(text).candidates?.[0]?.content?.parts?.[0]?.text ?? '(no text)';
        } catch {
          out = '(unparseable response)';
        }
        line = `${res.status} OK (${secs}s) ${out.replace(/\s+/g, ' ').slice(0, 80)}`;
        statuses.push('ok');
      } else {
        let msg = text;
        try {
          msg = JSON.parse(text).error?.message ?? text;
        } catch {
          // keep raw
        }
        line = `${res.status} (${secs}s) ${String(msg).replace(/\s+/g, ' ').slice(0, 130)}`;
        statuses.push(String(res.status));
      }
    } catch (err) {
      line = `network error: ${err instanceof Error ? err.message : String(err)}`;
      statuses.push('net');
    }
    console.log(`${model.padEnd(24)} try ${t}: ${line}`);
    if (t < tries) await sleep(1500);
  }
  summary.push([model, statuses]);
  console.log();
}

console.log('SUMMARY');
for (const [model, statuses] of summary) {
  const ok = statuses.filter((s) => s === 'ok').length;
  const verdict = ok === statuses.length ? 'works' : ok > 0 ? 'flaky' : `failing (${[...new Set(statuses)].join(', ')})`;
  console.log(`  ${model.padEnd(24)} ${ok}/${statuses.length} ok  -> ${verdict}`);
}
console.log('\nPut a "works" model in apps/api/.env as GEMINI_MODEL="<name>" and restart the backend.');
