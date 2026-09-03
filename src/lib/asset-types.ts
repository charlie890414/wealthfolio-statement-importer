import type { NormalizedActivity } from './types';

export interface MarketAssetResult {
  symbol: string;
  canonicalSymbol?: string;
  providerSymbol?: string;
  currency?: string;
  quoteType?: string;
}

const TYPE_MAP: Record<string, string> = {
  EQUITY: 'EQUITY',
  ETF: 'ETF',
  ETN: 'ETF',
  MUTUALFUND: 'FUND',
  MUTUAL_FUND: 'FUND',
  FUND: 'FUND',
  OPTION: 'OPTION',
  BOND: 'BOND',
};

const comparableSymbol = (value?: string) => (value || '').trim().toUpperCase().replace(/\s+/g, ' ');

export function selectExactAssetResult(
  row: NormalizedActivity,
  results: MarketAssetResult[],
): MarketAssetResult | undefined {
  const source = comparableSymbol(row.symbol);
  const exact = results.filter((result) =>
    [result.symbol, result.canonicalSymbol, result.providerSymbol].some((symbol) => comparableSymbol(symbol) === source),
  );
  const sameCurrency = exact.filter((result) => !result.currency || result.currency.toUpperCase() === row.currency.toUpperCase());
  const candidates = sameCurrency.length > 0 ? sameCurrency : exact;
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function normalizedMarketAssetType(quoteType?: string): string | undefined {
  return quoteType ? TYPE_MAP[quoteType.trim().toUpperCase()] : undefined;
}

export async function resolveAssetTypesFromMarket(
  rows: NormalizedActivity[],
  searchTicker: (query: string) => Promise<MarketAssetResult[]>,
): Promise<{ rows: NormalizedActivity[]; resolved: number; failed: number }> {
  const cache = new Map<string, Promise<MarketAssetResult[]>>();
  for (const row of rows) {
    if (row.symbol && !cache.has(row.symbol)) cache.set(row.symbol, searchTicker(row.symbol));
  }
  let resolved = 0;
  let failed = 0;
  const output = await Promise.all(rows.map(async (row) => {
    if (!row.symbol) return row;
    try {
      const result = selectExactAssetResult(row, await cache.get(row.symbol)!);
      const instrumentType = normalizedMarketAssetType(result?.quoteType);
      if (!instrumentType) return row;
      resolved += 1;
      return { ...row, instrumentType };
    } catch {
      failed += 1;
      return row;
    }
  }));
  return { rows: output, resolved, failed };
}
