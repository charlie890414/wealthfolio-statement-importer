import { describe, expect, it } from 'vitest';
import Big from 'big.js';
import { convert, detectBroker } from './converters';
import { activityFromSource, checkImportInBatches, mergeCheckedActivity } from './import';

const buy = (date: string, quantity: string, amount: string, deposit = '公提', symbol = '2330 台積電') =>
  ({ 日期: date, 類型: '買入', 股數: quantity, 申購金額: amount, 均價: '1', 提存別: deposit, 標的: symbol });
const transfer = (date: string, quantity: string, symbol = '2330 台積電', deposit = '公提') =>
  ({ 日期: date, 類型: '轉出', 股數: quantity, 申購金額: '', 均價: '', 提存別: deposit, 標的: symbol });

describe('ESPP separate contribution FIFO buys', () => {
  it('detects the updated consolidated format', () => {
    expect(detectBroker(['日期', '類型', '提存別', '股數', '均價', '申購金額', '標的']).broker).toBe('ctbc_espp');
  });

  it('keeps contribution cost pools separate across months', () => {
    const result = convert('ctbc_espp', [
      buy('2026/08/01', '2', '200'), buy('2026/08/01', '2', '600', '自提'),
      transfer('2026/08/02', '1'),
      buy('2026/09/01', '2', '400'),
      transfer('2026/09/02', '2'), transfer('2026/09/02', '2', '2330 台積電', '自提'),
    ].reverse());
    expect(result.activities).toHaveLength(2);
    expect(result.activities.find(row => row.date === '2026-09-02' && row.comment.includes('公提')))
      .toMatchObject({ quantity: '4', amount: '900', unitPrice: '225', activityType: 'BUY', fee: '0' });
    expect(result.activities[1].comment).toContain('自提');
    expect(result.issues).toEqual([expect.objectContaining({ message: expect.stringContaining('公提 尚未入庫 1 股，保留成本 200') })]);
  });

  it('does not borrow available shares from another contribution pool', () => {
    const result = convert('ctbc_espp', [buy('2026/01/01', '5', '100', '自提'), transfer('2026/01/02', '1')]);
    expect(result.activities).toEqual([]);
    expect(result.issues[0].message).toContain('公提');
    expect(result.issues[0].message).toContain('FIFO 僅有 0 股');
  });

  it('conserves cost when the final fractional allocation exhausts a lot', () => {
    const result = convert('ctbc_espp', [buy('2026/01/01', '3', '100'),
      transfer('2026/01/02', '1'), transfer('2026/01/03', '2')]);
    expect(result.issues).toEqual([]);
    expect(result.activities.reduce((sum, row) => sum.plus(row.amount), new Big(0)).toString()).toBe('100');
  });

  it('processes same-day buys before transfers and isolates securities', () => {
    const result = convert('ctbc_espp', [transfer('2026/01/01', '2'), buy('2026/01/01', '2', '30'),
      buy('2026/01/01', '1', '50', '自提', 'OTHER'), transfer('2026/01/01', '1', 'OTHER', '自提')]);
    expect(result.issues).toEqual([]);
    expect(result.activities.map((row) => row.amount)).toEqual(['30', '50']);
  });

  it('does not emit partial results when history is insufficient or malformed', () => {
    for (const rows of [
      [buy('2026/01/01', '1', '10'), transfer('2026/01/02', '1'), transfer('2026/01/03', '1')],
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

  it('preserves delivery economics through host validation', async () => {
    const source = convert('ctbc_espp', [buy('2026/01/01', '2', '30'), transfer('2026/01/02', '2')]).activities[0];
    const submitted = activityFromSource(source, 2, 'broker');
    const checked = await checkImportInBatches([submitted], async (rows) => rows.map((row) => ({ ...row, assetId: 'stock', unitPrice: '999' })));
    expect(mergeCheckedActivity(checked[0], submitted)).toMatchObject({ activityType: 'BUY', quantity: '2', unitPrice: '15', amount: '30', fee: '0' });
  });
});
