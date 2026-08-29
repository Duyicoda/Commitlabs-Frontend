type MarketplaceTelemetryEvent = {
  event: string;
  correlationId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  latencyMs?: number;
  errorCode?: string;
  message?: string;
  details?: Record<string, unknown>;
};

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'x-api-key',
  'buyeraddress',
  'selleraddress',
  'privatekey',
  'mnemonic',
]);

function redact(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, k),
      ]),
    );
  }
  return value;
}

export function emitMarketplaceTelemetry(event: MarketplaceTelemetryEvent): void {
  const safeDetails = redact(event.details);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
    details: safeDetails,
  });
  const status = event.statusCode ?? 0;
  if (status >= 500) {
    console.error(line);
  } else if (status >= 400) {
    console.warn(line);
  } else {
    console.info(line);
  }
}