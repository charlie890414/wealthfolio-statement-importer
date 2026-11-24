import { describe, expect, it } from 'vitest';
import { convert } from './converters';
const row = { Date: '11/12/2026 as of 11/11/2026', Action: 'Buy', Symbol: 'AAPL', Description: 'source', Quantity: '1', Price: '$10', Amount: '-$10', 'Fees & Comm': '' };

describe('Schwab source corporate actions', () => {
  it('uses the leading date with or without an as of date', () => {
    for (const Date of ['11/12/2026 as of 11/11/2026', '11/12/2026']) {
      const result = convert('schwab', [{ ...row, Date }]);
      expect(result.issues).toEqual([]);
      expect(result.activities[0].date).toBe('2026-11-12');
    }
  });
  it('imports original ADR fees and foreign taxes', () => {
    const result = convert('schwab', [
      { ...row, Action: 'ADR Mgmt Fee', Quantity: '', Price: '', Amount: '-$0.08' },
      { ...row, Action: 'Foreign Tax Paid', Quantity: '', Price: '', Amount: '-$0.09' },
    ]);
    expect(result.issues).toEqual([]);
    expect(result.activities).toMatchObject([
      { activityType: 'FEE', subtype: 'ADR_FEE', amount: '0.08', quantity: '', unitPrice: '' },
      { activityType: 'TAX', subtype: 'WITHHOLDING', amount: '0.09' },
    ]);
  });
  it('converts bond face units without changing quote or settlement', () => {
    const result = convert('schwab', [{ ...row, Symbol: '912797KZ9', Quantity: '3000', Price: '$99.5889', Amount: '-$2987.67' }]);
    expect(result.issues).toEqual([]);
    expect(result.activities[0]).toMatchObject({ instrumentType: 'BOND', quantity: '30', unitPrice: '99.5889', amount: '2987.67' });
  });
  it('pairs maturity face and cash only with an original source price', () => {
    const security = { ...row, Action: 'Full Redemption', Symbol: '912797KZ9', Quantity: '-3000', Price: '$100', Amount: '' };
    const cash = { ...security, Action: 'Full Redemption Adj', Quantity: '', Price: '', Amount: '$3000' };
    const result = convert('schwab', [cash, security]);
    expect(result.issues).toEqual([]);
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({ activityType: 'SELL', quantity: '30', unitPrice: '100', amount: '3000' });
    expect(convert('schwab', [cash, { ...security, Price: '' }]).activities).toEqual([]);
  });
  it('allows the par maturity exception with original principal and warns explicitly', () => {
    const security = { ...row, Action: 'Full Redemption', Symbol: '912797KZ9', Description: 'US TREASURY **MATURED**', Quantity: '-3000', Price: '', Amount: '' };
    const cash = { ...security, Action: 'Full Redemption Adj', Quantity: '', Amount: '$3000' };
    const result = convert('schwab', [cash, security]);
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({ activityType: 'SELL', quantity: '30', unitPrice: '100', amount: '3000', fee: '0' });
    expect(result.activities[0].comment).toContain('非CSV原始價格');
    expect(result.issues).toEqual([expect.objectContaining({ severity: 'warning' })]);
  });
  it('rejects non-par, fee-bearing, ambiguous or non-maturity fallback pairs', () => {
    const security = { ...row, Action: 'Full Redemption', Symbol: '912797KZ9', Description: 'US TREASURY **MATURED**', Quantity: '-3000', Price: '', Amount: '' };
    const cash = { ...security, Action: 'Full Redemption Adj', Quantity: '', Amount: '$3000' };
    for (const rows of [
      [security, { ...cash, Amount: '$2999.99' }],
      [security, { ...cash, 'Fees & Comm': '$0.01' }],
      [{ ...security, 'Fees & Comm': '$0.01' }, cash],
      [{ ...security, Description: 'redemption' }, { ...cash, Description: 'redemption' }],
      [{ ...security, Quantity: '3000' }, cash],
      [security, { ...cash, Amount: '-$3000' }],
      [security, cash, { ...cash }],
      [{ ...security, Amount: '$3000' }, cash],
    ]) {
      const result = convert('schwab', rows);
      expect(result.activities).toEqual([]);
      expect(result.issues.some((issue) => issue.severity === 'error')).toBe(true);
    }
  });
  it('closes assigned contracts once and keeps original stock settlement', () => {
    const assigned = { ...row, Action: 'Assigned', Symbol: 'UUUU 11/20/2026 12.00 P', Price: '', Amount: '' };
    const stock = { ...row, Symbol: 'UUUU', Quantity: '100', Price: '$12', Amount: '-$1200' };
    const result = convert('schwab', [assigned, stock]);
    expect(result.issues).toEqual([]);
    expect(result.activities).toHaveLength(2);
    expect(result.activities[0]).toMatchObject({ date: '2026-11-12', activityType: 'ADJUSTMENT', subtype: 'OPTION_EXPIRY', quantity: '1', unitPrice: '', amount: '' });
    expect(result.activities[1]).toMatchObject({ activityType: 'BUY', quantity: '100', unitPrice: '12', amount: '1200' });
    expect(convert('schwab', [assigned]).activities).toEqual([]);
  });
  it('uses the native expiry subtype and original contract quantity', () => {
    const result = convert('schwab', [{ ...row, Action: 'Expired', Symbol: 'UUUU 11/20/2026 12.00 P', Quantity: '2', Price: '', Amount: '' }]);
    expect(result.activities[0]).toMatchObject({ activityType: 'ADJUSTMENT', subtype: 'OPTION_EXPIRY', quantity: '2' });
  });
  it('requires an original split ratio rather than using delivered shares', () => {
    const split = { ...row, Action: 'Stock Split', Symbol: 'NVDA', Quantity: '6', Price: '$120.888', Amount: '' };
    expect(convert('schwab', [split]).activities).toEqual([]);
    const result = convert('schwab', [{ ...split, 'Split Ratio': '10' }]);
    expect(result.issues).toEqual([]);
    expect(result.activities[0]).toMatchObject({ activityType: 'SPLIT', quantity: '', unitPrice: '', amount: '10' });
  });
  it('infers the supplied NVDA split from whole and fractional deliveries', () => {
    const result = convert('schwab', [
      { ...row, Date: '06/13/2024 as of 06/10/2024', Action: 'Stock Split', Symbol: 'NVDA', Quantity: '0.3864', Price: '$125.20', Amount: '' },
      { ...row, Date: '06/10/2024 as of 06/07/2024', Action: 'Stock Split', Symbol: 'NVDA', Quantity: '6', Price: '$120.888', Amount: '' },
      { ...row, Date: '06/03/2024', Symbol: 'NVDA', Quantity: '0.7096', Price: '$1141.4059', Amount: '-$809.94' },
    ]);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    const splits = result.activities.filter((activity) => activity.activityType === 'SPLIT');
    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({ date: '2024-06-13', quantity: '', amount: '10', unitPrice: '' });
    expect(result.issues.some((issue) => issue.message.includes('0.7096'))).toBe(true);
  });
  it('does not round an inexact split ratio or assume a missing opening position', () => {
    for (const quantity of ['0', '0.71']) {
      const result = convert('schwab', [
        { ...row, Date: '06/03/2024', Symbol: 'NVDA', Quantity: quantity },
        { ...row, Date: '06/10/2024', Action: 'Stock Split', Symbol: 'NVDA', Quantity: '6.3864', Amount: '' },
      ]);
      expect(result.activities.some((activity) => activity.activityType === 'SPLIT')).toBe(false);
      expect(result.issues.some((issue) => issue.severity === 'error')).toBe(true);
    }
  });

});
