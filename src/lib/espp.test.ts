import { describe, expect, it } from 'vitest';
import { parseCsv, rowsAsObjects } from './csv';
import { convert, detectBroker } from './converters';
import { activityFromSource, checkImportInBatches, mergeCheckedActivity } from './import';

const buy = (date: string, quantity: string, amount: string, deposit = '公提', symbol = '2330 台積電') =>
  ({ 日期: date, 類型: '買入', 股數: quantity, 申購金額: amount, 均價: '1', 提存別: deposit, 標的: symbol });
const transfer = (date: string, quantity: string, symbol = '2330 台積電', deposit = '公提') =>
  ({ 日期: date, 類型: '轉出', 股數: quantity, 申購金額: '', 均價: '', 提存別: deposit, 標的: symbol });

describe('ESPP purchase-date buys', () => {
  it('detects the updated consolidated format', () => {
    expect(detectBroker(['日期', '類型', '提存別', '股數', '均價', '申購金額', '標的']).broker).toBe('ctbc_espp');
  });

  it('converts the supplied consolidated CSV using actual subscription totals', () => {
    const parsed = parseCsv(`日期,類型,提存別,股數,均價,申購金額,標的
2026/09/01,買入,公提,1,2405.7156,2406,2330 台積電
2026/09/01,買入,自提,6,2405.7156,14434,2330 台積電
2026/08/03,買入,公提,1,2368.4603,2369,2330 台積電
2026/08/03,買入,自提,6,2368.4603,14211,2330 台積電
2026/07/01,買入,公提,1,2464.0394,2464,2330 台積電
2026/07/01,買入,自提,5,2464.0394,12320,2330 台積電
2026/06/01,買入,公提,1,2393.8840,2394,2330 台積電
2026/06/01,買入,自提,6,2393.8840,14363,2330 台積電
2026/05/04,買入,公提,1,2258.4638,2258,2330 台積電
2026/05/04,買入,自提,6,2258.4638,13551,2330 台積電
2026/04/01,買入,公提,1,1838.3255,1839,2330 台積電
2026/04/01,買入,自提,7,1838.3255,12868,2330 台積電
2026/03/02,買入,公提,1,1942.8859,1943,2330 台積電
2026/03/02,買入,自提,6,1942.8859,11657,2330 台積電
2026/02/02,買入,公提,2,1779.7106,3559,2330 台積電
2026/02/02,買入,自提,7,1779.7106,12458,2330 台積電
2026/01/02,買入,公提,1,1643.3942,1643,2330 台積電
2026/01/02,買入,自提,8,1643.3942,13147,2330 台積電
2025/12/01,買入,公提,2,1434.1127,2868,2330 台積電
2025/12/01,買入,自提,9,1434.1127,12907,2330 台積電
2025/11/03,買入,公提,1,1494.3267,1494,2330 台積電
2025/11/03,買入,自提,9,1494.3267,13449,2330 台積電
2025/10/01,買入,公提,2,1363.9593,2728,2330 台積電
2025/10/01,買入,自提,9,1363.9593,12276,2330 台積電
2025/09/01,買入,公提,2,1160.8396,2322,2330 台積電
2025/09/01,買入,自提,11,1160.8396,12769,2330 台積電
2025/08/01,買入,公提,2,1139.2930,2279,2330 台積電
2025/08/01,買入,自提,11,1139.2930,12532,2330 台積電
2025/07/01,買入,公提,2,1086.6022,2173,2330 台積電
2025/07/01,買入,自提,12,1086.6022,13039,2330 台積電
2025/06/02,買入,公提,2,964.7167,1929,2330 台積電
2025/06/02,買入,自提,13,964.7167,12541,2330 台積電`);
    expect(detectBroker(parsed.headers).broker).toBe('ctbc_espp');
    const result = convert('ctbc_espp', rowsAsObjects(parsed));
    expect(result.sourceRows).toBe(32);
    expect(result.issues).toEqual([]);
    expect(result.activities.map(({ date, quantity, amount }) => [date, quantity, amount])).toEqual([
      ['2025-06-02', '15', '14470'],
      ['2025-07-01', '14', '15212'],
      ['2025-08-01', '13', '14811'],
      ['2025-09-01', '13', '15091'],
      ['2025-10-01', '11', '15004'],
      ['2025-11-03', '10', '14943'],
      ['2025-12-01', '11', '15775'],
      ['2026-01-02', '9', '14790'],
      ['2026-02-02', '9', '16017'],
      ['2026-03-02', '7', '13600'],
      ['2026-04-01', '8', '14707'],
      ['2026-05-04', '7', '15809'],
      ['2026-06-01', '7', '16757'],
      ['2026-07-01', '6', '14784'],
      ['2026-08-03', '7', '16580'],
      ['2026-09-01', '7', '16840'],
    ]);
    expect(result.activities[15]).toMatchObject({ symbol: '2330', activityType: 'BUY',
      unitPrice: '2405.71428571', amount: '16840', currency: 'TWD', fee: '0' });
  });

  it('imports purchases on their purchase dates and merges contributions', () => {
    const result = convert('ctbc_espp', [
      buy('2026/08/01', '2', '200'), buy('2026/08/01', '2', '600', '自提'),
      transfer('2026/08/02', '1'), buy('2026/09/01', '2', '400'),
      transfer('2026/09/02', '200'),
    ].reverse());
    expect(result.issues).toEqual([]);
    expect(result.activities).toMatchObject([
      { date: '2026-08-01', quantity: '4', amount: '800', unitPrice: '200', activityType: 'BUY', fee: '0' },
      { date: '2026-09-01', quantity: '2', amount: '400', unitPrice: '200' },
    ]);
    expect(result.activities[0].comment).toContain('公提');
    expect(result.activities[0].comment).toContain('自提');
  });

  it('ignores transfers without requiring any purchase history or transfer fields', () => {
    const result = convert('ctbc_espp', [{ 類型: '轉出' }, transfer('2026/01/02', '100')]);
    expect(result.activities).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('imports undelivered purchases and isolates securities', () => {
    const result = convert('ctbc_espp', [buy('2026/01/01', '3', '100'),
      buy('2026/01/01', '1', '50', '自提', 'OTHER')]);
    expect(result.issues).toEqual([]);
    expect(result.activities).toMatchObject([
      { symbol: '2330', amount: '100', quantity: '3', unitPrice: '33.33333333' },
      { symbol: 'OTHER', amount: '50', quantity: '1', unitPrice: '50' },
    ]);
  });

  it('does not emit partial results when purchases are malformed', () => {
    for (const rows of [
      [buy('2026/01/01', '1', '10'), buy('2026/01/02', '1', '')],
      [buy('2026/01/01', '1', ''), transfer('2026/01/02', '1')],
      [buy('2026/01/01', '0', '10')],
      [buy('2026/02/30', '1', '10')],
      [{ ...buy('2026/01/01', '1', '10'), 類型: '其他' }],
      [{ ...buy('2026/01/01', '1', '10'), 提存別: '' }],
      [{ ...buy('2026/01/01', '1', '10'), 提存別: '自提-1' }],
    ]) {
      const result = convert('ctbc_espp', rows);
      expect(result.activities).toEqual([]);
      expect(result.issues.some((issue) => issue.severity === 'error' && issue.lineNumber)).toBe(true);
    }
  });

  it('preserves purchase economics through host validation', async () => {
    const source = convert('ctbc_espp', [buy('2026/01/01', '2', '30'), transfer('2026/01/02', '2')]).activities[0];
    const submitted = activityFromSource(source, 2, 'broker');
    const checked = await checkImportInBatches([submitted], async (rows) => rows.map((row) => ({ ...row, assetId: 'stock', unitPrice: '999' })));
    expect(mergeCheckedActivity(checked[0], submitted)).toMatchObject({ activityType: 'BUY', quantity: '2', unitPrice: '15', amount: '30', fee: '0' });
  });
});
