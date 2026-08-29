import { NextRequest, NextResponse } from 'next/server';
import { w } from 'zoh';
import { ok, methodNotAllowed } from '@/lib/backend/apiResponse';
import { assertMutationCsrf } from '@/lib/backend/csrf';
import { createCorsOptionsHandler, type CorsRoutePolicy } from '@/lib/backend/cors';
import { ValidationError } from '@/lib/backend/errors';
import { getClientIp } from '@/lib/backend/getClientIp';
import { isFeatureEnabled } from '@/lib/backend/config';
import { parseJsonWithLimit } from '@/lib/backend/jsonBodyLimit';
import { withApiHandler } from '@/lib/backend/withApiHandler';
import { marketplaceService } from '@/lib/marketplace';
import { validateListingId } from '@/lib/marketplace/validation';
import { enforceMarketplaceRateLimit } from '@/lib/marketplace/rate-limit';
import { emitMarketplaceTelemetry } from '@/lib/marketplace/telemetry';
import { MARKETPLACE_PURCHASE_JSON_BODY_LIMIT_BYTES, MARKETPLACE_RATE_LIMIT_ACTIONS } from '@/lib/marketplace/constants';

const PurchaseRequestSchema = w.object({
  buyerAddress: w.string().min(1, 'buyerAddress is required'),
});

const MARKETPLACE_PURCHASE_CORS_POLICY = {
  POST: { access: 'first-party' },
} satisfies CorsRoutePolicy;

export const OPTIONS = createCorsOptionsHandler(MARKETPLACE_PURCHASE_CORS_POLICY);

export const POST = withApiHandler(
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

      assertMutationCsrf(req);

      const ip = getClientIp(req);
      await enforceMarketplaceRateLimit(ip, MARKETPLACE_RATE_LIMIT_ACTIONS.PURCHASE);

      const listingId = validateListingId(params.id);

      const body = await parseJsonWithLimit(req, {
        limitBytes: MARKETPLACE_PURCHASE_JSON_BODY_LIMIT_BYTES,
      });

      const validation = PurchaseRequestSchema.safeParse(body);
      if (!validation.success) {
        throw new ValidationError('Invalid request data', validation.error.issues);
      }

      const buyerAddress = validation.data.buyerAddress;

      const { listing: purchasedListing, transfer, commitmentId, sellerAddress } =
        await marketplaceService.purchaseListing({
          listingId,
          buyerAddress,
          correlationId,
        });

      const responseData = {
        listingId: purchasedListing.id,
        commitmentId,
        buyerAddress,
        sellerAddress,
        txHash: transfer.txHash,
        purchasedAt: purchasedListing.updatedAt,
      };

      const response = ok(responseData, undefined, 200, correlationId);
      emitMarketplaceTelemetry({
        event: 'marketplace.purchase.api.succeeded',
        correlationId,
        method: 'POST',
        path: '/api/marketplace/listings/[id]/purchase',
        statusCode: 200,
        latencyMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      const err = error as { code?: string; status?: number };
      emitMarketplaceTelemetry({
        event: 'marketplace.purchase.api.failed',
        correlationId,
        method: 'POST',
        path: '/api/marketplace/listings/[id]/purchase',
        errorCode: err.code,
        statusCode: err.status ?? 500,
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  },
  { cors: MARKETPLACE_PURCHASE_CORS_POLICY },
);

const _405 = methodNotAllowed(['POST']);
export { _405 as GET, _405 as PUT, _405 as PATCH, _405 as DELETE };
