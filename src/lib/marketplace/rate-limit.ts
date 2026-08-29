import { TooManyRequestsError } from '@/lib/backend/errors';
import { checkRateLimit, getRateLimitWindowSeconds } from '@/lib/backend/rateLimit';

export async function enforceMarketplaceRateLimit(ip: string, action: string): Promise<void> {
  const allowed = await checkRateLimit(ip, action);
  if (!allowed) {
    const retryAfterSeconds = getRateLimitWindowSeconds(action);
    throw new TooManyRequestsError(
      'Too many requests. Please try again later.',
      undefined,
      retryAfterSeconds,
    );
  }
}