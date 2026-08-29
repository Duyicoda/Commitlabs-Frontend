import { NextRequest, NextResponse } from 'next/server';
import { ok, methodNotAllowed } from '@/lib/backend/apiResponse';
import { createCorsOptionsHandler, type CorsRoutePolicy } from '@/lib/backend/cors';
import { NotFoundError } from '@/lib/backend/errors';
import { getClientIp } from '@/lib/backend/getClientIp';
import { isFeatureEnabled } from '@/lib/backend/config';
import { withApiHandler } from '@/lib/backend/withApiHandler';
import { marketplaceService } from '@/lib/marketplace';
import { validateListingId } from '@/lib/marketplace/validation';
import { enforceMarketplaceRateLimit } from '@/lib/marketplace/rate-limit';
import { emitMarketplaceTelemetry } from '@/lib/marketplace/telemetry';
import { MARKETPLACE_RATE_LIMIT_ACTIONS } from '@/lib/marketplace/constants';

const MARKETPLACE_LISTING_DETAIL_CORS_POLICY = {
  GET: { access: 'public' },
} satisfies CorsRoutePolicy;

export const OPTIONS = createCorsOptionsHandler(MARKETPLACE_LISTING_DETAIL_CORS_POLICY);

export const GET = withApiHandler(
  async (req: NextRequest, { params }, correlationId) => {
    const startedAt = Date.now();
    try {
      if (!isFeatureEnabled('marketplace')) {
        return NextResponse.json(
          {
            error: {
              code: 'NOT_FOUND',
              message: 'Marketplace feature is disabled.',
              details: { feature: 'marketplace' },
            },
          },
          { status: 404 },
        );
      }

      const ip = getClientIp(req);
      await enforceMarketplaceRateLimit(ip, MARKETPLACE_RATE_LIMIT_ACTIONS.DETAIL);

      const listingId = validateListingId(params.id);
      const listing = await marketplaceService.getListing(listingId);
      if (!listing) {
        throw new NotFoundError('Listing', { listingId });
      }

      const response = ok({ listing }, undefined, 200, correlationId);
      emitMarketplaceTelemetry({
        event: 'marketplace.listing.get.success',
        correlationId,
        method: 'GET',
        path: `/api/marketplace/listings/${listingId}`,
        statusCode: 200,
        latencyMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      const err = error as { code?: string; status?: number };
      emitMarketplaceTelemetry({
        event: 'marketplace.listing.get.failed',
        correlationId,
        method: 'GET',
        path: '/api/marketplace/listings/[id]',
        errorCode: err.code,
        statusCode: err.status ?? 500,
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  },
  { cors: MARKETPLACE_LISTING_DETAIL_CORS_POLICY, enableETag: true },
);

const _405 = methodNotAllowed(['GET']);
export { _405 as POST, _405 as PUT, _405 as PATCH, _405 as DELETE };