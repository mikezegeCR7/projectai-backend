import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { AiGatewayService } from '../src/infrastructure/ai/ai-gateway.service';
import { closeTestApp } from './helpers/close-test-app';

/**
 * Requires Postgres reachable (AppModule still wires up QueueModule for
 * the research-runs slice, so this needs Redis reachable too, even though
 * plan generation itself never touches the queue). AiGatewayService is
 * overridden with a single reusable jest.fn() — mockResolvedValueOnce /
 * mockRejectedValueOnce per test, rather than spinning up a second full
 * Nest app for the failure-path test. A second app means a second set of
 * real BullMQ/Redis connections, and closing two of them back-to-back
 * inside one test file (as an earlier version of this test did) can leave
 * a stray 'error' event firing after that app.close() already resolved —
 * which crashes the whole Jest process once forceExit tears it down,
 * taking out every test file queued after this one. One app, one mock,
 * reconfigured per test, avoids the whole class of problem.
 */
describe('Vertical Slice 4: AI Gateway — Planner role (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let planResearchMock: jest.Mock;
  const createdEmails: string[] = [];

  const uniqueEmail = () =>
    `slice4-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  const fakePlannerOutput = {
    mainQuestion: 'How does remote work affect team cohesion in mid-sized tech companies?',
    subQuestions: [
      'What communication patterns change under remote work?',
      'How is trust maintained without in-person contact?',
    ],
    keywords: ['remote work', 'team cohesion', 'distributed teams'],
    searchConcepts: ['remote work team cohesion study'],
    sourceTypes: ['journal_article', 'government_report'],
    inclusionCriteria: ['published after 2019', 'peer-reviewed or government source'],
    exclusionCriteria: ['opinion pieces with no data'],
    evidenceCategories: ['statistics', 'case studies'],
  };

  beforeAll(async () => {
    planResearchMock = jest.fn();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AiGatewayService)
      .useValue({ planResearch: planResearchMock })
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

  it('generates a research plan from a saved requirement', async () => {
    planResearchMock.mockResolvedValueOnce(fakePlannerOutput);
    const cookie = await registerAndGetCookie();

    const projectRes = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('Cookie', cookie)
      .send({ name: 'Remote Work Study', type: 'ACADEMIC' })
      .expect(201);
    const projectId = projectRes.body.id;

    await request(app.getHttpServer())
      .put(`/api/v1/projects/${projectId}/requirements`)
      .set('Cookie', cookie)
      .send({
        topic: 'Effects of remote work on team cohesion',
        academicLevel: 'undergraduate',
        discipline: 'organizational psychology',
      })
      .expect(200);

    const planRes = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectId}/research-plans/generate`)
      .set('Cookie', cookie)
      .expect(201);

    expect(planRes.body.mainQuestion).toBe(fakePlannerOutput.mainQuestion);
    expect(planRes.body.keywords).toEqual(fakePlannerOutput.keywords);
    expect(planRes.body.version).toBe(1);
    expect(planRes.body.status).toBe('DRAFT');

    // Generated plans persist through the same path as manual ones — a
    // second manual PATCH should still work on it.
    const patchRes = await request(app.getHttpServer())
      .patch(`/api/v1/research-plans/${planRes.body.id}`)
      .set('Cookie', cookie)
      .send({ status: 'READY' })
      .expect(200);
    expect(patchRes.body.status).toBe('READY');
  });

  it('fails clearly (502 AI_GENERATION_FAILED) when the AI Gateway errors', async () => {
    planResearchMock.mockRejectedValueOnce(new Error('provider unreachable'));
    const cookie = await registerAndGetCookie();

    const projectRes = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('Cookie', cookie)
      .send({ name: 'Will Fail Project', type: 'ACADEMIC' })
      .expect(201);

    await request(app.getHttpServer())
      .put(`/api/v1/projects/${projectRes.body.id}/requirements`)
      .set('Cookie', cookie)
      .send({ topic: 'A topic that will fail to plan' })
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectRes.body.id}/research-plans/generate`)
      .set('Cookie', cookie)
      .expect(502);
    expect(res.body.error.code).toBe('AI_GENERATION_FAILED');
  });

  it('404s generation for a project with no saved requirements yet', async () => {
    const cookie = await registerAndGetCookie();
    const projectRes = await request(app.getHttpServer())
      .post('/api/v1/projects')
      .set('Cookie', cookie)
      .send({ name: 'No Requirements Project', type: 'PROFESSIONAL' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post(`/api/v1/projects/${projectRes.body.id}/research-plans/generate`)
      .set('Cookie', cookie)
      .expect(404);
    expect(res.body.error.code).toBe('REQUIREMENTS_NOT_FOUND');
  });
});