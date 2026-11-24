import { describe, expect, it } from 'vitest';
import { convert } from './converters';
import type { BrokerKind } from './types';
import { activityFromSource, mergeCheckedActivity } from './import';

const cases: Array<{ broker: BrokerKind; row: Record<string, string>; fields: string[] }> = [
  { broker: 'fubon', row: { 市場: 'GB', 買賣: 'B', 代碼: 'VWRA', 股數: '2', 價格: '100.1234', 應收付: '-201.5', 交割日: '20261116' }, fields: ['股數', '價格', '應收付'] },
  { broker: 'sinopac', row: { 成交日: '2026/11/16', 商品: '2330 台積電', 買賣: '現買', 數量: '2', 成交價: '100.1234', 應付金額: '201.5' }, fields: ['數量', '成交價', '應付金額'] },
  { broker: 'schwab', row: { Date: '11/16/2026', Action: 'Buy', Symbol: 'AAPL', Quantity: '2', Price: '$100.1234', Amount: '-$201.5' }, fields: ['Quantity', 'Price', 'Amount'] },
  { broker: 'fundrich', row: { 基金代碼: 'FUND', 交易類別: '申購', 交易日期: '2026-11-16', 淨值: '100.1234', 單位數: '2', 總金額: '201.5', '交易金額（含手續費）': '999' }, fields: ['單位數', '淨值', '總金額'] },
];

describe('independent source economics across brokers', () => {
  for (const { broker, row, fields } of cases) {
    it(`${broker} preserves independent source values through host validation`, () => {
      const result = convert(broker, [row]);
      expect(result.issues).toEqual([]);
      expect(result.activities[0]).toMatchObject({ quantity: '2', unitPrice: '100.1234', amount: '201.5' });
      const submitted = activityFromSource(result.activities[0], 1, 'account');
      expect(mergeCheckedActivity({ ...submitted, unitPrice: '999', amount: '999' }, submitted))
        .toMatchObject({ quantity: '2', unitPrice: '100.1234', amount: '201.5' });
    });
    for (const field of fields) {
      it(`${broker} rejects missing source ${field}`, () => {
        const result = convert(broker, [{ ...row, [field]: '' }]);
        expect(result.activities).toEqual([]);
        expect(result.issues.some((issue) => issue.severity === 'error')).toBe(true);
      });
    }
  }
  it('does not fabricate price or quantity for dividends', () => {
    const result = convert('schwab', [{ Date: '11/16/2026', Action: 'Cash Dividend', Symbol: 'AAPL', Quantity: '', Price: '', Amount: '$2.5' }]);
    expect(result.activities[0]).toMatchObject({ quantity: '', unitPrice: '', amount: '2.5' });
  });
  it('does not accept a host-derived amount when the source amount is absent', () => {
    const submitted = { accountId: 'account', activityType: 'DIVIDEND' as const, isValid: true, isDraft: false, amount: null };
    expect(mergeCheckedActivity({ ...submitted, amount: '999' }, submitted).amount).toBeNull();
  });
});
