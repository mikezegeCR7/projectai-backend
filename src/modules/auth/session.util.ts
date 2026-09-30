import { createHash, randomBytes } from 'crypto';

export const SESSION_COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ?? 'project_ai_sid';

export const SESSION_MAX_AGE_MS = Number(
  process.env.SESSION_MAX_AGE_MS ?? 7 * 24 * 60 * 60 * 1000, // 7 days
);

/** Raw token that goes in the cookie. Never stored or logged as-is. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** One-way hash stored in Session.tokenHash so a DB read can't leak usable tokens. */
export function hashSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
