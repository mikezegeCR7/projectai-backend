import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { RESEARCH_QUEUE_NAME } from '../../src/infrastructure/queue/queue.constants';
import { ResearchRunProcessor } from '../../src/modules/research-runs/processors/research-run.processor';

/**
 * Every e2e spec here loads the full AppModule, which always wires up
 * QueueModule (ResearchRunsModule depends on it) even in specs that never
 * touch the job queue. Nest's automatic onModuleDestroy for the BullMQ
 * Worker/Queue providers usually closes their Redis connections cleanly,
 * but under TLS (e.g. Upstash's rediss://) the low-level socket teardown
 * can take an extra tick and emit a stray 'error' event *after*
 * app.close() has already resolved and its listeners are gone — which
 * Node treats as an unhandled exception and kills the whole Jest process,
 * taking out whatever test file runs next. This is a known upstream
 * BullMQ+Jest interaction (TLS connections especially) —
 * https://github.com/nestjs/bull/issues/2138, tracing to
 * https://github.com/taskforcesh/bullmq/issues/2385 — not a bug in this
 * app's own logic.
 *
 * Mitigation: close both the Queue's and the Worker's own connections
 * explicitly first (each has its own more-thorough graceful close path
 * than the implicit one via app.close()) — the Worker's connection in
 * particular is the one the linked bullmq issue traces the stray event
 * to, and it previously only closed implicitly inside app.close()'s
 * Nest lifecycle hooks — then close the app, then give the socket a
 * brief grace period to finish tearing down before Jest moves on to the
 * next file. This is still a best-effort mitigation for a timing race,
 * not a guarantee; if it still flakes occasionally, that's the upstream
 * issue, not new breakage.
 */
export async function closeTestApp(app: INestApplication): Promise<void> {
  try {
    const queue = app.get<Queue>(getQueueToken(RESEARCH_QUEUE_NAME));
    await queue.close();
  } catch {
    // Queue token not resolvable (shouldn't happen given AppModule
    // always includes QueueModule, but never let cleanup itself throw).
  }
  try {
    const processor = app.get(ResearchRunProcessor);
    await processor.worker.close();
  } catch {
    // Same — don't let a missing/already-closed worker break teardown.
  }
  await app.close();
  await new Promise((resolve) => setTimeout(resolve, 500));
}