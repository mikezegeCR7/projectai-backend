#!/usr/bin/env node
/**
 * Live end-to-end run against the RUNNING dev server, using the real
 * Planner (Gemini), real search (Tavily + Semantic Scholar), real page
 * fetching, and the real Evidence Analyst / Research Analyst (Gemini).
 * Nothing is faked — this is the check the e2e suite deliberately can't be.
 *
 * It registers a throwaway user, creates a project, saves a brief,
 * generates a plan, starts a research run, waits for it, then prints
 * everything the pipeline produced and checks it against the rules in the
 * Research Intelligence / Database / AI System specs.
 *
 * Usage (from apps/api, with `pnpm start:dev` running in another terminal
 * and NOT running `pnpm test:e2e` at the same time):
 *
 *   node scripts/live-run.mjs "Effects of remote work on team cohesion"
 *
 * Options:
 *   --level <text>        academic level for the brief (default: undergraduate)
 *   --discipline <text>   discipline for the brief
 *   --timeout-min <n>     how long to wait for the run (default: 20)
 *   --cleanup             delete the throwaway user (and its project/data) afterwards
 *
 * Env: BASE_URL (default http://localhost:$PORT or :4000). DATABASE_URL is
 * read from .env if present; it is only used for the optional quotation
 * check against stored source text and for --cleanup.
 *
 * Check levels:
 *   PASS    verified by code
 *   FAIL    a structural rule the system guarantees was violated (a bug)
 *   REVIEW  a keyword/heuristic flag for a HUMAN to read. Never a verdict:
 *           association-vs-causation and "no research exists" wording can't
 *           be decided by a regex.
 * What no script can tell you: whether an unquoted paraphrase is faithful
 * to its source, or whether a claim is actually true. Read those.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

try {
  await import('dotenv/config');
} catch {
  // dotenv is optional here; env vars can come from the shell instead.
}

// ---------------------------------------------------------------------------
// Heuristic patterns (flags for human review, not verdicts)
// ---------------------------------------------------------------------------
const CAUSAL =
  /\b(causes?|caused|causing|leads? to|led to|results? in|resulted in|reduces?|reduced|improves?|improved|boosts?|boosted|drives?|driven|due to|because of|increases?|increased|decreases?|decreased)\b/i;
const ASSOC =
  /\b(associat\w*|correlat\w*|linked to|link between|relationship between|related to|relates? to|co-?occur\w*)\b/i;
const PAGE_LIKE = /\b(pp?\.|pages?)\s*\d+|\bpage\s+[ivxlc]+\b|^\s*\d+\s*$/i;
const NONEXISTENCE =
  /\bno (existing |published |prior |known |previous )?(research|studies|study|literature)\b|\bnever been (studied|researched|examined|investigated)\b|\bhas not been (studied|researched|examined|investigated)\b|\bunstudied\b|\bunder-?researched\b|\bgaps? in the (literature|research)\b/i;

const CLAIM_STATUSES = ['SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'CONFLICTED', 'NEEDS_REVIEW'];
const USABLE_DOC_STATUSES = ['COMPLETED', 'ABSTRACT_ONLY'];

const norm = (t) =>
  String(t ?? '')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const clip = (t, n) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

// ---------------------------------------------------------------------------
// Analysis (pure: exported so it can be tested without a server)
// ---------------------------------------------------------------------------
function quotedSpans(e) {
  const spans = [];
  const re = /"([^"]{25,}?)"|\u201c([^\u201d]{25,}?)\u201d/g;
  let m;
  while ((m = re.exec(e.content ?? ''))) spans.push(m[1] ?? m[2]);
  if (e.type === 'QUOTE' && spans.length === 0) {
    spans.push(String(e.content ?? '').trim().replace(/^["\u201c\u201d'\u2018\u2019]+|["\u201c\u201d'\u2018\u2019]+$/g, ''));
  }
  return spans;
}

function fragmentsOf(span) {
  return span
    .split(/\.\.\.|\u2026|\[[^\]]*\]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
}

export function analyze({ run, events, sources, evidence, claims, gaps, conflicts, storedTexts }) {
  const checks = [];
  const check = (level, name, issues, note = '') =>
    checks.push({ name, level: issues.length ? level : 'PASS', issues, note });

  // Stable short labels: S1.., E1..
  const sortedSources = [...sources].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
  const S = new Map(sortedSources.map((s, i) => [s.id, `S${i + 1}`]));
  const sortedEvidence = [...evidence].sort(
    (a, b) => (S.get(a.sourceId) ?? '').localeCompare(S.get(b.sourceId) ?? '', undefined, { numeric: true }) || a.id.localeCompare(b.id),
  );
  const E = new Map(sortedEvidence.map((e, i) => [e.id, `E${i + 1}`]));
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const evById = new Map(evidence.map((e) => [e.id, e]));

  const textOf = (sourceId) => {
    const s = sourceById.get(sourceId);
    if (!s?.document) return { text: null, scope: null };
    if (s.document.status === 'COMPLETED') {
      const t = storedTexts?.map?.get(sourceId);
      return { text: t ?? null, scope: 'full text' };
    }
    if (s.document.status === 'ABSTRACT_ONLY') return { text: s.abstract ?? null, scope: 'abstract' };
    return { text: null, scope: null };
  };

  // --- Run-level -----------------------------------------------------------
  check('FAIL', 'Research run reached COMPLETED', run.status === 'COMPLETED' ? [] : [`status was ${run.status}`]);

  const bk = events.find((e) => e.type === 'building_knowledge');
  check(
    'FAIL',
    'Knowledge-building (Research Analyst) step ran without failing',
    !bk
      ? ['no building_knowledge event was recorded']
      : /failed/i.test(bk.message)
        ? [`${bk.message} — look for "Research Analyst failed" in the dev-server log`]
        : [],
  );

  const expectedStages = ['queued', 'planning', 'searching', 'evaluating', 'retrieving', 'retrieved', 'extracting', 'building_knowledge', 'completed'];
  const types = events.map((e) => e.type);
  let cursor = -1;
  const missingStages = [];
  for (const t of expectedStages) {
    const i = types.indexOf(t, cursor + 1);
    if (i === -1) missingStages.push(t);
    else cursor = i;
  }
  check('FAIL', 'Run events cover every pipeline stage, in order', missingStages.map((t) => `missing or out of order: ${t}`));

  // --- Evidence integrity ---------------------------------------------------
  const isUsable = (s) => s && s.evaluationStatus === 'ACCEPTED' && s.document && USABLE_DOC_STATUSES.includes(s.document.status);

  check(
    'FAIL',
    'No evidence exists for a source whose retrieval FAILED (or that was never accepted)',
    evidence
      .filter((e) => !isUsable(sourceById.get(e.sourceId)))
      .map((e) => {
        const s = sourceById.get(e.sourceId);
        return `${E.get(e.id)} belongs to ${S.get(e.sourceId) ?? 'unknown source'} (evaluation=${s?.evaluationStatus}, document=${s?.document?.status ?? 'none'})`;
      }),
    `${evidence.length} evidence item(s) checked`,
  );

  check(
    'FAIL',
    'Every evidence item from an abstract-only source says so in its limitations',
    evidence
      .filter((e) => sourceById.get(e.sourceId)?.document?.status === 'ABSTRACT_ONLY' && !/abstract only/i.test(e.limitations ?? ''))
      .map((e) => `${E.get(e.id)} (${S.get(e.sourceId)}) has no abstract-only limitation`),
  );

  check(
    'FAIL',
    'No evidence location looks like a page number (the system has no real pagination)',
    evidence
      .filter((e) => {
        const loc = typeof e.location === 'string' ? e.location : e.location ? JSON.stringify(e.location) : '';
        return loc && PAGE_LIKE.test(loc);
      })
      .map((e) => `${E.get(e.id)} location=${JSON.stringify(e.location)}`),
  );

  check(
    'FAIL',
    'All confidence values are within 0..1',
    [
      ...evidence.filter((e) => typeof e.confidence === 'number' && (e.confidence < 0 || e.confidence > 1)).map((e) => `${E.get(e.id)} confidence=${e.confidence}`),
      ...claims.filter((c) => typeof c.confidence === 'number' && (c.confidence < 0 || c.confidence > 1)).map((c) => `claim "${clip(c.statement, 50)}" confidence=${c.confidence}`),
    ],
  );

  check(
    'REVIEW',
    'Every accepted, retrievable source produced evidence',
    sources
      .filter((s) => isUsable(s) && !evidence.some((e) => e.sourceId === s.id))
      .map((s) => `${S.get(s.id)} "${clip(s.title, 60)}" (${s.document.status}) produced no evidence — fine if the material was thin; otherwise look for "Evidence Analyst failed" in the dev-server log`),
  );

  // Quotations: the one fabrication rule code CAN verify against stored text.
  const quoteIssues = [];
  const quoteNotes = [];
  let quotesChecked = 0;
  for (const e of evidence) {
    const spans = quotedSpans(e);
    if (!spans.length) continue;
    const { text, scope } = textOf(e.sourceId);
    if (!text) {
      quoteNotes.push(`${E.get(e.id)}: contains a quotation but no ${scope ?? 'source'} text was available to verify it against`);
      continue;
    }
    for (const span of spans) {
      for (const frag of fragmentsOf(span)) {
        quotesChecked++;
        if (!norm(text).includes(norm(frag))) {
          quoteIssues.push(`${E.get(e.id)} (${S.get(e.sourceId)} ${scope}): quoted text not found verbatim: "${clip(frag, 120)}"`);
        }
      }
    }
  }
  check(
    'REVIEW',
    'Quotations in evidence appear verbatim in the stored source text',
    quoteIssues,
    `${quotesChecked} quoted fragment(s) verified${quoteNotes.length ? `; NOT verifiable: ${quoteNotes.join(' | ')}` : ''}${storedTexts?.error ? `; full-text lookup unavailable (${storedTexts.error})` : ''}`,
  );

  // --- Claims ---------------------------------------------------------------
  check(
    'FAIL',
    'Every claim has a valid status and at least one link to real evidence',
    claims.flatMap((c) => {
      const out = [];
      if (!CLAIM_STATUSES.includes(c.status)) out.push(`"${clip(c.statement, 50)}" has invalid status ${c.status}`);
      if (!c.evidence?.length) out.push(`"${clip(c.statement, 50)}" has no evidence links`);
      for (const l of c.evidence ?? []) if (!evById.has(l.evidenceId)) out.push(`"${clip(c.statement, 50)}" links unknown evidence ${l.evidenceId}`);
      return out;
    }),
    `${claims.length} claim(s) checked`,
  );

  check(
    'REVIEW',
    "Each claim's status is consistent with the relationships of its links",
    claims.flatMap((c) => {
      const rel = (c.evidence ?? []).map((l) => l.relationship);
      const out = [];
      if (c.status === 'SUPPORTED' && rel.includes('CONTRADICTS')) out.push(`SUPPORTED but has a CONTRADICTS link: "${clip(c.statement, 70)}"`);
      if (c.status === 'SUPPORTED' && !rel.includes('SUPPORTS')) out.push(`SUPPORTED but has no SUPPORTS link: "${clip(c.statement, 70)}"`);
      if (c.status === 'CONFLICTED' && !rel.includes('CONTRADICTS')) out.push(`CONFLICTED but has no CONTRADICTS link: "${clip(c.statement, 70)}"`);
      return out;
    }),
  );

  // --- Association vs causation (heuristic) ---------------------------------
  const causalIssues = [];
  for (const c of claims) {
    if (!CAUSAL.test(c.statement)) continue;
    const linked = (c.evidence ?? []).map((l) => evById.get(l.evidenceId)).filter(Boolean);
    const anyAssoc = linked.some((e) => ASSOC.test(e.content));
    const anyCausal = linked.some((e) => CAUSAL.test(e.content));
    if (anyAssoc && !anyCausal) {
      causalIssues.push(`POSSIBLE UPGRADE: claim uses causal wording but its linked evidence only uses association wording — "${clip(c.statement, 110)}" [${linked.map((e) => E.get(e.id)).join(', ')}]`);
    } else if (['SUPPORTED', 'PARTIALLY_SUPPORTED'].includes(c.status)) {
      causalIssues.push(`causal wording in a ${c.status} claim — confirm the linked evidence states a causal finding: "${clip(c.statement, 110)}" [${linked.map((e) => E.get(e.id)).join(', ')}]`);
    }
  }
  let causalEvidenceCount = 0;
  for (const e of evidence) {
    if (!CAUSAL.test(e.content)) continue;
    causalEvidenceCount++;
    const { text, scope } = textOf(e.sourceId);
    if (text && ASSOC.test(text) && !CAUSAL.test(text)) {
      causalIssues.push(`POSSIBLE UPGRADE: ${E.get(e.id)} uses causal wording but the ${scope} of ${S.get(e.sourceId)} only uses association wording — "${clip(e.content, 110)}"`);
    }
  }
  check(
    'REVIEW',
    'Causal wording vs. the strength of the evidence (keyword flags — read them)',
    causalIssues,
    `${causalEvidenceCount} evidence item(s) use causal-sounding words but were not contradicted by their source text`,
  );

  // --- Gaps -----------------------------------------------------------------
  check(
    'FAIL',
    'Every gap is recorded as LIMITED_EVIDENCE_FOUND',
    gaps.filter((g) => g.type !== 'LIMITED_EVIDENCE_FOUND').map((g) => `gap "${clip(g.description, 60)}" has type ${g.type}`),
    `${gaps.length} gap(s) checked`,
  );
  check(
    'REVIEW',
    'No gap asserts that research does not exist (keyword flags — read them)',
    gaps.filter((g) => NONEXISTENCE.test(`${g.description} ${g.evidence ?? ''} ${g.scope ?? ''}`)).map((g) => `"${clip(g.description, 140)}"`),
  );

  // --- Conflicts ------------------------------------------------------------
  check(
    'FAIL',
    'Every conflict links 2+ real evidence items from 2+ different sources',
    conflicts.flatMap((c) => {
      const links = c.evidence ?? [];
      const out = [];
      if (links.length < 2) out.push(`"${clip(c.description, 60)}" has ${links.length} evidence link(s)`);
      const srcs = new Set();
      for (const l of links) {
        const ev = evById.get(l.evidenceId);
        if (!ev) out.push(`"${clip(c.description, 60)}" links unknown evidence ${l.evidenceId}`);
        else srcs.add(ev.sourceId);
      }
      if (links.length >= 2 && srcs.size < 2) out.push(`"${clip(c.description, 60)}" links evidence from only one source`);
      return out;
    }),
    `${conflicts.length} conflict(s) checked`,
  );

  return { checks, labels: { S, E } };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else {
        out[k] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s = '') => console.log(s);
const rule = (title) => say(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);

async function loadPrisma() {
  try {
    const mod = await import('@prisma/client');
    const PrismaClient = mod.PrismaClient ?? mod.default?.PrismaClient;
    if (!PrismaClient) throw new Error('PrismaClient not exported');
    return { prisma: new PrismaClient() };
  } catch (err) {
    return { error: err instanceof Error ? err.message.split('\n')[0] : String(err) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const topic = args._[0] ?? args.topic ?? 'Effects of remote work on team cohesion';
  const timeoutMs = Number(args['timeout-min'] ?? 20) * 60_000;
  const BASE = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/$/, '');
  const API = `${BASE}/api/v1`;

  async function api(method, path, { cookie, body, expect } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (expect && !expect.includes(res.status)) {
      throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 600)}`);
    }
    return { status: res.status, json, headers: res.headers };
  }

  say(`Project AI live run\nTopic:  ${topic}\nServer: ${BASE}`);

  try {
    await api('GET', '/auth/me');
  } catch (err) {
    throw new Error(`Cannot reach the API at ${BASE} (${err.message}). Is "pnpm start:dev" running?`);
  }

  // 1. Throwaway user + project + brief + plan
  const email = `live-run-${Date.now()}@example.com`;
  const password = 'correct horse battery staple';
  const reg = await api('POST', '/auth/register', { body: { email, password }, expect: [201] });
  const setCookies = reg.headers.getSetCookie?.() ?? [reg.headers.get('set-cookie')].filter(Boolean);
  const sid = setCookies.find((c) => c.startsWith('project_ai_sid='));
  if (!sid) throw new Error('Registration did not return a project_ai_sid session cookie');
  const cookie = sid.split(';')[0];

  const project = (await api('POST', '/projects', { cookie, body: { name: `Live run: ${clip(topic, 60)}`, type: 'ACADEMIC' }, expect: [201] })).json;
  await api('PUT', `/projects/${project.id}/requirements`, {
    cookie,
    body: { topic, academicLevel: args.level ?? 'undergraduate', ...(args.discipline ? { discipline: args.discipline } : {}) },
    expect: [200],
  });

  say('\nGenerating research plan with the real Planner (Gemini)...');
  const plan = (await api('POST', `/projects/${project.id}/research-plans/generate`, { cookie, expect: [201] })).json;
  say(`  main question: ${plan.mainQuestion}`);
  say(`  keywords:      ${JSON.stringify(plan.keywords)}`);

  // 2. Run + progress
  const runStart = Date.now();
  const run0 = (await api('POST', `/projects/${project.id}/research-runs`, { cookie, body: { researchPlanId: plan.id }, expect: [201] })).json;
  say(`\nResearch run ${run0.id} started. Waiting (timeout ${Math.round(timeoutMs / 60000)} min)...\n`);

  const seen = new Set();
  let firstEventAt = null;
  const printNewEvents = (events) => {
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      firstEventAt ??= new Date(e.createdAt).getTime();
      const secs = ((new Date(e.createdAt).getTime() - firstEventAt) / 1000).toFixed(1).padStart(6);
      say(`  +${secs}s  ${e.type.padEnd(18)} ${e.message}`);
    }
  };

  let run = run0;
  let warnedQueued = false;
  const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
  while (Date.now() - runStart < timeoutMs) {
    run = (await api('GET', `/research-runs/${run0.id}`, { cookie, expect: [200] })).json;
    printNewEvents((await api('GET', `/research-runs/${run0.id}/events`, { cookie, expect: [200] })).json);
    if (terminal.has(run.status)) break;
    if (run.status === 'QUEUED' && !warnedQueued && Date.now() - runStart > 45_000) {
      warnedQueued = true;
      say('  (still QUEUED after 45s — the worker runs inside the dev server; is it running and connected to Redis?)');
    }
    await sleep(2000);
  }
  if (!terminal.has(run.status)) throw new Error(`Run did not finish within ${args['timeout-min'] ?? 20} minutes (last status ${run.status})`);
  const elapsed = ((Date.now() - runStart) / 1000).toFixed(1);

  // 3. Collect everything
  const events = (await api('GET', `/research-runs/${run0.id}/events`, { cookie, expect: [200] })).json;
  const get = async (p) => (await api('GET', `/projects/${project.id}/${p}`, { cookie, expect: [200] })).json;
  const [sources, evidence, claims, gaps, conflicts] = await Promise.all([
    get('sources'), get('evidence'), get('claims'), get('research-gaps'), get('research-conflicts'),
  ]);

  // 4. Optional: stored full text for quotation verification
  const db = await loadPrisma();
  let storedTexts;
  if (db.prisma) {
    try {
      const rows = await db.prisma.sourceDocumentText.findMany({ where: { key: { in: sources.map((s) => s.id) } } });
      storedTexts = { map: new Map(rows.map((r) => [r.key, r.content])) };
    } catch (err) {
      storedTexts = { error: `database lookup failed: ${String(err.message).split('\n')[0]}` };
    }
  } else {
    storedTexts = { error: db.error };
  }

  const { checks, labels } = analyze({ run, events, sources, evidence, claims, gaps, conflicts, storedTexts });
  const S = labels.S;
  const E = labels.E;

  // 5. Report
  rule(`RESULT: run ${run.status} in ${elapsed}s`);
  const byDoc = {};
  for (const s of sources) byDoc[s.document?.status ?? 'none'] = (byDoc[s.document?.status ?? 'none'] ?? 0) + 1;
  say(`${sources.length} source(s)  |  ${evidence.length} evidence  |  ${claims.length} claim(s)  |  ${gaps.length} gap(s)  |  ${conflicts.length} conflict(s)`);
  say(`Document status across sources: ${JSON.stringify(byDoc)}`);

  rule('SOURCES');
  for (const s of [...sources].sort((a, b) => S.get(a.id).localeCompare(S.get(b.id), undefined, { numeric: true }))) {
    say(`${S.get(s.id).padEnd(4)} ${String(s.provider).padEnd(17)} ${String(s.evaluationStatus).padEnd(13)} doc=${String(s.document?.status ?? '-').padEnd(13)} ${clip(s.title, 70)}`);
    if (s.document?.status === 'FAILED' || (s.document?.status === 'ABSTRACT_ONLY' && s.document?.errorMessage)) {
      say(`       └ ${clip(s.document.errorMessage, 160)}`);
    }
  }

  rule('EVIDENCE');
  const evSorted = [...evidence].sort((a, b) => E.get(a.id).localeCompare(E.get(b.id), undefined, { numeric: true }));
  for (const e of evSorted) {
    const scope = sources.find((s) => s.id === e.sourceId)?.document?.status ?? '-';
    say(`${E.get(e.id)} [${S.get(e.sourceId)} ${scope}] ${e.type}  confidence=${e.confidence}  location=${e.location ? JSON.stringify(e.location) : '-'}`);
    say(`     ${clip(e.content, 400)}`);
    if (e.limitations) say(`     limitations: ${clip(e.limitations, 250)}`);
  }

  rule('CLAIMS');
  for (const c of claims) {
    say(`• [${c.status}] (confidence ${c.confidence}) ${c.statement}`);
    say(`    links: ${(c.evidence ?? []).map((l) => `${E.get(l.evidenceId) ?? '?'}:${l.relationship}`).join(', ') || '(none)'}`);
  }
  if (!claims.length) say('(none)');

  rule('RESEARCH GAPS');
  for (const g of gaps) say(`• [${g.type}] ${g.description}${g.evidence ? `\n    evidence note: ${g.evidence}` : ''}${g.scope ? `\n    scope: ${g.scope}` : ''}`);
  if (!gaps.length) say('(none)');

  rule('RESEARCH CONFLICTS');
  for (const c of conflicts) {
    say(`• ${c.description}`);
    if (c.context) say(`    differences: ${c.context}`);
    say(`    between: ${(c.evidence ?? []).map((l) => `${E.get(l.evidenceId) ?? '?'} (${S.get(evidence.find((e) => e.id === l.evidenceId)?.sourceId) ?? '?'})`).join(' vs ')}`);
  }
  if (!conflicts.length) say('(none)');

  rule('CHECKS');
  for (const c of checks) {
    say(`[${c.level.padEnd(6)}] ${c.name}${c.note ? `  — ${c.note}` : ''}`);
    for (const issue of c.issues) say(`           - ${issue}`);
  }
  const tally = (l) => checks.filter((c) => c.level === l).length;
  say(`\n${tally('PASS')} passed, ${tally('FAIL')} FAILED, ${tally('REVIEW')} need your review.`);
  say('Not checkable by any script: whether unquoted paraphrases are faithful to their source, and whether claims are true. Read those against the sources.');

  writeFileSync('live-run-report.json', JSON.stringify({ topic, run, events, sources, evidence, claims, gaps, conflicts, checks }, null, 2));
  say(`\nFull data (untruncated) written to live-run-report.json`);
  say(`Throwaway login: ${email} / ${password}   (project ${project.id})`);

  if (args.cleanup) {
    if (db.prisma) {
      await db.prisma.user.deleteMany({ where: { email } });
      say('--cleanup: throwaway user and its data deleted.');
    } else {
      say(`--cleanup requested but the database is unreachable from this script (${db.error}); nothing deleted.`);
    }
  }
  if (db.prisma) await db.prisma.$disconnect();

  process.exitCode = tally('FAIL') ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(`\nLive run aborted: ${err.message}`);
    process.exit(2);
  });
}
