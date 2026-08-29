import { ConflictError, ForbiddenError, NotFoundError, TooManyRequestsError } from '@/lib/backend/errors';
import { transferOwnership } from '@/lib/backend/services/contracts';
import {
  listMarketplaceListings as backendListMarketplaceListings,
  marketplaceService as backendMarketplaceService,
  type MarketplaceCommitmentType,
  type MarketplacePublicListing,
} from '@/lib/backend/services/marketplace';
import type { CreateListingRequest } from '@/types/marketplace';
import { MARKETPLACE_MAX_CONCURRENT_PURCHASE_LOCKS } from '@/lib/marketplace/constants';
import { emitMarketplaceTelemetry } from '@/lib/marketplace/telemetry';

const purchaseLocks = new Map<string, Promise<unknown>>();

async function withPurchaseLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  if (!purchaseLocks.has(key) && purchaseLocks.size >= MARKETPLACE_MAX_CONCURRENT_PURCHASE_LOCKS) {
    throw new TooManyRequestsError('Too many concurrent purchase requests. Please try again later.');
  }
  const previous = purchaseLocks.get(key) ?? Promise.resolve();
  let release!(: void => void);
  const current = previous
    .catch(() => undefined)
    .then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .then(action);
  purchaseLocks.set(key, current);
  try {
    return await current;
  } finally {
    release?.();
    if (purchaseLocks.get(key) === current) {
      purchaseLocks.delete(key);
    }
  }
}

export const marketplaceService = {
  async createListing(request: CreateListingRequest) {
    return backendMarketplaceService.createListing(request);
  },

  async getListing(listingId: string) {
    return backendMarketplaceService.getListing(listingId);
  },

  async completePurchase(listingId: string, buyerAddress: string) {
    return backendMarketplaceService.completePurchase(listingId, buyerAddress);
  },

  async purchaseListing({
    listingId,
    buyerAddress,
    correlationId,
  }: {
    listingId: string;
    buyerAddress: string;
    correlationId?: string;
  }) {
    return withPurchaseLock(listingId, async () => {
      const startedAt = Date.now();
      try {
        const listing = await backendMarketplaceService.getListing(listingId);
        if (!listing) {
          throw new NotFoundError('Listing', { listingId });
        }
        if (listing.status !== 'Active') {
          throw new ConflictError('Only active listings can be purchased', {
            listingId,
            currentStatus: listing.status,
          });
        }
        if (listing.sellerAddress === buyerAddress) {
          throw new ForbiddenError('Cannot purchase your own listing', { listingId });
        }

        const transfer = await transferOwnership({
          commitmentId: listing.commitmentId,
          fromAddress: listing.sellerAddress,
          toAddress: buyerAddress,
        });

        let purchasedListing: MarketplacePublicListing | null;
        try {
          purchasedListing = await backendMarketplaceService.completePurchase(listingId, buyerAddress);
        } catch (error) {
          const refreshed = await backendMarketplaceService.getListing(listingId);
          if (refreshed && refreshed.sellerAddress === buyerAddress && refreshed.status !== 'Active') {
            purchasedListing = refreshed;
          } else {
            throw error;
          }
        }

        emitMarketplaceTelemetry({
          event: 'marketplace.purchase.succeeded',
          correlationId,
          latencyMs: Date.now() - startedAt,
          details: { listingId },
        });

        return {
          listing: purchasedListing!,
          transfer,
          commitmentId: listing.commitmentId,
          sellerAddress: listing.sellerAddress,
        };
      } catch (error) {
        const err = error as { code?: string; status?: number };
        emitMarketplaceTelemetry({
          event: 'marketplace.purchase.failed',
          correlationId,
          errorCode: err.code,
          statusCode: err.status ?? 500,
          latencyMs: Date.now() - startedAt,
          details: { listingId },
        });
        throw error;
      }
    });
  },
};

export async function listMarketplaceListings(
  filters: {
    type?: MarketplaceCommitmentType | undefined;
    minCompliance?: number;
    maxLoss?: number;
    minAmount?: number;
    maxAmount?: number;
    sortBy?: string;
    page?: number;
    pageSize?: number;
  },
) {
  return backendListMarketplaceListings(filters);
}