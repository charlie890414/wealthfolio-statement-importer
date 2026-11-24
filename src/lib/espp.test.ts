import { describe, expect, it } from 'vitest';
import { parseCsv, rowsAsObjects } from './csv';
import { convert, detectBroker } from './converters';
import { activityFromSource, mergeCheckedActivity } from './import';

const buy = { 日期: '2026/11/02', 類型: '買入', 股數: '7', 均價: '2309.9996', 申購金額: '16170', 標的: '2330 台積電' };

describe('ESPP source economics', () => {
  it('imports the current six-column CSV without contribution fields or deriving values', () => {
    const parsed = parseCsv(`日期,類型,股數,均價,申購金額,標的
2026/11/02,買入,7,2309.9996,16170,2330 台積電
2026/10/01,買入,6,2524.2277,15145,2330 台積電`);
    expect(detectBroker(parsed.headers).broker).toBe('ctbc_espp');
    const result = convert('ctbc_espp', rowsAsObjects(parsed));
    expect(result.issues).toEqual([]);
    expect(result.activities).toHaveLength(2);
    expect(result.activities).toMatchObject([
      { quantity: '7', unitPrice: '2309.9996', amount: '16170' },
      { quantity: '6', unitPrice: '2524.2277', amount: '15145' },
    ]);
  });

  it('recognizes the current CSV but rejects its missing original total', () => {
    const parsed = parseCsv(`日期,類型,股數,均價,標的
2026/11/02,買入,7,2309.9996,2330 台積電`);
    expect(detectBroker(parsed.headers).broker).toBe('ctbc_espp');
    const result = convert('ctbc_espp', rowsAsObjects(parsed));
    expect(result.activities).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ severity: 'error', lineNumber: 2, message: expect.stringContaining('原始申購金額') })]);
  });

  it('preserves independent source price, quantity and total without merging or rounding', () => {
    const result = convert('ctbc_espp', [
      { ...buy, 提存別: '公提' },
      { ...buy, 股數: '6', 均價: '2524.2277', 申購金額: '15145.123456789', 提存別: '自提' },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.activities).toHaveLength(2);
    expect(result.activities).toMatchObject([
      { quantity: '7', unitPrice: '2309.9996', amount: '16170', activityType: 'BUY' },
      { quantity: '6', unitPrice: '2524.2277', amount: '15145.123456789' },
    ]);
    const submitted = activityFromSource(result.activities[0], 1, 'broker');
    expect(mergeCheckedActivity({ ...submitted, unitPrice: '999', amount: '999' }, submitted))
      .toMatchObject({ quantity: '7', unitPrice: '2309.9996', amount: '16170' });
  });

  it('rejects missing or invalid economics without returning partial activities', () => {
    for (const overrides of [{ 均價: '' }, { 申購金額: '' }, { 股數: '0' }, { 均價: '-1' }, { 申購金額: '0' }, { 日期: '2026/02/30' }, { 類型: '其他' }, { 提存別: '' }]) {
      const result = convert('ctbc_espp', [buy, { ...buy, ...overrides }]);
      expect(result.activities).toEqual([]);
      expect(result.issues.some((issue) => issue.severity === 'error' && issue.lineNumber === 3)).toBe(true);
    }
  });

  it('accepts legacy dates only when original totals are supplied', () => {
    const { 日期: _date, 類型: _type, ...fields } = buy;
    expect(convert('ctbc_espp', [{ ...fields, 買入日期: '2026/11/02' }]).activities[0])
      .toMatchObject({ date: '2026-11-02', unitPrice: '2309.9996', amount: '16170' });
    expect(convert('ctbc_espp', [{ 買入日期: '2026/11/02', 股數: '7', 均價: '2309.9996', 標的: '2330 台積電' }]).activities).toEqual([]);
  });

  it('ignores transfers without deriving buys or requiring missing transaction fields', () => {
    const result = convert('ctbc_espp', [{ 類型: '轉出' }]);
    expect(result.activities).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});
