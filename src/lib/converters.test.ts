import { describe, expect, it } from 'vitest';
import type { ActivityImport } from '@wealthfolio/addon-sdk';
import { convert, detectBroker, inferInstrumentType } from './converters';
import { parseCsv, stringifyActivities } from './csv';
import { activityFromSource, allImportRowNumbers, checkImportInBatches, dateInRange, mergeCheckedActivity, requireResolvedOption, selectImportRows } from './import';
import { markExistingDuplicates, sameDayNonDuplicateReason } from './dedupe';

const activity = (lineNumber: number) => ({
  accountId: 'account',
  activityType: 'BUY' as const,
  date: `2026-01-${String(lineNumber).padStart(2, '0')}`,
  isDraft: false,
  isValid: true,
  lineNumber,
  symbol: `SYM${lineNumber}`,
});

describe('activity import validation batching', () => {
  it('filters broker dates inclusively with optional bounds', () => {
    expect(dateInRange('2026-08-17', '2026-08-17', '2026-08-18')).toBe(true);
    expect(dateInRange('2026-08-18', '2026-08-17', '2026-08-18')).toBe(true);
    expect(dateInRange('2026-08-16', '2026-08-17', '')).toBe(false);
    expect(dateInRange('2026-08-19', '', '2026-08-18')).toBe(false);
    expect(dateInRange('not-a-date', '', '')).toBe(false);
  });

  it('keeps broker economics when host validation resolves the asset with a market quote', () => {
    const rows = convert('sinopac', [
      { 成交日: '2026/08/18', 商品: '009826 貝萊德世界股票', 買賣: '現買', 數量: '4000', 成交價: '10.2', 價金: '40800', 手續費: '13', 交易稅: '0', 應付金額: '40813', 應收金額: '0', 融資金額: '0', 保證金: '0', 利息: '0', 融券手續費: '0', 幣別: 'TWD' },
      { 成交日: '2026/08/18', 商品: '009826 貝萊德世界股票', 買賣: '現買', 數量: '1000', 成交價: '10.18', 價金: '10180', 手續費: '3', 交易稅: '0', 應付金額: '10183', 應收金額: '0', 融資金額: '0', 保證金: '0', 利息: '0', 融券手續費: '0', 幣別: 'TWD' },
      { 成交日: '2026/08/17', 商品: '009826 貝萊德世界股票', 買賣: '現買', 數量: '10000', 成交價: '10.28', 價金: '102800', 手續費: '33', 交易稅: '0', 應付金額: '102833', 應收金額: '0', 融資金額: '0', 保證金: '0', 利息: '0', 融券手續費: '0', 幣別: 'TWD' },
    ]).activities.map((row, index) => activityFromSource(row, index + 2, 'account'));
    const checked = rows.map((row) => ({
      ...row,
      assetId: 'asset-009826',
      symbol: '009826',
      exchangeMic: 'XTAI',
      quoteCcy: 'TWD',
      unitPrice: 10.14000034,
    }));

    const merged = checked.map((row, index) => mergeCheckedActivity(row, rows[index]));

    expect(merged.map(({ quantity, unitPrice, fee, amount }) => ({ quantity, unitPrice, fee, amount }))).toEqual([
      { quantity: '4000', unitPrice: '10.2', fee: '13', amount: '40813' },
      { quantity: '1000', unitPrice: '10.18', fee: '3', amount: '10183' },
      { quantity: '10000', unitPrice: '10.28', fee: '33', amount: '102833' },
    ]);
    expect(merged.every((row) => row.assetId === 'asset-009826' && row.exchangeMic === 'XTAI')).toBe(true);
  });

  it('submits a date as midnight in the configured local timezone', () => {
    const source = convert('fubon', [{ 市場: 'TW', 買賣: 'B', 代碼: '0050', 名稱: 'ETF', 股數: '1', 價格: '1', 價金: '1', 手續費: '0', 處理費: '0', 交易費: '0', 結算費: '0', 交易稅: '0', 印花稅: '0', 應收付: '-1', 幣別: 'TWD', 交割日: '20260729' }]).activities[0];
    const imported = activityFromSource(source, 2, 'account', 'Asia/Taipei');

    expect(imported.date).toBe('2026-07-28T16:00:00.000Z');
  });

  it('keeps row selection separate from validation input', () => {
    const rows = [activity(1), activity(2), activity(3)];
    const selected = new Set([1, 3]);
    expect(selectImportRows(rows, selected).map((row) => row.lineNumber)).toEqual([1, 3]);
    expect([...allImportRowNumbers(rows)]).toEqual([1, 2, 3]);
    expect(selectImportRows(rows, new Set()).length).toBe(0);
  });

  it('validates 250 activities sequentially in 50/50/50/50/50 batches and preserves order', async () => {
    const activities = Array.from({ length: 250 }, (_, index) => activity(index + 1));
    const calls: number[] = [];
    let active = 0;
    let maxActive = 0;
    const progress: number[] = [];

    const checked = await checkImportInBatches(activities, async (batch) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(batch.length);
      await Promise.resolve();
      active -= 1;
      return batch.map((item) => ({ ...item, symbol: `${item.symbol}-checked` }));
    }, (completed) => progress.push(completed));

    expect(calls).toEqual([50, 50, 50, 50, 50]);
    expect(maxActive).toBe(1);
    expect(progress).toEqual([50, 100, 150, 200, 250]);
    expect(checked.map((item) => item.lineNumber)).toEqual(activities.map((item) => item.lineNumber));
    expect(checked[0].symbol).toBe('SYM1-checked');
    expect(checked[249].symbol).toBe('SYM250-checked');
  });

  it('uses one request for 100 or fewer activities and none for an empty input', async () => {
    const calls: number[] = [];
    const check = async (batch: ActivityImport[]) => {
      calls.push(batch.length);
      return batch;
    };
    const activities = Array.from({ length: 100 }, (_, index) => activity(index + 1));

    await expect(checkImportInBatches(activities, check)).resolves.toHaveLength(100);
    await expect(checkImportInBatches([], check)).resolves.toEqual([]);
    expect(calls).toEqual([50, 50]);
  });

  it('stops at the failing batch and includes its range', async () => {
    const activities = Array.from({ length: 150 }, (_, index) => activity(index + 1));
    const calls: number[] = [];

    await expect(checkImportInBatches(activities, async (batch) => {
      calls.push(batch[0].lineNumber ?? 0);
      if (calls.length === 2) throw new Error('408 Request Timeout');
      return batch;
    })).rejects.toThrow('第 2/3 批（第 51-100 筆）失敗：408 Request Timeout');
    expect(calls).toEqual([1, 51]);
  });

  it('rejects a response whose length does not match the request', async () => {
    const activities = Array.from({ length: 2 }, (_, index) => activity(index + 1));

    await expect(checkImportInBatches(activities, async () => [activities[0]])).rejects.toThrow(
      '回傳筆數不符：送出 2 筆，收到 1 筆',
    );
  });

  it('rejects a response with an invalid SDK activity shape', async () => {
    const activities = [activity(1)];
    await expect(checkImportInBatches(activities, async () => [{ ...activities[0], isValid: 'yes' } as unknown as ActivityImport])).rejects.toThrow('回傳資料格式不符');
  });

  it('blocks an option whose asset was not resolved by the host', () => {
    const submitted = { ...activity(1), instrumentType: 'OPTION' } as ActivityImport;
    const unresolved = requireResolvedOption({ ...submitted }, submitted);
    const resolved = requireResolvedOption({ ...submitted, assetId: 'option-asset' }, submitted);

    expect(unresolved.isValid).toBe(false);
    expect(unresolved.errors?._optionAsset?.[0]).toContain('100 倍');
    expect(resolved.isValid).toBe(true);
  });
});

describe('CSV parsing', () => {
  it('handles BOM, quoted commas, escaped quotes and CRLF', () => {
    const parsed = parseCsv('\uFEFFDate,Description,Amount\r\n2026-01-01,"Fund, \'A\'","1,000"\r\n');
    expect(parsed.headers).toEqual(['Date', 'Description', 'Amount']);
    expect(parsed.rows[0]).toEqual(['2026-01-01', "Fund, 'A'", '1,000']);
  });

  it('rejects duplicate headers and rows with a different column count', () => {
    expect(() => parseCsv('Date,Date\n2026-01-01,ok\n')).toThrow('重複');
    expect(() => parseCsv('Date,Amount\n2026-01-01\n')).toThrow('欄位數不符');
  });
});

describe('broker converters', () => {
  it('does not guess broker asset types from symbols or descriptions', () => {
    expect(inferInstrumentType({ broker: 'fubon', symbol: '2330', name: '台積電', market: 'TW' })).toBe('');
    expect(inferInstrumentType({ broker: 'sinopac', symbol: '009826', name: 'ETF' })).toBe('');
    expect(inferInstrumentType({ broker: 'schwab', symbol: 'VOO', name: 'VANGUARD S&P 500 ETF' })).toBe('');
    expect(inferInstrumentType({ broker: 'schwab', symbol: 'AAPL', name: 'APPLE INC' })).toBe('');
    expect(inferInstrumentType({ broker: 'schwab', symbol: 'AAPL 11/20/2026 200 C', action: 'Sell to Open' })).toBe('OPTION');
  });
  it('detects all four source layouts', () => {
    expect(detectBroker(['市場', '買賣', '代碼', '名稱', '股數', '價格', '價金', '應收付', '幣別', '交割日']).broker).toBe('fubon');
    expect(detectBroker(['成交日', '商品', '買賣', '數量', '成交價', '價金', '應付金額', '應收金額', '幣別']).broker).toBe('sinopac');
    expect(detectBroker(['Date', 'Action', 'Symbol', 'Description', 'Quantity', 'Price', 'Fees & Comm', 'Amount']).broker).toBe('schwab');
    expect(detectBroker(['基金代碼', '交易類別', '基金名稱', '交易日期', '淨值', '交易金額（含手續費）', '單位數', '總金額', '交易狀態']).broker).toBe('fundrich');
    expect(detectBroker(['買入日期', '股數', '均價', '標的']).broker).toBe('ctbc_espp');
  });

  it('reports impossible calendar dates with the source line', () => {
    const result = convert('fubon', [{ 市場: 'TW', 買賣: 'B', 代碼: '0050', 股數: '1', 價格: '1', 應收付: '1', 幣別: 'TWD', 交割日: '20260230' }]);
    expect(result.activities).toHaveLength(0);
    expect(result.issues[0]).toMatchObject({ lineNumber: 2 });
  });

  it('converts Fubon buy with funding and market suffix', () => {
    const result = convert('fubon', [{ 市場: 'GB', 買賣: 'B', 代碼: 'FWRA.LSE1', 名稱: 'ETF', 股數: '2', 價格: '9.18', 價金: '18.36', 手續費: '1.38', 處理費: '0', 交易費: '0', 結算費: '0', 交易稅: '0', 印花稅: '0', 應收付: '-19.74', 幣別: 'USD', 交割日: '20260720' }]);
    expect(result.issues).toHaveLength(0);
    expect(result.activities.map((row) => row.activityType)).toEqual(['BUY']);
    expect(result.activities[0].symbol).toBe('FWRA.L');
    expect(result.activities[0].date).toBe('2026-07-20');
  });

  it('rejects Sinopac margin rows and emits sell withdrawal', () => {
    const result = convert('sinopac', [{ 成交日: '2026/08/18', 商品: '009826 貝萊德', 買賣: '現賣', 數量: '10', 成交價: '10', 價金: '100', 手續費: '1', 交易稅: '0', 應付金額: '0', 應收金額: '99', 融資金額: '0', 保證金: '0', 利息: '0', 融券手續費: '0', 幣別: 'TWD' }]);
    expect(result.activities.map((row) => row.activityType)).toEqual(['SELL']);
    const bad = convert('sinopac', [{ 成交日: '2026/08/18', 商品: '2330 台積電', 買賣: '現買', 數量: '1', 成交價: '1', 價金: '1', 應付金額: '1', 幣別: 'TWD', 融資金額: '1' }]);
    expect(bad.issues[0].message).toContain('融資');
  });

  it('converts Schwab options and cash dividends', () => {
    const result = convert('schwab', [
      { Date: '08/21/2026', Action: 'Sell to Open', Symbol: 'UUUU 11/20/2026 12.00 P', Description: 'PUT', Quantity: '1', Price: '$0.92', 'Fees & Comm': '$0.66', Amount: '$91.34' },
      { Date: '08/20/2026', Action: 'Cash Dividend', Symbol: 'AAPL', Description: 'Dividend', Quantity: '', Price: '', 'Fees & Comm': '', Amount: '$2.00' },
    ]);
    expect(result.issues).toHaveLength(0);
    expect(result.activities[0].symbol).toBe('UUUU261120P00012000');
    expect(result.activities[0].subtype).toBe('OPTION_OPEN');
    expect(result.activities[1].activityType).toBe('DIVIDEND');
  });

  it('merges same-day Schwab trades with the same amount', () => {
    const result = convert('schwab', [
      { Date: '08/21/2026', Action: 'Buy', Symbol: 'AAPL', Description: 'fill 1', Quantity: '1', Price: '$100', 'Fees & Comm': '$1', Amount: '-$101' },
      { Date: '08/21/2026', Action: 'Buy', Symbol: 'AAPL', Description: 'fill 2', Quantity: '1', Price: '$100', 'Fees & Comm': '$1', Amount: '-$101' },
      { Date: '08/21/2026', Action: 'Buy', Symbol: 'AAPL', Description: 'different amount', Quantity: '2', Price: '$50', 'Fees & Comm': '$0', Amount: '-$100' },
    ]);
    expect(result.activities).toHaveLength(2);
    expect(result.activities[0]).toMatchObject({ quantity: '2', unitPrice: '100', fee: '2', amount: '202' });
  });

  it('uses currency rounding before correcting broker trade prices', () => {
    const usdRounded = convert('schwab', [
      { Date: '08/21/2026', Action: 'Buy', Symbol: 'AAPL', Description: 'sub-cent price', Quantity: '1', Price: '$10.004', 'Fees & Comm': '', Amount: '-$10.00' },
    ]).activities[0];
    const twdRounded = convert('sinopac', [
      { 成交日: '2026/08/18', 商品: '009826 貝萊德', 買賣: '現買', 數量: '1', 成交價: '10.4', 價金: '10.4', 手續費: '0', 交易稅: '0', 應付金額: '10', 應收金額: '0', 幣別: 'TWD' },
    ]).activities[0];

    expect(usdRounded.unitPrice).toBe('10.004');
    expect(twdRounded.unitPrice).toBe('10.4');
  });

  it('corrects buy and sell prices from settlement amounts without counting fees twice', () => {
    const buy = convert('fubon', [
      { 市場: 'GB', 買賣: 'B', 代碼: 'FWRA.LSE1', 名稱: 'ETF', 股數: '2', 價格: '9', 價金: '18', 手續費: '1', 處理費: '0', 交易費: '0', 結算費: '0', 交易稅: '0', 印花稅: '0', 應收付: '-20', 幣別: 'USD', 交割日: '20260720' },
    ]).activities[0];
    const sell = convert('sinopac', [
      { 成交日: '2026/08/18', 商品: '009826 貝萊德', 買賣: '現賣', 數量: '10', 成交價: '10', 價金: '100', 手續費: '1', 交易稅: '0', 應付金額: '0', 應收金額: '98', 幣別: 'TWD' },
    ]).activities[0];

    expect(buy.unitPrice).toBe('9.5');
    expect(sell.unitPrice).toBe('9.9');
  });

  it('normalizes Schwab cash directions and derives reinvestment price from settlement amount', () => {
    const result = convert('schwab', [
      { Date: '03/29/2022', Action: 'Reinvest Shares', Symbol: 'VOO', Description: 'Bought fractional shares', Quantity: '0.002', Price: '$421.7638', 'Fees & Comm': '', Amount: '-$0.96' },
      { Date: '03/29/2022', Action: 'NRA Tax Adj', Symbol: 'VOO', Description: 'Tax', Quantity: '', Price: '', 'Fees & Comm': '', Amount: '-$0.41' },
      { Date: '12/22/2021', Action: 'Journaled Shares', Symbol: '', Description: 'TDA TRAN - EF RETURN FEE', Quantity: '', Price: '', 'Fees & Comm': '', Amount: '-$25.00' },
      { Date: '05/13/2024', Action: 'Journaled Shares', Symbol: '', Description: 'TDA TRAN - CASH MOVEMENT OF OUTGOING ACCOUNT TRANSFER', Quantity: '', Price: '', 'Fees & Comm': '', Amount: '-$13295.79' },
      { Date: '10/08/2025', Action: 'MoneyLink Transfer', Symbol: '', Description: 'Outgoing transfer', Quantity: '', Price: '', 'Fees & Comm': '', Amount: '-$9.00' },
    ]);

    expect(result.issues).toHaveLength(0);
    expect(result.activities.map(({ activityType, amount }) => ({ activityType, amount }))).toEqual([
      { activityType: 'BUY', amount: '0.96' },
      { activityType: 'TAX', amount: '0.41' },
      { activityType: 'FEE', amount: '25' },
      { activityType: 'WITHDRAWAL', amount: '13295.79' },
      { activityType: 'WITHDRAWAL', amount: '9' },
    ]);
    expect(result.activities[0].unitPrice).toBe('480');
  });

  it('excludes matched TDA to Schwab migration legs', () => {
    const result = convert('schwab', [
      { Date: '05/13/2024', Action: 'Journaled Shares', Symbol: '', Description: 'TDA TRAN - CASH MOVEMENT OF OUTGOING ACCOUNT TRANSFER', Quantity: '', Price: '', 'Fees & Comm': '', Amount: '-$13295.79' },
      { Date: '05/13/2024', Action: 'Journaled Shares', Symbol: 'SPLG', Description: 'TDA TRAN - TRANSFER OF SECURITY OR OPTION OUT (SPLG)', Quantity: '-125.629', Price: '', 'Fees & Comm': '', Amount: '' },
      { Date: '05/13/2024', Action: 'Journaled Shares', Symbol: 'QQQM', Description: 'TDA TRAN - TRANSFER OF SECURITY OR OPTION OUT (QQQM)', Quantity: '-8.091', Price: '', 'Fees & Comm': '', Amount: '' },
      { Date: '05/13/2024', Action: 'Journaled Shares', Symbol: 'VT', Description: 'TDA TRAN - TRANSFER OF SECURITY OR OPTION OUT (VT)', Quantity: '-49.276', Price: '', 'Fees & Comm': '', Amount: '' },
      { Date: '05/13/2024', Action: 'Journaled Shares', Symbol: 'VOO', Description: 'TDA TRAN - TRANSFER OF SECURITY OR OPTION OUT (VOO)', Quantity: '-1.025', Price: '', 'Fees & Comm': '', Amount: '' },
      { Date: '05/13/2024', Action: 'Internal Transfer', Symbol: 'QQQM', Description: 'INVESCO NASDAQ ...100 ETF', Quantity: '8.091', Price: '', 'Fees & Comm': '', Amount: '' },
      { Date: '05/13/2024', Action: 'Internal Transfer', Symbol: 'VT', Description: 'VANGUARD TOTAL WORLD STOCK ETF', Quantity: '49.276', Price: '', 'Fees & Comm': '', Amount: '' },
      { Date: '05/13/2024', Action: 'Internal Transfer', Symbol: 'SPLG', Description: 'SPDR PORTFOLIO S&P ...500 ETF', Quantity: '125.629', Price: '', 'Fees & Comm': '', Amount: '' },
      { Date: '05/13/2024', Action: 'Internal Transfer', Symbol: 'VOO', Description: 'VANGUARD S&P ...500 ETF', Quantity: '1.025', Price: '', 'Fees & Comm': '', Amount: '' },
      { Date: '05/13/2024', Action: 'Internal Transfer', Symbol: '', Description: 'TDA TO CS&CO TRANSFER', Quantity: '', Price: '', 'Fees & Comm': '', Amount: '$13295.79' },
    ]);

    expect(result.issues).toHaveLength(0);
    expect(result.activities).toHaveLength(0);
  });

  it('keeps unmatched Schwab internal transfers', () => {
    const result = convert('schwab', [{
      Date: '05/14/2024', Action: 'Internal Transfer', Symbol: 'VOO', Description: 'Unrelated transfer',
      Quantity: '1', Price: '', 'Fees & Comm': '', Amount: '',
    }]);

    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({ activityType: 'DEPOSIT', symbol: 'VOO', quantity: '1' });
  });

  it('excludes reusable Taiwan warrant symbols but keeps ETF symbols', () => {
    const result = convert('sinopac', [
      { 成交日: '2026/08/18', 商品: '030001 台積電元大購01', 買賣: '現買', 數量: '1', 成交價: '1', 價金: '1', 手續費: '0', 交易稅: '0', 應付金額: '1', 應收金額: '0', 幣別: 'TWD' },
      { 成交日: '2026/08/18', 商品: '03001P 台積電元大售01', 買賣: '現賣', 數量: '1', 成交價: '1', 價金: '1', 手續費: '0', 交易稅: '0', 應付金額: '0', 應收金額: '1', 幣別: 'TWD' },
      { 成交日: '2026/08/18', 商品: '006208 富邦台50', 買賣: '現買', 數量: '1', 成交價: '100', 價金: '100', 手續費: '0', 交易稅: '0', 應付金額: '100', 應收金額: '0', 幣別: 'TWD' },
    ]);

    expect(result.activities.map((row) => row.symbol)).toEqual(['006208']);
    expect(result.issues).toEqual([
      { lineNumber: 2, message: '已排除代號可能重複使用的台股權證：030001', severity: 'warning' },
      { lineNumber: 3, message: '已排除代號可能重複使用的台股權證：03001P', severity: 'warning' },
    ]);
  });

  it('recovers a ticker from an older Schwab dividend description', () => {
    const result = convert('schwab', [{
      Date: '03/27/2024', Action: 'Cash Dividend', Symbol: '',
      Description: 'TDA TRAN - ORDINARY DIVIDEND (VOO)', Quantity: '', Price: '', 'Fees & Comm': '', Amount: '$1.58',
    }]);
    expect(result.issues).toHaveLength(0);
    expect(result.activities[0]).toMatchObject({ activityType: 'DIVIDEND', symbol: 'VOO', amount: '1.58' });
  });

  it('matches the DB baseline for T-bills by keeping only maturity gains', () => {
    const result = convert('schwab', [
      { Date: '06/20/2024', Action: 'Buy', Symbol: '912797KF3', Description: 'US TREASURY BILL', Quantity: '12000', Price: '$99.5901', 'Fees & Comm': '', Amount: '-$11950.81' },
      { Date: '06/18/2024', Action: 'Full Redemption Adj', Symbol: '912797KF3', Description: 'US TREASURY BILXXX**MATURED**', Quantity: '', Price: '', 'Fees & Comm': '', Amount: '$12000.00' },
      { Date: '06/18/2024', Action: 'Full Redemption', Symbol: '912797KF3', Description: 'US TREASURY BILXXX**MATURED**', Quantity: '-12,000', Price: '', 'Fees & Comm': '', Amount: '' },
    ]);
    expect(result.issues).toHaveLength(0);
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({ activityType: 'DEPOSIT', amount: '49.19', symbol: '', comment: 'US TREASURY BILXXX**MATURED** | BOND matured -> gain (new funds)' });
  });

  it('converts Fundrich buy with paired cash activity and skips failures', () => {
    const result = convert('fundrich', [{ 基金代碼: 'ALI064', 交易類別: '定期定額', 基金名稱: '基金', 交易日期: '2026-07-27', '淨值（幣別）': 'TWD', 淨值: '23.14', '交易金額（含手續費）': '3000', 單位數: '129.6', 總金額: '3000', 交易狀態: '交易成功' }, { 基金代碼: 'BAD', 交易類別: '申購', 基金名稱: '失敗', 交易日期: '2026-07-27', '淨值（幣別）': 'TWD', 淨值: '1', 單位數: '1', 總金額: '1', 交易狀態: '交易失敗' }]);
    expect(result.issues).toHaveLength(0);
    expect(result.activities.map((row) => row.activityType)).toEqual(['BUY']);
  });

  it('converts CTBC ESPP purchases for importing into a selected brokerage account', () => {
    const result = convert('ctbc_espp', [
      { 買入日期: '2026/09/01', 股數: '7', 均價: '2404.3453', 標的: '2330 台積電' },
      { 買入日期: '2026/08/03', 股數: '7', 均價: '2365.0900', 標的: '2330 台積電' },
    ]);

    expect(result.issues).toHaveLength(0);
    expect(result.activities).toEqual([
      expect.objectContaining({ date: '2026-09-01', symbol: '2330', activityType: 'BUY', quantity: '7', unitPrice: '2404.3453', currency: 'TWD', amount: '16830.4171', comment: 'CTBC ESPP | 2330 台積電' }),
      expect.objectContaining({ date: '2026-08-03', symbol: '2330', activityType: 'BUY', quantity: '7', unitPrice: '2365.09', currency: 'TWD', amount: '16555.63' }),
    ]);
  });

  it('rejects invalid CTBC ESPP purchase rows with source lines', () => {
    const result = convert('ctbc_espp', [
      { 買入日期: '2026/09/01', 股數: '0', 均價: '2400', 標的: '2330 台積電' },
      { 買入日期: '2026/09/02', 股數: '1', 均價: '2400', 標的: '' },
    ]);

    expect(result.activities).toHaveLength(0);
    expect(result.issues).toEqual([
      expect.objectContaining({ lineNumber: 2, message: '股數必須大於 0' }),
      expect.objectContaining({ lineNumber: 3, message: '缺少標的' }),
    ]);
  });

  it('uses Fundrich net settlement amounts and fees for conversions', () => {
    const result = convert('fundrich', [
      { '基金代碼': 'ALI063', '交易類別': '轉換出', '基金名稱': '安聯四季雙收入息組合基金', '交易日期': '2020-10-27', '淨值（幣別）': 'TWD', '淨值': '10.43', '交易金額（含手續費）': '40,581', '單位數': '3,890.8', '總金額': '40,347', '交易狀態': '交易成功' },
      { '基金代碼': 'ALI019', '交易類別': '轉換入', '基金名稱': '安聯四季雙收入息組合基金', '交易日期': '2020-10-27', '淨值（幣別）': 'TWD', '淨值': '11.96', '交易金額（含手續費）': '40,163', '單位數': '3,358.2', '總金額': '40,347', '交易狀態': '交易成功' },
    ]);

    expect(result.issues).toHaveLength(0);
    expect(result.activities.map(({ activityType, unitPrice, amount, fee }) => ({ activityType, unitPrice, amount, fee }))).toEqual([
      { activityType: 'SELL', unitPrice: '10.43', amount: '40347', fee: '234' },
      { activityType: 'BUY', unitPrice: '11.95968078', amount: '40347', fee: '184' },
    ]);
  });

  it('carries each broker settlement amount into the preview import row', () => {
    const fubon = convert('fubon', [{ 市場: 'GB', 買賣: 'B', 代碼: 'FWRA.LSE1', 名稱: 'ETF', 股數: '2', 價格: '9.18', 價金: '18.36', 手續費: '1.38', 處理費: '0', 交易費: '0', 結算費: '0', 交易稅: '0', 印花稅: '0', 應收付: '-19.74', 幣別: 'USD', 交割日: '20260720' }]).activities[0];
    const sinopac = convert('sinopac', [{ 成交日: '2026/08/18', 商品: '009826 貝萊德', 買賣: '現賣', 數量: '10', 成交價: '10', 價金: '100', 手續費: '1', 交易稅: '0', 應付金額: '0', 應收金額: '99', 融資金額: '0', 保證金: '0', 利息: '0', 融券手續費: '0', 幣別: 'TWD' }]).activities[0];
    const schwab = convert('schwab', [{ Date: '08/21/2026', Action: 'Sell to Open', Symbol: 'UUUU 11/20/2026 12.00 P', Description: 'PUT', Quantity: '1', Price: '$0.92', 'Fees & Comm': '$0.66', Amount: '$91.34' }]).activities[0];
    const fundrich = convert('fundrich', [{ 基金代碼: 'ALI064', 交易類別: '定期定額', 基金名稱: '基金', 交易日期: '2026-07-27', '淨值（幣別）': 'TWD', 淨值: '23.14', '交易金額（含手續費）': '3000', 單位數: '129.6', 總金額: '3000', 交易狀態: '交易成功' }]).activities[0];

    expect([
      activityFromSource(fubon, 1, 'account').amount,
      activityFromSource(sinopac, 2, 'account').amount,
      activityFromSource(schwab, 3, 'account').amount,
      activityFromSource(fundrich, 4, 'account').amount,
    ]).toEqual(['19.74', '99', '91.34', '3000']);
  });
});

describe('economic duplicate matching', () => {
  const imported = (id: string, comment: string): ActivityImport => ({
    accountId: 'account', activityType: 'BUY', date: '2026-07-29', symbol: '0050', assetId: 'asset-0050',
    quantity: '1000', unitPrice: '94.5', fee: '30', currency: 'TWD', amount: null, comment,
    isValid: true, isDraft: false,
  });

  it('matches existing activities despite timestamp and note differences', () => {
    const result = markExistingDuplicates([imported('new', 'CSV')], [{ id: 'old', accountId: 'account', activityType: 'BUY', date: new Date('2026-07-29T08:00:00Z'), assetId: 'asset-0050', quantity: 1000, unitPrice: 94.5, fee: 30, currency: 'TWD', amount: 94530, }], 'account');
    expect(result[0].duplicateOfId).toBe('old');
  });

  it('matches an existing UTC timestamp to the Wealthfolio calendar date', () => {
    const result = markExistingDuplicates([imported('new', 'CSV')], [{
      id: 'old', accountId: 'account', activityType: 'BUY', date: '2026-07-28T16:00:00+00:00',
      assetId: 'asset-0050', quantity: 1000, unitPrice: 94.5, fee: 30, currency: 'TWD', amount: null,
    }], 'account', 'Asia/Taipei');
    expect(result[0].duplicateOfId).toBe('old');
  });

  it('matches a Sinopac settled import amount to an existing gross trade amount', () => {
    const row = imported('new', 'CSV');
    row.amount = '94530';
    const result = markExistingDuplicates([row], [{
      id: 'old', accountId: 'account', activityType: 'BUY', date: '2026-07-29',
      assetSymbol: '0050', quantity: 1000, unitPrice: 94.5, fee: 30,
      amount: 94500, currency: 'TWD',
    }], 'account');
    expect(result[0].duplicateOfId).toBe('old');
  });

  it('does not match trades whose settlement amounts agree but execution prices differ', () => {
    const rows = [
      { date: '2026-08-18', quantity: '4000', unitPrice: '10.2', fee: '13', amount: '40813' },
      { date: '2026-08-18', quantity: '1000', unitPrice: '10.18', fee: '3', amount: '10183' },
      { date: '2026-08-17', quantity: '10000', unitPrice: '10.28', fee: '33', amount: '102833' },
    ].map((values, index) => ({
      ...imported(`new-${index}`, '009826 貝萊德世界股票'),
      ...values,
      symbol: '009826',
      assetId: 'asset-009826',
    }));
    const existing = rows.map((row, index) => ({
      id: `old-${index}`,
      accountId: 'account',
      activityType: 'BUY',
      date: row.date,
      assetId: 'asset-009826',
      assetSymbol: '009826',
      quantity: row.quantity,
      unitPrice: 10.14000034,
      fee: row.fee,
      amount: row.amount,
      currency: 'TWD',
    }));

    const result = markExistingDuplicates(rows, existing, 'account');

    expect(result.map((row) => row.duplicateOfId)).toEqual([undefined, undefined, undefined]);
  });

  it('matches a TWD odd-lot trade when the stored unit price was derived from gross amount', () => {
    const row = imported('new', 'CSV');
    row.date = '2026-07-27';
    row.quantity = '99';
    row.unitPrice = '100.85';
    row.fee = '1';
    row.amount = '9985';
    const result = markExistingDuplicates([row], [{
      id: 'old', accountId: 'account', activityType: 'BUY', date: '2026-07-27',
      assetSymbol: '0050', quantity: 99, unitPrice: 100.848485, fee: 1,
      amount: 9984.000015, currency: 'TWD',
    }], 'account');
    expect(result[0].duplicateOfId).toBe('old');
  });

  it('matches when the import and existing row use different asset UUIDs', () => {
    const row = imported('new', 'CSV');
    row.assetId = 'new-asset-uuid';
    row.symbol = '0050';
    const result = markExistingDuplicates([row], [{ id: 'old', accountId: 'account', activityType: 'BUY', date: '2026-07-29', assetId: 'old-asset-uuid', assetSymbol: '0050', quantity: 1000, unitPrice: 94.5, fee: 30, currency: 'TWD' }], 'account');
    expect(result[0].duplicateOfId).toBe('old');
  });

  it('pairs only as many duplicates as already exist', () => {
    const result = markExistingDuplicates([imported('a', 'one'), imported('b', 'two')], [{ id: 'old', accountId: 'account', activityType: 'BUY', date: '2026-07-29', assetId: 'asset-0050', quantity: 1000, unitPrice: 94.5, fee: 30, currency: 'TWD' }], 'account');
    expect(result.map((item) => item.duplicateOfId)).toEqual(['old', undefined]);
  });

  it('matches split CSV fills to an existing merged same-day trade', () => {
    const first = imported('first', 'CSV');
    first.quantity = '1'; first.unitPrice = '246'; first.fee = '0'; first.amount = '246';
    const second = imported('second', 'CSV');
    second.quantity = '4'; second.unitPrice = '258'; second.fee = '0'; second.amount = '1032';
    const result = markExistingDuplicates([first, second], [{
      id: 'merged', accountId: 'account', activityType: 'BUY', date: '2026-07-29', assetSymbol: '0050',
      quantity: 5, unitPrice: 255.6, fee: 0, amount: 1278, currency: 'TWD',
    }], 'account');

    expect(result.map((item) => item.duplicateOfId)).toEqual(['merged', 'merged']);
  });

  it('matches a cash dividend when the DB row has an asset but the import does not', () => {
    const row = imported('new', 'TDA TRAN - ORDINARY DIVIDEND (VOO)');
    row.activityType = 'DIVIDEND';
    row.currency = 'USD';
    row.symbol = '';
    row.assetId = undefined;
    row.quantity = '1';
    row.unitPrice = '1';
    row.fee = undefined;
    row.amount = '1.58';
    const result = markExistingDuplicates([row], [{
      id: 'old', accountId: 'account', activityType: 'DIVIDEND', date: '2026-07-29',
      assetId: 'voo-asset', assetSymbol: 'VOO', quantity: 1, unitPrice: 1, amount: 1.58, currency: 'USD',
    }], 'account');
    expect(result[0].duplicateOfId).toBe('old');
  });

  it('matches an unresolved option by its normalized description', () => {
    const row = imported('new', 'PUT ENERGY FUELS INC $12 EXP 11/20/26');
    row.activityType = 'SELL';
    row.currency = 'USD';
    row.subtype = 'OPTION_OPEN';
    row.symbol = 'UUUU261120P00012000';
    row.assetId = undefined;
    row.quantity = '1';
    row.unitPrice = '0.92';
    row.fee = '0.66';
    row.amount = '91.34';
    const result = markExistingDuplicates([row], [{
      id: 'old', accountId: 'account', activityType: 'SELL', subtype: 'POSITION_OPEN', date: '2026-07-29',
      assetId: undefined, assetSymbol: undefined, quantity: 1, unitPrice: 0.92, fee: 0.66, amount: 91.34,
      currency: 'USD', notes: 'PUT ENERGY FUELS INC $12 EXP 11/20/26',
    }], 'account');
    expect(result[0].duplicateOfId).toBe('old');
  });

  it('does not match a different economic amount', () => {
    const row = imported('new', 'CSV');
    row.quantity = '999';
    const result = markExistingDuplicates([row], [{ id: 'old', accountId: 'account', activityType: 'BUY', date: '2026-07-29', assetSymbol: '0050', quantity: 1000, unitPrice: 94.5, fee: 30, amount: 94530, currency: 'TWD' }], 'account');
    expect(result[0].duplicateOfId).toBeUndefined();
  });

  it('explains a same-day same-asset non-duplicate', () => {
    const row = imported('new', 'CSV');
    row.quantity = '50';
    expect(sameDayNonDuplicateReason(row, [{
      id: 'old', accountId: 'account', activityType: 'BUY', date: '2026-07-29',
      assetId: 'asset-0050', quantity: 1000, unitPrice: 94.5, fee: 30, currency: 'TWD',
    }], 'account')).toContain('數量不同');
  });

  it('explains a same-day same-asset trade with a different side', () => {
    const row = imported('new', 'CSV');
    expect(sameDayNonDuplicateReason(row, [{
      id: 'old', accountId: 'account', activityType: 'SELL', date: '2026-07-29',
      assetId: 'asset-0050', quantity: 1000, unitPrice: 94.5, fee: 30, currency: 'TWD',
    }], 'account')).toContain('買賣類型不同');
  });

  it('explains a same-day same-asset difference within the import batch', () => {
    const row = imported('new', 'CSV');
    const sibling = imported('sibling', 'CSV');
    sibling.lineNumber = 2;
    sibling.quantity = '50';
    expect(sameDayNonDuplicateReason(row, [], 'account', undefined, [row, sibling])).toContain('數量不同');
  });
});

it('serializes the standard Wealthfolio columns', () => {
  const csv = stringifyActivities([{ date: '2026-01-01', symbol: 'AAPL', instrumentType: 'EQUITY', quantity: '1', activityType: 'BUY', unitPrice: '10', currency: 'USD', fee: '0', amount: '', fxRate: '', subtype: '', comment: 'a,b', account: 'Broker' }]);
  expect(csv.split('\r\n')[0]).toBe('date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,amount,fxRate,subtype,comment,account');
  expect(csv).toContain('"a,b"');
});
