import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { SearchGatewayService } from '../src/infrastructure/search/search-gateway.service';
import { AiGatewayService } from '../src/infrastructure/ai/ai-gateway.service';
import { SourceType } from '@prisma/client';
import { closeTestApp } from './helpers/close-test-app';

/**
 * Requires Postgres AND Redis reachable (see README.md "Running locally").
 * SearchGatewayService is overridden with a fake so this test exercises
 * the real HTTP -> controller -> service -> Prisma -> BullMQ -> worker ->
 * Prisma -> HTTP chain without needing TAVILY_API_KEY or live network
 * calls — the boundary being faked is the third-party APIs, not our code.
 * AiGatewayService is overridden the same way, for the same reason: real
 * Gemini calls belong to ai-gateway-planner.e2e-spec.ts, which exists
 * specifically to exercise the live AI Gateway. This suite fakes
 * analyzeEvidence so evidence extraction is deterministic and doesn't
 * depend on a reachable Gemini API key.
 */
describe('Vertical Slice 2: research plan -> research run -> sources (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const uniqueEmail = () =>
    `slice2-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const createdEmails: string[] = [];

  const fakeCandidates = [
    {
      provider: 'tavily' as const,
      title: 'Remote work and team cohesion: a field study',
      url: 'https://example-gov.gov/report-1',
      abstract: 'A government report on remote work outcomes.',
      sourceType: SourceType.GOVERNMENT_REPORT,
      relevanceScore: 0.82,
    },
    {
      provider: 'semantic_scholar' as const,
      title: 'Effects of distributed teams on cohesion',
      doi: '10.1234/example.001',
      authors: [{ name: 'A. Researcher' }],
      journal: 'Journal of Org Psychology',
      abstract: 'Peer-reviewed study on distributed team cohesion.',
      sourceType: SourceType.JOURNAL_ARTICLE,
      relevanceScore: 0.91,
    },
    {
      // Second academic source, so the Research Analyst has evidence from
      // TWO different sources to build a cross-source conflict from.
      provider: 'semantic_scholar' as const,
      title: 'Remote teams and cohesion: a replication',
      doi: '10.1234/example.002',
      authors: [{ name: 'B. Replicator' }],
      journal: 'Journal of Org Psychology',
      abstract: 'Replication study of distributed team cohesion.',
      sourceType: SourceType.JOURNAL_ARTICLE,
      relevanceScore: 0.88,
    },
    {
      // Low relevance -> should land as NEEDS_REVIEW, not ACCEPTED.
      provider: 'tavily' as const,
      title: 'Loosely related blog post about work culture',
      url: 'https://example-blog.com/culture-take',
      abstract: 'A blog opinion piece.',
      sourceType: SourceType.WEBSITE,
      relevanceScore: 0.2,
    },
  ];

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(SearchGatewayService)
      .useValue({
        discover: jest.fn().mockImplementation(async () => {
          // Small artificial delay so the cancellation test below has a
          // real window to land its cancel before the worker finishes.
          await new Promise((resolve) => setTimeout(resolve, 400));
          return fakeCandidates;
        }),
      })
      .overrideProvider(AiGatewayService)
      .useValue({
        // One item per source, plus a second item for source A so the
        // same-source conflict case below has two items from one source.
        // The first item carries a source-stated limitation, to prove it
        // is preserved alongside the abstract-only note.
        analyzeEvidence: jest.fn().mockImplementation(
          async (input: { extractionScope: string; sourceTitle: string }) => {
            const items: Record<string, unknown>[] = [
              {
                type: 'OBSERVATION',
                content: `Fake ${input.extractionScope} evidence item 1 for ${input.sourceTitle}.`,
                limitations: 'Fake source-stated limitation.',
                confidence: 0.75,
              },
            ];
            if (input.sourceTitle === 'Effects of distributed teams on cohesion') {
              items.push({
                type: 'FINDING',
                content: `Fake ${input.extractionScope} evidence item 2 for ${input.sourceTitle}.`,
                confidence: 0.7,
              });
            }
            return items;
          },
        ),
        // Deterministic checkClaimGrounding fake: marks every claim
        // grounded except the one statement below that's deliberately
        // designed to have a valid evidence link but overreaching
        // wording — proves the processor's second-pass check drops it
        // even though the id-check alone would have let it through.
        checkClaimGrounding: jest.fn().mockImplementation(
          async (input: { claims: { id: string; statement: string }[] }) => ({
            results: input.claims.map((c) => ({
              id: c.id,
              grounded: c.statement !== 'Overreaching claim: valid id but ungrounded wording.',
            })),
          }),
        ),
        // Deterministic Research Analyst fake. Deliberately returns bad
        // output the processor must reject on its own, rather than
        // trusting the model: an id that was never sent, a repeated id,
        // an overreaching claim, and conflicts that don't span two
        // distinct valid sources.
        analyzeResearch: jest.fn().mockImplementation(
          async (input: { evidence: { id: string; sourceTitle: string }[] }) => {
            const from = (title: string) => input.evidence.filter((e) => e.sourceTitle === title);
            const [a1, a2] = from('Effects of distributed teams on cohesion');
            const [b1] = from('Remote teams and cohesion: a replication');
            return {
              claims: [
                {
                  statement: 'Grounded fake claim.',
                  claimType: 'descriptive',
                  status: 'CONFLICTED',
                  confidence: 0.6,
                  evidenceLinks: [
                    { evidenceId: a1.id, relationship: 'SUPPORTS' },
                    { evidenceId: a1.id, relationship: 'QUALIFIES' }, // repeated id: must not crash the run
                    { evidenceId: b1.id, relationship: 'CONTRADICTS' },
                    { evidenceId: 'bogus-evidence-id', relationship: 'SUPPORTS' },
                  ],
                },
                {
                  statement: 'Ungrounded fake claim that must be dropped.',
                  status: 'SUPPORTED',
                  confidence: 0.9,
                  evidenceLinks: [{ evidenceId: 'bogus-evidence-id', relationship: 'SUPPORTS' }],
                },
                {
                  // Has a genuinely valid evidence link (passes the
                  // id-check), but checkClaimGrounding's fake above
                  // always marks this specific statement ungrounded —
                  // the exact failure mode a live run found: a real
                  // evidence id, but wording that overreaches it.
                  statement: 'Overreaching claim: valid id but ungrounded wording.',
                  status: 'SUPPORTED',
                  confidence: 0.9,
                  evidenceLinks: [{ evidenceId: a2.id, relationship: 'SUPPORTS' }],
                },
              ],
              researchGaps: [{ description: 'Fake gap for e2e determinism.', confidence: 0.5 }],
              researchConflicts: [
                {
                  description: 'Valid cross-source conflict.',
                  context: 'Fake difference: different samples.',
                  evidenceIds: [a1.id, b1.id],
                },
                {
                  description: 'Same-source conflict must be dropped.',
                  evidenceIds: [a1.id, a2.id],
                },
                {
                  description: 'Repeated-id conflict must be dropped.',
                  evidenceIds: [b1.id, b1.id],
                },
              ],
            };
          },
        ),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (createdEmails.length) {
      await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
    }
    await closeTestApp(app);
  });

  function extractSessionCookie(res: request.Response): string {
    const raw = res.get('set-cookie');
    const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const sessionCookie = cookies.find((c: string) => c.startsWith('project_ai_sid='));
    if (!sessionCookie) throw new Error('No session cookie set on response');
    return sessionCookie.split(';')[0];
  }

  async function registerAndGetCookie(): Promise<string> {
    const email = uniqueEmail();
    createdEmails.push(email);
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password: 'correct horse battery staple' })
      .expect(201);
    return extractSessionCookie(res);
  }

  async function pollRunUntilTerminal(
    cookie: string,
    runId: string,
    timeoutMs = 10000,
  ): Promise<{ status: string }> {
    const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/research-runs/${runId}`)
        .set('Cookie', cookie)
        .expect(200);
      if (terminal.has(res.body.status)) return res.body;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Research run ${runId} did not reach a terminal status in time`);
  }

  it('runs the full pipeline: plan -> run -> events -> deduped, evaluated sources', async () => {
    const cookie = await registerAndGetCookie();

    const projectRes = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('Cookie', cookie)
      .send({ name: 'Remote Work Study', type: 'ACADEMIC' })
      .expect(201);
    const projectId = projectRes.body.id;

    const planRes = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/research-plans`)
      .set('Cookie', cookie)
      .send({
        mainQuestion: 'How does remote work affect team cohesion?',
        keywords: ['remote work', 'team cohesion'],
      })
      .expect(201);
    expect(planRes.body.version).toBe(1);

    const runRes = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/research-runs`)
      .set('Cookie', cookie)
      .send({ researchPlanId: planRes.body.id })
      .expect(201);
    expect(runRes.body.status).toBe('QUEUED');
    const runId = runRes.body.id;

    const finalRun = await pollRunUntilTerminal(cookie, runId);
    expect(finalRun.status).toBe('COMPLETED');

    const eventsRes = await request(app.getHttpServer())
      .get(`/api/v1/research-runs/${runId}/events`)
      .set('Cookie', cookie)
      .expect(200);
    const eventTypes = eventsRes.body.map((e: { type: string }) => e.type);
    expect(eventTypes).toEqual([
      'queued',
      'planning',
      'searching',
      'evaluating',
      'retrieving',
      'retrieved',
      'extracting',
      'building_knowledge',
      'completed',
    ]);

    const sourcesRes = await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/sources`)
      .set('Cookie', cookie)
      .expect(200);
    expect(sourcesRes.body).toHaveLength(4);

    const highRelevance = sourcesRes.body.find(
      (s: { title: string }) => s.title === 'Effects of distributed teams on cohesion',
    );
    expect(highRelevance.evaluationStatus).toBe('ACCEPTED');
    expect(highRelevance.doi).toBe('10.1234/example.001');
    expect(highRelevance.provider).toBe('SEMANTIC_SCHOLAR');
    // No openAccessPdfUrl in this fixture and no url either -> falls
    // back to the abstract per SourceDocumentService.retrieveAcademic.
    expect(highRelevance.document.status).toBe('ABSTRACT_ONLY');

    const govReport = sourcesRes.body.find(
      (s: { title: string }) => s.title === 'Remote work and team cohesion: a field study',
    );
    expect(govReport.evaluationStatus).toBe('ACCEPTED');
    expect(govReport.provider).toBe('TAVILY');
    // Fixture URL doesn't resolve to a real page -> web sources never
    // fall back to their Tavily snippet, so this is FAILED, not
    // ABSTRACT_ONLY, even though an abstract-like snippet exists.
    expect(govReport.document.status).toBe('FAILED');

    const lowRelevance = sourcesRes.body.find(
      (s: { title: string }) => s.title === 'Loosely related blog post about work culture',
    );
    expect(lowRelevance.evaluationStatus).toBe('NEEDS_REVIEW');
    // NEEDS_REVIEW sources are never sent through full-text retrieval.
    expect(lowRelevance.document).toBeNull();

    const replication = sourcesRes.body.find(
      (s: { title: string }) => s.title === 'Remote teams and cohesion: a replication',
    );
    expect(replication.evaluationStatus).toBe('ACCEPTED');
    expect(replication.document.status).toBe('ABSTRACT_ONLY');

    // Evidence: only sources whose retrieval actually succeeded (COMPLETED
    // or ABSTRACT_ONLY) can produce evidence. highRelevance and
    // replication are ABSTRACT_ONLY -> evidence (2 + 1 fake items).
    // govReport is ACCEPTED but its retrieval FAILED -> must have zero
    // evidence despite having an abstract-like snippet on the Source row
    // (discovery metadata, not usable material, once retrieval failed).
    // lowRelevance is NEEDS_REVIEW -> never even attempted.
    const evidenceRes = await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/evidence`)
      .set('Cookie', cookie)
      .expect(200);
    expect(evidenceRes.body).toHaveLength(3);
    const evidenceSourceIds = evidenceRes.body.map((e: { sourceId: string }) => e.sourceId);
    expect(evidenceSourceIds).toContain(highRelevance.id);
    expect(evidenceSourceIds).toContain(replication.id);
    expect(evidenceSourceIds).not.toContain(govReport.id);
    expect(evidenceSourceIds).not.toContain(lowRelevance.id);
    for (const e of evidenceRes.body) {
      expect([highRelevance.id, replication.id]).toContain(e.sourceId);
      expect(e.confidence).toBeGreaterThanOrEqual(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
      // Both sources are ABSTRACT_ONLY -> every item must carry that limitation.
      expect(e.limitations).toMatch(/abstract only/i);
    }
    // A limitation the source itself stated is preserved next to it.
    expect(
      evidenceRes.body.some((e: { limitations: string }) =>
        e.limitations.includes('Fake source-stated limitation.'),
      ),
    ).toBe(true);

    const evidenceA = evidenceRes.body.filter(
      (e: { sourceId: string }) => e.sourceId === highRelevance.id,
    );
    const evidenceB = evidenceRes.body.filter(
      (e: { sourceId: string }) => e.sourceId === replication.id,
    );
    expect(evidenceA).toHaveLength(2);
    expect(evidenceB).toHaveLength(1);
    const evidenceIdsA: string[] = evidenceA.map((e: { id: string }) => e.id);
    const evidenceIdB: string = evidenceB[0].id;

    // Research Analyst output. The fake returned 2 claims, 1 gap and 3
    // conflicts, several of them bad. The processor's own checks must:
    //  - keep the grounded claim with exactly 2 links: the repeated id
    //    collapsed to its first link (SUPPORTS) and the bogus id removed;
    //  - drop the claim whose only link was bogus;
    //  - store the gap as LIMITED_EVIDENCE_FOUND (fixed in code);
    //  - keep only the conflict spanning two different sources, with both
    //    of its evidence links, and drop the same-source and repeated-id
    //    conflicts.
    const claimsRes = await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/claims`)
      .set('Cookie', cookie)
      .expect(200);
    expect(claimsRes.body).toHaveLength(1);
    expect(claimsRes.body.map((c: { statement: string }) => c.statement)).not.toContain(
      'Overreaching claim: valid id but ungrounded wording.',
    );
    expect(claimsRes.body[0].statement).toBe('Grounded fake claim.');
    expect(claimsRes.body[0].status).toBe('CONFLICTED');
    expect(claimsRes.body[0].evidence).toHaveLength(2);
    const claimLinkByEvidence = Object.fromEntries(
      claimsRes.body[0].evidence.map((l: { evidenceId: string; relationship: string }) => [
        l.evidenceId,
        l.relationship,
      ]),
    );
    expect(Object.keys(claimLinkByEvidence)).not.toContain('bogus-evidence-id');
    expect(claimLinkByEvidence[evidenceIdB]).toBe('CONTRADICTS');
    const linkedA = evidenceIdsA.filter((id) => claimLinkByEvidence[id]);
    expect(linkedA).toHaveLength(1);
    expect(claimLinkByEvidence[linkedA[0]]).toBe('SUPPORTS');

    const gapsRes = await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/research-gaps`)
      .set('Cookie', cookie)
      .expect(200);
    expect(gapsRes.body).toHaveLength(1);
    expect(gapsRes.body[0].description).toBe('Fake gap for e2e determinism.');
    expect(gapsRes.body[0].type).toBe('LIMITED_EVIDENCE_FOUND');

    const conflictsRes = await request(app.getHttpServer())
      .get(`/api/v1/projects/${projectId}/research-conflicts`)
      .set('Cookie', cookie)
      .expect(200);
    expect(conflictsRes.body).toHaveLength(1);
    expect(conflictsRes.body[0].description).toBe('Valid cross-source conflict.');
    expect(conflictsRes.body[0].context).toBe('Fake difference: different samples.');
    expect(conflictsRes.body[0].resolutionStatus).toBe('UNRESOLVED');
    const conflictEvidenceIds: string[] = conflictsRes.body[0].evidence.map(
      (l: { evidenceId: string }) => l.evidenceId,
    );
    expect(conflictEvidenceIds).toHaveLength(2);
    expect(conflictEvidenceIds).toContain(evidenceIdB);
    expect(evidenceIdsA.filter((id) => conflictEvidenceIds.includes(id))).toHaveLength(1);
  }, 20000);

  it('rejects a research run for a plan with no mainQuestion or keywords', async () => {
    const cookie = await registerAndGetCookie();
    const projectRes = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('Cookie', cookie)
      .send({ name: 'Empty Plan Project', type: 'PROFESSIONAL' })
      .expect(201);

    const planRes = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectRes.body.id}/research-plans`)
      .set('Cookie', cookie)
      .send({})
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectRes.body.id}/research-runs`)
      .set('Cookie', cookie)
      .send({ researchPlanId: planRes.body.id })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it("404s a research run belonging to another user's project", async () => {
    const ownerCookie = await registerAndGetCookie();
    const attackerCookie = await registerAndGetCookie();

    const projectRes = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('Cookie', ownerCookie)
      .send({ name: "Owner's research project", type: 'ACADEMIC' })
      .expect(201);
    const planRes = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectRes.body.id}/research-plans`)
      .set('Cookie', ownerCookie)
      .send({ mainQuestion: 'Owner-only question' })
      .expect(201);
    const runRes = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectRes.body.id}/research-runs`)
      .set('Cookie', ownerCookie)
      .send({ researchPlanId: planRes.body.id })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/api/v1/research-runs/${runRes.body.id}`)
      .set('Cookie', attackerCookie)
      .expect(404);
    await pollRunUntilTerminal(ownerCookie, runRes.body.id); // let the job finish so afterAll cleanup is tidy
  }, 15000);

  it(
    'cancelling a run before the worker finishes leaves it CANCELLED, not COMPLETED',
    async () => {
      const cookie = await registerAndGetCookie();
      const projectRes = await request(app.getHttpServer())
        .post('/api/v1/projects')
        .set('Cookie', cookie)
        .send({ name: 'Cancel Me Project', type: 'ACADEMIC' })
        .expect(201);
      const planRes = await request(app.getHttpServer())
        .post(`/api/v1/projects/${projectRes.body.id}/research-plans`)
        .set('Cookie', cookie)
        .send({ mainQuestion: 'A question about a run we will cancel' })
        .expect(201);
      const runRes = await request(app.getHttpServer())
        .post(`/api/v1/projects/${projectRes.body.id}/research-runs`)
        .set('Cookie', cookie)
        .send({ researchPlanId: planRes.body.id })
        .expect(201);

      // Cancel immediately — relies on the fake gateway's artificial delay
      // (400ms) to keep the job in flight past this point. This is
      // inherently timing-sensitive given BullMQ's async pickup; if it
      // ever flakes, that's a sign the delay margin needs widening, not
      // that the cancel logic itself is wrong (see research-runs.service.ts
      // and research-run.processor.ts for the actual cancel semantics).
      const cancelRes = await request(app.getHttpServer())
        .post(`/api/v1/research-runs/${runRes.body.id}/cancel`)
        .set('Cookie', cookie)
        .expect(201);
      expect(cancelRes.body.status).toBe('CANCELLED');

      const finalRun = await pollRunUntilTerminal(cookie, runRes.body.id);
      expect(finalRun.status).toBe('CANCELLED');
    },
    15000,
  );

  it('cannot cancel a run that already completed', async () => {
    const cookie = await registerAndGetCookie();
    const projectRes = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('Cookie', cookie)
      .send({ name: 'Already Done Project', type: 'ACADEMIC' })
      .expect(201);
    const planRes = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectRes.body.id}/research-plans`)
      .set('Cookie', cookie)
      .send({ mainQuestion: 'A question that will finish normally' })
      .expect(201);
    const runRes = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectRes.body.id}/research-runs`)
      .set('Cookie', cookie)
      .send({ researchPlanId: planRes.body.id })
      .expect(201);

    await pollRunUntilTerminal(cookie, runRes.body.id);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/research-runs/${runRes.body.id}/cancel`)
      .set('Cookie', cookie)
      .expect(409);
    expect(res.body.error.code).toBe('RESEARCH_RUN_NOT_CANCELLABLE');
  }, 15000);
});