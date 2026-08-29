import { NextRequest, NextResponse } from 'next/server';
import { ok, methodNotAllowed } from '@/lib/backend/apiResponse';
import { isFeatureEnabled } from '@/lib/backend/config';
import { assertMutationCsrf } from '@/lib/backend/csrf';
import { createCorsOptionsHandler, type CorsRoutePolicy } from '@/lib/backend/cors';
import { ValidationError } from '@/lib/backend/errors';
import { getClientIp } from '@/lib/backend/getClientIp';
import { parseJsonWithLimit, JSON_BODY_LIMITS } from '@/lib/backend/jsonBodyLimit';
import {
  getMarketplaceSortKeys,
  isMarketplaceSortBy,
  type MarketplaceCommitmentType,
  type MarketplacePublicListing,
} from '@/lib/backend/services/marketplace';
import { withApiHandler } from '@/lib/backend/withApiHandler';
import type { CreateListingRequest, CreateListingResponse } from '@/types/marketplace';
import { MARKETPLACE_RATE_LIMIT_ACTIONS } from '@/lib/marketplace/constants';
import { listMarketplaceListings, marketplaceService } from '@/lib/marketplace';
import { enforceMarketplaceRateLimit } from '@/lib/marketplace/rate-limit';
import { emitMarketplaceTelemetry } from '@/lib/marketplace/telemetry';
import { parseBoundedPagination, parseOptionalNumber } from '@/lib/marketplace/validation';

const COMMITMENT_TYPES: readonly MarketplaceCommitmentType[] = [
  'Safe',
  'Balanced',
  'Aggressive',
] as const;

interface ParseResult {
  type?: MarketplaceCommitmentType;
  minCompliance?: number;
  maxLoss?: number;
  minAmount?: number;
  maxAmount?: number;
  sortBy?: string;
  page?: number;
  pageSize?: number;
}

const MARKETPLACE_LISTINGS_CORS_POLICY = {
  GET: { access: 'public' },
  POST: { access: 'first-party' },
} satisfies CorsRoutePolicy;

export const OPTIONS = createCorsOptionsHandler(MARKETPLACE_LISTINGS_CORS_POLICY);

function toMarketplaceCard(listing: MarketplacePublicListing) {
  return {
    id: listing.listingId,
    type: listing.type,
    score: listing.complianceScore,
    amount: `$${listing.amount.toLocaleString()}`,
    duration: `${listing.remainingDays} days`,
    yield: `${listing.currentYield}%`,
    maxLoss: `${listing.maxLoss}%`,
    price: `$${listing.price.toLocaleString()}`,
  };
}

function parseType(searchParams: URLSearchParams): MarketplaceCommitmentType | undefined {
  const raw = searchParams.get('type');
  if (raw === null) return undefined;

  const normalized = raw.trim().toLowerCase();
  const mapping: Record<string, MarketplaceCommitmentType> = {
    safe: 'Safe',
    balanced: 'Balanced',
    aggressive: 'Aggressive',
  };

  if (!(normalized in mapping)) {
    throw new ValidationError(
      `Invalid 'type' query param. Allowed values: ${COMMITMENT_TYPES.join(', ')}.`,
    );
  }

  return mapping[normalized];
}

function parseQuery(searchParams: URLSearchParams): ParseResult {
  const minAmount = parseOptionalNumber(searchParams, 'minAmount');
  const maxAmount = parseOptionalNumber(searchParams, 'maxAmount');
  if (minAmount !== undefined && maxAmount !== undefined && minAmount > maxAmount) {
    throw new ValidationError(
      "Invalid amount filter. 'minAmount' cannot be greater than 'maxAmount'.",
    );
  }

  const sortBy = searchParams.get('sortBy') ?? undefined;
  if (sortBy && !isMarketplaceSortBy(sortBy)) {
    throw new ValidationError(
      `Invalid 'sortBy' query param. Allowed values: ${getMarketplaceSortKeys().join(', ')}.`,
    );
  }

  const { page, pageSize } = parseBoundedPagination(searchParams);

  return {
    type: parseType(searchParams),
    minCompliance: parseOptionalNumber(searchParams, 'minCompliance'),
    maxLoss: parseOptionalNumber(searchParams, 'maxLoss'),
    minAmount,
    maxAmount,
    sortBy,
    page,
    pageSize,
  };
}

export const GET = withApiHandler(
  async (req: NextRequest, _context, correlationId) => {
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
      await enforceMarketplaceRateLimit(ip, MARKETPLACE_RATE_LIMIT_ACTIONS.LIST);

      const { searchParams } = new URL(req.url);
      const filters = parseQuery(searchParams);
      const listings = await listMarketplaceListings(filters);

      const response = ok(
        {
          listings,
          cards: listings.map(toMarketplaceCard),
          total: listings.length,
        },
        undefined,
        200,
        correlationId,
      );
      emitMarketplaceTelemetry({
        event: 'marketplace.listings.get.success',
        correlationId,
        method: 'GET',
        path: '/api/marketplace/listings',
        statusCode: 200,
        latencyMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      const err = error as { code?: string; status?: number };
      emitMarketplaceTelemetry({
        event: 'marketplace.listings.get.failed',
        correlationId,
        method: 'GET',
        path: '/api/marketplace/listings',
        errorCode: err.code,
        statusCode: err.status ?? 500,
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  },
  { cors: MARKETPLACE_LISTINGS_CORS_POLICY, enableETag: true },
);

export const POST = withApiHandler(
  async (req: NextRequest, _context, correlationId) => {
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
      await enforceMarketplaceRateLimit(ip, MARKETPLACE_RATE_LIMIT_ACTIONS.CREATE);

      const body = await parseJsonWithLimit(req, {
        limitBytes: JSON_BODY_LIMITS.marketplaceListingsCreate,
      });

      if (!body || typeof body !== 'object') {
        throw new ValidationError('Request body must be an object');
      }

      const request = body as CreateListingRequest;
      const listing = await marketplaceService.createListing(request);
      const response: CreateListingResponse = { listing };
      const apiResponse = ok(response, undefined, 201, correlationId);
      emitMarketplaceTelemetry({
        event: 'marketplace.listings.post.success',
        correlationId,
        method: 'POST',
        path: '/api/marketplace/listings',
        statusCode: 201,
        latencyMs: Date.now() - startedAt,
      });
      return apiResponse;
    } catch (error) {
      const err = error as { code?: string; status?: number };
      emitMarketplaceTelemetry({
        event: 'marketplace.listings.post.failed',
        correlationId,
        method: 'POST',
        path: '/api/marketplace/listings',
        errorCode: err.code,
        statusCode: err.status ?? 500,
        latencyMs: Date.now() - startedAt,
      });
      throw error;
    }
  },
  { cors: MARKETPLACE_LISTINGS_CORS_POLICY },
);

const _405 = methodNotAllowed(['GET', 'POST']);
export { _405 as PUT, _405 as PATCH, _405 as DELETE };
