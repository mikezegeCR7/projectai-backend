import { Injectable } from '@nestjs/common';

export interface FetchedPage {
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  body: string;
  byteSize: number;
}

export type PageFetchFailureReason =
  | 'unsafe_url'
  | 'timeout'
  | 'too_many_redirects'
  | 'response_too_large'
  | 'unsupported_content_type'
  | 'http_error'
  | 'network_error';

export class PageFetchError extends Error {
  constructor(
    public readonly reason: PageFetchFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'PageFetchError';
  }
}

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 3_000_000; // 3MB — generous for an article/paper page, small enough to bound worker memory
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml'];
const USER_AGENT = 'ProjectAI-ResearchBot/1.0 (+source full-text retrieval)';

/**
 * Re-fetches a URL that Tavily/Semantic Scholar only discovered, per the
 * locked Slice 2 rule that a discovery snippet is never promoted to full
 * text. Implements the safety boundaries that decision explicitly calls
 * for: request timeout, redirect limit, response-size limit,
 * content-type validation, and a baseline SSRF guard. This is a
 * best-effort guard, not a full SSRF-hardened proxy — it blocks the
 * obvious cases (non-http(s) schemes, localhost, literal private/
 * loopback/link-local IPs) but does not defend against DNS rebinding.
 * Flagged as a known limitation rather than presented as complete.
 */
@Injectable()
export class PageFetcherService {
  async fetch(url: string): Promise<FetchedPage> {
    let currentUrl = url;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      this.assertSafeUrl(currentUrl);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(currentUrl, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': USER_AGENT },
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new PageFetchError(
            'timeout',
            `Request to ${currentUrl} timed out after ${REQUEST_TIMEOUT_MS}ms.`,
          );
        }
        throw new PageFetchError(
          'network_error',
          `Network error fetching ${currentUrl}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        clearTimeout(timeout);
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new PageFetchError(
            'http_error',
            `Redirect response from ${currentUrl} had no Location header.`,
          );
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (!response.ok) {
        throw new PageFetchError('http_error', `${currentUrl} returned HTTP ${response.status}.`);
      }

      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
        throw new PageFetchError(
          'unsupported_content_type',
          `${currentUrl} returned unsupported content-type "${contentType || 'unknown'}".`,
        );
      }

      const declaredLength = response.headers.get('content-length');
      if (declaredLength && Number(declaredLength) > MAX_RESPONSE_BYTES) {
        throw new PageFetchError(
          'response_too_large',
          `${currentUrl} declared ${declaredLength} bytes, exceeding the ${MAX_RESPONSE_BYTES}-byte limit.`,
        );
      }

      const { text, byteSize } = await this.readBounded(response, currentUrl);

      return {
        finalUrl: currentUrl,
        httpStatus: response.status,
        contentType,
        body: text,
        byteSize,
      };
    }

    throw new PageFetchError('too_many_redirects', `${url} exceeded ${MAX_REDIRECTS} redirects.`);
  }

  private assertSafeUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PageFetchError('unsafe_url', `"${url}" is not a valid URL.`);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new PageFetchError('unsafe_url', `"${url}" uses an unsupported scheme "${parsed.protocol}".`);
    }

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      throw new PageFetchError('unsafe_url', `"${url}" targets localhost.`);
    }

    if (this.isLiteralPrivateIp(hostname)) {
      throw new PageFetchError('unsafe_url', `"${url}" targets a private/loopback/link-local IP.`);
    }
  }

  private isLiteralPrivateIp(hostname: string): boolean {
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      if (a === 127) return true; // loopback
      if (a === 10) return true; // private
      if (a === 169 && b === 254) return true; // link-local
      if (a === 172 && b >= 16 && b <= 31) return true; // private
      if (a === 192 && b === 168) return true; // private
      if (a === 0) return true;
      return false;
    }
    if (hostname === '::1' || hostname === '[::1]') return true; // loopback
    return false;
  }

  private async readBounded(response: Response, url: string): Promise<{ text: string; byteSize: number }> {
    if (!response.body) {
      const text = await response.text();
      const byteSize = Buffer.byteLength(text);
      if (byteSize > MAX_RESPONSE_BYTES) {
        throw new PageFetchError('response_too_large', `${url} body exceeded the ${MAX_RESPONSE_BYTES}-byte limit.`);
      }
      return { text, byteSize };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new PageFetchError(
            'response_too_large',
            `${url} exceeded the ${MAX_RESPONSE_BYTES}-byte limit while streaming.`,
          );
        }
        chunks.push(value);
      }
    }
    const combined = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return { text: combined.toString('utf-8'), byteSize: total };
  }
}