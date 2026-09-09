import { describe, expect, it, vi } from 'vitest';
import { resolveAssetTypesFromMarket, selectExactAssetResult } from './asset-types';
import type { NormalizedActivity } from './types';

const row = (symbol: string, currency = 'USD'): NormalizedActivity => ({
  date: '2026-09-04', symbol, instrumentType: 'EQUITY', quantity: '1', activityType: 'BUY',
  unitPrice: '1', currency, fee: '0', tax: '0', amount: '1', fxRate: '', subtype: '', comment: '', account: '',
});

describe('market asset type resolution', () => {
  it('requires one exact symbol and prefers the matching currency', () => {
    expect(selectExactAssetResult(row('VOO'), [
      { symbol: 'VOO', currency: 'MXN', quoteType: 'ETF' },
      { symbol: 'VOO', currency: 'USD', quoteType: 'ETF' },
    ])?.currency).toBe('USD');
    expect(selectExactAssetResult(row('VOO'), [
      { symbol: 'VOO', currency: 'USD' }, { symbol: 'VOO', currency: 'USD' },
    ])).toBeUndefined();
  });

  it('uses Wealthfolio quote types and falls back when lookup fails', async () => {
    const search = vi.fn(async (symbol: string) => {
      if (symbol === 'FAIL') throw new Error('offline');
      return [{ symbol, currency: 'USD', quoteType: symbol === 'SWVXX' ? 'MUTUALFUND' : 'ETF' }];
    });
    const result = await resolveAssetTypesFromMarket([row('VOO'), row('SWVXX'), row('FAIL')], search);
    expect(result.rows.map((item) => item.instrumentType)).toEqual(['ETF', 'FUND', 'EQUITY']);
    expect(result.resolved).toBe(2);
    expect(result.failed).toBe(1);
    expect(search).toHaveBeenCalledTimes(3);
  });
});
