import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { PrismaService } from '../src/infrastructure/database/prisma.service';
import { closeTestApp } from './helpers/close-test-app';

/**
 * Exercises the real chain end to end — HTTP → controller → guard →
 * service → Prisma → Postgres → response — for the whole of vertical
 * slice 1. Per ENGINEERING-RULES.md, a route existing or a controller
 * compiling doesn't count; this is what "done" is checked against.
 *
 * Requires a running Postgres reachable via DATABASE_URL with migrations
 * applied (see README.md "Running locally").
 */
describe('Vertical Slice 1: auth -> project -> requirements (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const uniqueEmail = () =>
    `slice1-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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
    await closeTestApp(app);
  });

  // Track emails created in this run so we can clean up without touching
  // any other data that might exist in the target database.
  const createdEmails: string[] = [];
  afterAll(async () => {
    if (createdEmails.length) {
      await prisma.user.deleteMany({
        where: { email: { in: createdEmails } },
      });
    }
  });

  function extractSessionCookie(res: request.Response): string {
    const raw = res.get('set-cookie');
    const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const sessionCookie = cookies.find((c: string) =>
      c.startsWith('project_ai_sid='),
    );
    if (!sessionCookie) {
      throw new Error('No session cookie set on response');
    }
    return sessionCookie.split(';')[0];
  }

  describe('happy path', () => {
    const email = uniqueEmail();
    const password = 'correct horse battery staple';
    let sessionCookie: string;
    let projectId: string;

    it('registers a new user and sets a session cookie', async () => {
      createdEmails.push(email);
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password, firstName: 'Ada' })
        .expect(201);

      expect(res.body.user.email).toBe(email);
      expect(res.body.user.passwordHash).toBeUndefined();
      sessionCookie = extractSessionCookie(res);
    });

    it('GET /auth/me returns the authenticated user', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', sessionCookie)
        .expect(200);

      expect(res.body.user.email).toBe(email);
    });

    it('creates a project owned by the user', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/projects')
        .set('Cookie', sessionCookie)
        .send({ name: 'Effects of Remote Work', type: 'ACADEMIC' })
        .expect(201);

      expect(res.body.name).toBe('Effects of Remote Work');
      expect(res.body.status).toBe('ACTIVE');
      projectId = res.body.id;
    });

    it('lists the project back', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/projects')
        .set('Cookie', sessionCookie)
        .expect(200);

      expect(res.body.items.some((p: { id: string }) => p.id === projectId)).toBe(
        true,
      );
    });

    it('saves requirements (Research Brief) for the project', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/v1/projects/${projectId}/requirements`)
        .set('Cookie', sessionCookie)
        .send({
          topic: 'Effects of remote work on team cohesion',
          academicLevel: 'undergraduate',
          citationStyle: 'APA',
          wordCount: 5000,
        })
        .expect(200);

      expect(res.body.topic).toBe(
        'Effects of remote work on team cohesion',
      );
      expect(res.body.version).toBe(1);
    });

    it('retrieves the saved requirements', async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/projects/${projectId}/requirements`)
        .set('Cookie', sessionCookie)
        .expect(200);

      expect(res.body.citationStyle).toBe('APA');
    });

    it('re-saving requirements increments version (idempotent PUT, versioned)', async () => {
      const res = await request(app.getHttpServer())
        .put(`/api/v1/projects/${projectId}/requirements`)
        .set('Cookie', sessionCookie)
        .send({ topic: 'Effects of remote work on team cohesion, revised' })
        .expect(200);

      expect(res.body.version).toBe(2);
    });

    it('logs out and invalidates the session', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', sessionCookie)
        .expect(204);

      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', sessionCookie)
        .expect(401);
    });
  });

  describe('failure paths', () => {
    it('rejects requests with no session cookie (401 UNAUTHENTICATED)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/v1/projects')
        .expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects registration with an invalid payload (400 VALIDATION_FAILED)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: 'not-an-email', password: 'short' })
        .expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('rejects duplicate registration with the same email (409)', async () => {
      const email = uniqueEmail();
      createdEmails.push(email);
      const password = 'correct horse battery staple';

      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password })
        .expect(409);
      expect(res.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('rejects login with the wrong password (401 INVALID_CREDENTIALS)', async () => {
      const email = uniqueEmail();
      createdEmails.push(email);
      const password = 'correct horse battery staple';
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email, password: 'wrong password entirely' })
        .expect(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('404s a project that does not exist', async () => {
      const email = uniqueEmail();
      createdEmails.push(email);
      const registerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'correct horse battery staple' })
        .expect(201);
      const cookie = extractSessionCookie(registerRes);

      const res = await request(app.getHttpServer())
        .get('/api/v1/projects/nonexistent-id')
        .set('Cookie', cookie)
        .expect(404);
      expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');
    });

    it("404s (not 403) when accessing another user's project — never confirms the ID is valid", async () => {
      const ownerEmail = uniqueEmail();
      const attackerEmail = uniqueEmail();
      createdEmails.push(ownerEmail, attackerEmail);
      const password = 'correct horse battery staple';

      const ownerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: ownerEmail, password })
        .expect(201);
      const ownerCookie = extractSessionCookie(ownerRes);

      const projectRes = await request(app.getHttpServer())
        .post('/api/v1/projects')
        .set('Cookie', ownerCookie)
        .send({ name: "Owner's private project", type: 'ACADEMIC' })
        .expect(201);
      const otherProjectId = projectRes.body.id;

      const attackerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email: attackerEmail, password })
        .expect(201);
      const attackerCookie = extractSessionCookie(attackerRes);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/projects/${otherProjectId}`)
        .set('Cookie', attackerCookie)
        .expect(404);
      expect(res.body.error.code).toBe('PROJECT_NOT_FOUND');

      // Same guard must also protect nested routes like requirements.
      await request(app.getHttpServer())
        .get(`/api/v1/projects/${otherProjectId}/requirements`)
        .set('Cookie', attackerCookie)
        .expect(404);
    });

    it('404s GET requirements before any have been saved', async () => {
      const email = uniqueEmail();
      createdEmails.push(email);
      const registerRes = await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password: 'correct horse battery staple' })
        .expect(201);
      const cookie = extractSessionCookie(registerRes);

      const projectRes = await request(app.getHttpServer())
        .post('/api/v1/projects')
        .set('Cookie', cookie)
        .send({ name: 'Fresh project', type: 'PROFESSIONAL' })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/projects/${projectRes.body.id}/requirements`)
        .set('Cookie', cookie)
        .expect(404);
      expect(res.body.error.code).toBe('REQUIREMENTS_NOT_FOUND');
    });
  });
});