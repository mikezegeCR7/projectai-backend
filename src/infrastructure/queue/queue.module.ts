import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RedisOptions } from 'ioredis';
import { RESEARCH_QUEUE_NAME } from './queue.constants';

/**
 * Full parse this time — the previous version only read hostname/port and
 * silently dropped username/password and the TLS flag, which breaks
 * against any provider that requires auth or TLS (e.g. Upstash, which
 * needs both). `rediss://` (double s) signals TLS; `redis://` does not.
 */
function parseRedisUrl(): RedisOptions {
  const raw = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const parsed = new URL(raw);

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    tls: parsed.protocol === 'rediss:' ? {} : undefined,
    // BullMQ requires this — without it, ioredis' default reconnect
    // behavior can interfere with how BullMQ manages blocking commands.
    maxRetriesPerRequest: null,
  };
}

@Module({
  imports: [
    BullModule.forRoot({
      connection: parseRedisUrl(),
    }),
    BullModule.registerQueue({
      name: RESEARCH_QUEUE_NAME,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}