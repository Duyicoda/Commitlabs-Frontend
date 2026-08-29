export const MARKETPLACE_DEFAULT_PAGE_SIZE = 10;
export const MARKETPLACE_MAX_PAGE_SIZE = 50;
export const MARKETPLACE_MAX_PAGE = 10000;
export const MARKETPLACE_LISTING_ID_MAX_LENGTH = 128;
export const MARKETPLACE_PURCHASE_JSON_BODY_LIMIT_BYTES = 4 * 1024;
export const MARKETPLACE_LISTING_JSON_BODY_LIMIT_BYTES = 64 * 1024;
export const MARKETPLACE_RATE_LIMIT_ACTIONS = {
  LIST: 'api/marketplace/listings',
  CREATE: 'api/marketplace/listings/create',
  PURCHASE: 'api/marketplace/listings/purchase',
  DEATIL: 'api/marketplace/listings/detail',
} as const;
export const MARKETPLACE_MAX_CONCURRENT_PURCHASE_LOCKS = 1000;