import { createHash } from 'crypto';
import { TooManyRequestsError } from '@/lib/backend/errors';import { checkRateLimit, getRateLimitWindowSeconds } from '@/lib/backend/rateLimit';

/**
 * Market rate-limit enforcement with operational visibility and bounded retry values.
 *
 * Invariants:
 * - `ip` and `action` must be non-empty strings; otherwise this is a programming error.
 * - Retry-after is sanitized to a positive integer within [1, 3600] seconds, preventing client
 *   confusion and unbounded wait times.
 * - Rate-limit events are logged with an anonymized IP hash to aid diagnosis without leaking PII.
 */
export async function enforceMarketplaceRateLimit(ip: string, action: string): Promise<void> {
  if (!ip || typeof ip !== 'string') {
    throw new Error('Marketplace rate-limit: ip must be a non-empty string');
  }
  if (!action || typeof action !== 'string') {
    throw new Error('Marketplace rate-limit: action must be a non-empty string');
  }

  const allowed = await checkRateLimit(ip, action);
  if (!allowed) {
    const rawRetryAfter = getRateLimitWindowSeconds(action);
    // Bound the retry-after value to a sane range.
    const retryAfterSeconds = Math.min(Math.max(1, Math.floor(rawRetryAfter)), 3600);

    // Emit structured diagnostic event (anonymized IP).
    const ipHash = createHash('sha256').update(ip).digest('hex').slice(0, 16);
    console.info(
      JSON.stringify({
        event: 'marketplace.rate_limit_exceeded',
        action,
        ipHash,
        retryAfterSeconds,
        timestamp: new Date().toISOString(),
      }),
    );

    throw new TooManyRequestsError(
      'Too many requests. Please try again later.',
      undefined,
      retryAfterSeconds,
    );
  }
}
