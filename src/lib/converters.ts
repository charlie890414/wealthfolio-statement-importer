import type {
  BrokerDetection,
  BrokerKind,
  ConversionIssue,
  ConversionResult,
  NormalizedActivity,
} from './types';
import Big from 'big.js';
import { assertValidCalendarDate, validateNormalizedActivities } from './validation';

const FUBON_HEADERS = ['市場', '買賣', '代碼', '名稱', '股數', '價格', '價金', '應收付', '幣別', '交割日'];
const SINOPAC_HEADERS = ['成交日', '商品', '買賣', '數量', '成交價', '價金', '應付金額', '應收金額', '幣別'];
const SCHWAB_HEADERS = ['Date', 'Action', 'Symbol', 'Description', 'Quantity', 'Price', 'Fees & Comm', 'Amount'];
const FUNDRICH_HEADERS = ['基金代碼', '交易類別', '基金名稱', '交易日期', '淨值', '交易金額（含手續費）', '單位數', '總金額', '交易狀態'];
const CTBC_ESPP_HEADERS = ['買入日期', '股數', '均價', '標的'];
const CTBC_ESPP_PURCHASE_HEADERS = ['日期', '類型', '提存別', '股數', '申購金額', '標的'];

const empty = (): NormalizedActivity => ({ date: '', symbol: '', instrumentType: '', quantity: '', activityType: '', unitPrice: '', currency: '', fee: '', tax: '', amount: '', fxRate: '', subtype: '', comment: '', account: '' });
const clean = (value: unknown) => String(value ?? '').trim().split(',').join('');
const number = (value: unknown) => {
  let s = clean(value).replace(/[$£€]/g, '');
  const negative = s.startsWith('(') && s.endsWith(')');
  s = s.replace(/[()]/g, '');
  if (negative && !s.startsWith('-')) s = `-${s}`;
  return s;
};
const money = (value: unknown) => number(value);
const absoluteMoney = (value: unknown) => {
  const parsed = number(value);
  return parsed ? new Big(parsed).abs().toString() : '';
};
const asFloat = (value: unknown) => Number(number(value) || 0);
const decimal = (value: unknown) => new Big(number(value) || 0);
const decimalString = (value: Big) => value.toString();
const isoDate = (value: string, formats: string[] = ['YYYY-MM-DD']) => {
  const s = value.trim();
  if (/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(s)) return assertValidCalendarDate(s.split('/').join('-'));
  if (/^\d{8}$/.test(s)) return assertValidCalendarDate(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`);
  if (formats.includes('MM/DD/YYYY')) {
    const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return assertValidCalendarDate(`${m[3]}-${m[1]}-${m[2]}`);
  }
  throw new Error(`無法解析日期：${value}`);
};
const issue = (issues: ConversionIssue[], lineNumber: number, message: string, severity: ConversionIssue['severity'] = 'error') => issues.push({ lineNumber, message, severity });
// TWSE warrant symbols are reusable. Importing them by symbol can therefore
// attach an old transaction to a different warrant that later reused the code.
const isTaiwanWarrantCode = (value: string) => /^(?:0[3-8]\d{4}|0[3-8]\d{3}[PUTFQCBXY])$/i.test(value.trim());
export function inferInstrumentType(input: {
  broker: BrokerKind;
  symbol: string;
  name?: string;
  market?: string;
  action?: string;
}): string {
  const symbol = input.symbol.trim().toUpperCase();
  if (input.broker === 'schwab') {
    if (schwabOption(input.action || '') || /\d{2}\/\d{2}\/\d{4}\s+[\d.]+\s+[CP]$/.test(symbol)) return 'OPTION';
    if (isBond(symbol)) return 'BOND';
  }
  return '';
}
export function detectBroker(headers: string[]): BrokerDetection {
  if (CTBC_ESPP_PURCHASE_HEADERS.every((header) => headers.includes(header))) return { broker: 'ctbc_espp', missing: [] };
  const has = (required: string[]) => required.filter((header) => !headers.includes(header));
  const candidates: Array<[BrokerKind, string[]]> = [['fubon', FUBON_HEADERS], ['sinopac', SINOPAC_HEADERS], ['schwab', SCHWAB_HEADERS], ['fundrich', FUNDRICH_HEADERS], ['ctbc_espp', CTBC_ESPP_HEADERS]];
  const exact = candidates.find(([, required]) => has(required).length === 0);
  if (exact) return { broker: exact[0], missing: [] };
  const closest = candidates.map(([broker, required]) => [broker, has(required)] as const).sort((a, b) => a[1].length - b[1].length)[0];
  return { broker: null, missing: closest?.[1] ?? ['必要標題'] };
}

function fubon(rows: Array<Record<string, string>>, issues: ConversionIssue[]): NormalizedActivity[] {
  const output: NormalizedActivity[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]; const line = i + 2;
    try {
      const side = row['買賣']?.trim().toUpperCase();
      if (!['B', 'S'].includes(side)) throw new Error(`未支援的買賣類別：${row['買賣']}`);
      const settle = isoDate(row['交割日']); const date = settle;
      const market = row['市場']?.trim().toUpperCase(); const code = row['代碼']?.trim();
      if (market === 'TW' && isTaiwanWarrantCode(code)) { issue(issues, line, `已排除代號可能重複使用的台股權證：${code}`, 'warning'); continue; }
      const suffix: Record<string, string> = { GB: 'L', TW: 'TW', HK: 'HK', JP: 'T', DE: 'DE', FR: 'PA', NL: 'AS', CH: 'SW', CA: 'TO', AU: 'AX' };
      const base = code.split(/[.\s]/)[0]; const symbol = suffix[market] ? `${base}.${suffix[market]}` : base;
      const fee = ['手續費', '處理費', '交易費', '結算費'].reduce((sum, key) => sum.plus(decimal(row[key])), new Big(0));
      const tax = ['交易稅', '印花稅'].reduce((sum, key) => sum.plus(decimal(row[key])), new Big(0));
      const currency = row['幣別']?.trim() || 'USD';
      const trade: NormalizedActivity = { ...empty(), date, symbol, instrumentType: inferInstrumentType({ broker: 'fubon', symbol: code, name: row['名稱'], market }), quantity: money(row['股數']), activityType: side === 'B' ? 'BUY' : 'SELL', unitPrice: money(row['價格']), currency, fee: decimalString(fee), tax: decimalString(tax), amount: absoluteMoney(row['應收付']), comment: `${code} | ${row['名稱']?.trim() || ''} | 市場:${market} 交割日:${settle}（CSV 日期）`, };
      output.push(trade);
    } catch (error) { issue(issues, line, error instanceof Error ? error.message : String(error)); }
  }
  return output;
}

function sinopac(rows: Array<Record<string, string>>, issues: ConversionIssue[]): NormalizedActivity[] {
  const output: NormalizedActivity[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]; const line = i + 2;
    try {
      const side = row['買賣']?.trim(); if (!['現買', '現賣'].includes(side)) throw new Error(`未支援的買賣類別或非現金交易：${row['買賣']}`);
      for (const key of ['融資金額', '保證金', '利息', '融券手續費']) if (asFloat(row[key])) throw new Error('不支援融資、融券或其他非現金交易');
      const date = isoDate(row['成交日']); const [code, ...nameParts] = (row['商品'] || '').trim().split(/\s+/); const name = nameParts.join(' '); const currency = row['幣別']?.trim() || 'TWD';
      if (isTaiwanWarrantCode(code)) { issue(issues, line, `已排除代號可能重複使用的台股權證：${code}`, 'warning'); continue; }
      const type = side === '現買' ? 'BUY' : 'SELL'; const fee = decimal(row['手續費']); const tax = decimal(row['交易稅']);
      // Sinopac reports the settled cash total in separate buy/sell columns.
      // Keep that economic amount on the activity so preview, native checking,
      // and addon duplicate matching all see the same transaction value.
      const amount = side === '現買' ? money(row['應付金額']) : money(row['應收金額']);
      const trade: NormalizedActivity = { ...empty(), date, symbol: code, instrumentType: inferInstrumentType({ broker: 'sinopac', symbol: code, name }), quantity: money(row['數量']), activityType: type, unitPrice: money(row['成交價']), currency, fee: decimalString(fee), tax: decimalString(tax), amount, comment: `${code} ${name}`.trim() };
      output.push(trade);
    } catch (error) { issue(issues, line, error instanceof Error ? error.message : String(error)); }
  }
  return output;
}

const schwabOption = (action: string) => ({ 'Sell to Open': ['SELL', 'OPTION_OPEN'], 'Buy to Close': ['BUY', 'OPTION_CLOSE'], Expired: ['ADJUSTMENT', 'OPTION_EXPIRE'] } as Record<string, string[]>)[action];
const occ = (symbol: string) => { const m = symbol.match(/^(.+?)\s+(\d{2})\/(\d{2})\/(\d{4})\s+([\d.]+)\s+([CP])$/); if (!m) return symbol; return `${m[1].trim().toUpperCase().slice(0, 6)}${m[4].slice(-2)}${m[2]}${m[3]}${m[6]}${decimal(m[5]).times(1000).round().toString().padStart(8, '0')}`; };
const isBond = (symbol: string) => /^[A-Z0-9]{9}$/.test(symbol) && /\d/.test(symbol);
const schwabDividendSymbol = (symbol: string, description: string) => {
  if (symbol) return symbol;
  // Older Schwab/TDA rows put the ticker only in descriptions such as
  // "TDA TRAN - ORDINARY DIVIDEND (VOO)".
  return description.match(/\(([A-Z0-9.:-]+)\)\s*$/i)?.[1]?.toUpperCase() || '';
};

function mergeSchwabSameAmountTrades(rows: NormalizedActivity[]): NormalizedActivity[] {
  const merged: NormalizedActivity[] = [];
  const indexes = new Map<string, number>();

  for (const row of rows) {
    if (!['BUY', 'SELL'].includes(row.activityType) || !row.amount) {
      merged.push(row);
      continue;
    }
    const key = [row.date, row.symbol, row.activityType, row.subtype, row.amount].join('|');
    const existingIndex = indexes.get(key);
    if (existingIndex === undefined) {
      indexes.set(key, merged.length);
      merged.push({ ...row });
      continue;
    }
    const base = merged[existingIndex];
    const quantity = decimal(base.quantity).plus(decimal(row.quantity));
    const notional = decimal(base.quantity).times(decimal(base.unitPrice))
      .plus(decimal(row.quantity).times(decimal(row.unitPrice)));
    base.quantity = quantity.toString();
    base.unitPrice = quantity.eq(0) ? base.unitPrice : notional.div(quantity).toString();
    base.fee = decimal(base.fee).plus(decimal(row.fee)).toString();
    base.tax = decimal(base.tax).plus(decimal(row.tax)).toString();
    base.amount = decimal(base.amount).plus(decimal(row.amount)).toString();
    const mergedCount = Number(base.comment.match(/merged (\d+) same-day same-amount fills/)?.[1] || 1) + 1;
    base.comment = `${base.comment.replace(/ \| merged \d+ same-day same-amount fills$/, '')} | merged ${mergedCount} same-day same-amount fills`.trim();
  }

  return merged;
}

function schwabTdaMigrationRowIndexes(rows: Array<Record<string, string>>): Set<number> {
  const excluded = new Set<number>();
  const outgoingByKey = new Map<string, number[]>();
  const key = (row: Record<string, string>, kind: 'cash' | 'security') => [
    row.Date?.trim() || '',
    kind === 'security' ? row.Symbol?.trim().toUpperCase() || '' : '',
    decimal(kind === 'security' ? row.Quantity : row.Amount).abs().toString(),
  ].join('|');

  rows.forEach((row, index) => {
    if (row.Action?.trim() !== 'Journaled Shares') return;
    const description = row.Description?.trim().toUpperCase() || '';
    const kind = description.includes('CASH MOVEMENT OF OUTGOING ACCOUNT TRANSFER')
      ? 'cash'
      : description.includes('TRANSFER OF SECURITY OR OPTION OUT') ? 'security' : null;
    if (!kind) return;
    const rowKey = key(row, kind);
    const queue = outgoingByKey.get(rowKey) ?? [];
    queue.push(index);
    outgoingByKey.set(rowKey, queue);
  });

  rows.forEach((row, index) => {
    if (row.Action?.trim() !== 'Internal Transfer') return;
    const isCash = !row.Symbol?.trim() && (row.Description?.trim().toUpperCase() || '').includes('TDA TO CS&CO TRANSFER');
    const kind = isCash ? 'cash' : 'security';
    const queue = outgoingByKey.get(key(row, kind));
    const outgoingIndex = queue?.shift();
    if (outgoingIndex === undefined) return;
    excluded.add(outgoingIndex);
    excluded.add(index);
  });

  return excluded;
}

function schwab(rows: Array<Record<string, string>>, issues: ConversionIssue[]): NormalizedActivity[] {
  const output: NormalizedActivity[] = [];
  const tdaMigrationRows = schwabTdaMigrationRowIndexes(rows);
  const bondCosts = new Map<string, Big>();
  for (const row of rows) {
    if (row.Action?.trim() !== 'Buy' || !isBond(row.Symbol?.trim() || '')) continue;
    const symbol = row.Symbol.trim();
    const quantity = decimal(row.Quantity).abs();
    const reportedAmount = decimal(row.Amount).abs();
    const cost = reportedAmount.gt(0) ? reportedAmount : quantity.times(decimal(row.Price));
    if (cost.gt(0)) bondCosts.set(symbol, (bondCosts.get(symbol) || new Big(0)).plus(cost));
  }
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]; const line = i + 2; const action = row.Action?.trim();
    try {
      if (tdaMigrationRows.has(i)) continue;
      if (action === 'Journal') continue;
      const date = isoDate(row.Date, ['MM/DD/YYYY']); const rawSymbol = row.Symbol?.trim(); const symbol = occ(rawSymbol); const desc = row.Description?.trim() || ''; const descUpper = desc.toUpperCase();
      const base: NormalizedActivity = { ...empty(), date, symbol, instrumentType: inferInstrumentType({ broker: 'schwab', symbol: rawSymbol, name: desc, action }), quantity: absoluteMoney(row.Quantity), unitPrice: money(row.Price), fee: absoluteMoney(row['Fees & Comm']), amount: absoluteMoney(row.Amount), currency: 'USD', comment: desc };
      if (action === 'Full Redemption Adj' && isBond(rawSymbol || '')) {
        const principal = decimal(row.Amount).abs();
        const cost = bondCosts.get(rawSymbol || '');
        if (!cost || principal.lte(cost)) continue;
        output.push({
          ...base,
          activityType: 'DEPOSIT',
          symbol: '',
          quantity: '1',
          unitPrice: '1',
          amount: principal.minus(cost).toString(),
          fee: '',
          instrumentType: '',
          comment: `${desc} | BOND matured -> gain (new funds)`,
        });
        continue;
      }
      // The account baseline records fixed-income activity as cash only. The
      // principal purchase/redemption legs are therefore intentionally omitted
      // from the normalized activity stream; only the computed maturity gain
      // above remains.
      if (isBond(rawSymbol || '')) continue;
      const option = schwabOption(action);
      if (option) { base.activityType = option[0]; base.subtype = option[1]; base.instrumentType = 'OPTION'; if (!base.quantity) base.quantity = '1'; output.push(base); continue; }
      if (action === 'Assigned') { base.activityType = 'ADJUSTMENT'; base.subtype = 'OPTION_ASSIGNMENT'; base.instrumentType = 'OPTION'; base.unitPrice = ''; base.amount = ''; output.push(base); continue; }
      if (action === 'Stock Split') { base.activityType = 'SPLIT'; base.unitPrice = base.unitPrice || '1'; base.amount = ''; output.push(base); continue; }
      if (action === 'Full Redemption') { base.activityType = 'SELL'; base.instrumentType = isBond(rawSymbol) ? 'BOND' : ''; base.quantity = base.quantity.replace('-', ''); base.unitPrice = '1'; base.amount = base.quantity; output.push(base); continue; }
      if (action === 'Buy' || action === 'Reinvest Shares' || action === 'Sell') { base.activityType = action === 'Sell' ? 'SELL' : 'BUY'; if (isBond(symbol)) base.instrumentType = 'BOND'; output.push(base); continue; }
      if (['Cash Dividend', 'Qualified Dividend', 'Reinvest Dividend', 'Qual Div Reinvest'].includes(action)) { base.activityType = 'DIVIDEND'; base.symbol = schwabDividendSymbol(rawSymbol, desc); base.quantity = '1'; base.unitPrice = '1'; base.instrumentType = ''; output.push(base); continue; }
      if (['Bond Interest', 'Credit Interest'].includes(action)) { base.activityType = 'INTEREST'; base.symbol = ''; base.quantity = ''; base.unitPrice = ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'NRA Tax Adj' || (action === 'Journaled Shares' && descUpper.includes('W-8 WITHHOLDING'))) { base.activityType = 'TAX'; base.symbol = ''; base.quantity = ''; base.unitPrice = ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'MoneyLink Transfer' || action === 'Wire Received') { base.activityType = action === 'Wire Received' || asFloat(row.Amount) >= 0 ? 'DEPOSIT' : 'WITHDRAWAL'; base.symbol = ''; base.quantity = ''; base.unitPrice = ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'Internal Transfer') { base.activityType = asFloat(row.Amount) >= 0 ? 'DEPOSIT' : 'WITHDRAWAL'; base.symbol = rawSymbol || ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'Journaled Shares') {
        if (!asFloat(base.amount)) continue;
        if (descUpper.includes('CASH MOVEMENT OF OUTGOING ACCOUNT TRANSFER')) base.activityType = 'WITHDRAWAL';
        else if (descUpper.includes('EF RETURN FEE')) base.activityType = 'FEE';
        else throw new Error(`未支援的 Schwab Journaled Shares 現金交易：${desc || row.Amount}`);
        base.symbol = ''; base.quantity = ''; base.unitPrice = ''; base.instrumentType = ''; output.push(base); continue;
      }
      throw new Error(`未支援的 Schwab Action：${action}`);
    } catch (error) { issue(issues, line, error instanceof Error ? error.message : String(error)); }
  }
  return mergeSchwabSameAmountTrades(output);
}

function fundrich(rows: Array<Record<string, string>>, issues: ConversionIssue[]): NormalizedActivity[] {
  const output: NormalizedActivity[] = []; const map: Record<string, string> = { 定期定額: 'BUY', 申購: 'BUY', 贖回: 'SELL', 轉換入: 'BUY', 轉換出: 'SELL' };
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]; const line = i + 2; try {
      if (row['交易狀態'] === '交易失敗') continue; const type = map[row['交易類別']]; if (!type) throw new Error(`未支援的交易類別：${row['交易類別']}`);
      const quantity = decimal(row['單位數']); if (!row['基金代碼'] || quantity.lte(0)) throw new Error('缺少基金代碼或單位數'); const date = isoDate(row['交易日期']); const currency = row['淨值（幣別）'] || 'TWD';
      const grossDecimal = decimal(row['交易金額（含手續費）'] || row['交易金額']); const quantityDecimal = decimal(row['單位數']); const navDecimal = decimal(row['淨值']);
      const explicitFee = decimal(row['手續費用']).plus(decimal(row['其他費用']));
      const transferNet = decimal(row['總金額']);
      const inferredTransferFee = row['交易類別'].startsWith('轉換') && grossDecimal.gt(0) && transferNet.gt(0)
        ? grossDecimal.minus(transferNet).abs()
        : new Big(0);
      const feeDecimal = explicitFee.gt(0) ? explicitFee : inferredTransferFee;
      const amount = absoluteMoney(row['總金額'] || row['交易金額（含手續費）'] || row['交易金額']);
      const trade: NormalizedActivity = { ...empty(), date, symbol: row['基金代碼'], instrumentType: 'FUND', quantity: quantityDecimal.toString(), activityType: type, unitPrice: navDecimal.toString(), currency, fee: decimalString(feeDecimal), amount, comment: `基富通 | ${(row['基金名稱'] || '').replace(/^【[^】]*】/, '')} | ${row['交易類別']}` };
      output.push(trade);
    } catch (error) { issue(issues, line, error instanceof Error ? error.message : String(error)); }
  }
  return output.sort((a, b) => a.date.localeCompare(b.date));
}

function ctbcEsppPurchases(rows: Array<Record<string, string>>, issues: ConversionIssue[]): NormalizedActivity[] {
  const purchases = new Map<string, NormalizedActivity>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    try {
      const type = row['類型']?.trim();
      if (type === '轉出') continue;
      if (type !== '買入') throw new Error(`未支援的 ESPP 類型：${type || ''}`);
      const date = isoDate(row['日期'] || '');
      const target = row['標的']?.trim() || '';
      if (!target) throw new Error('缺少標的');
      const [symbol] = target.split(/\s+/);
      const quantity = decimal(row['股數']);
      if (quantity.lte(0)) throw new Error('股數必須大於 0');
      const amount = decimal(row['申購金額']);
      if (amount.lte(0)) throw new Error('買入必須提供大於 0 的實際申購金額');
      const deposit = row['提存別']?.trim() || '';
      if (!['公提', '自提'].includes(deposit)) throw new Error('提存別必須為公提或自提');
      const key = JSON.stringify([date, symbol]);
      const comment = `${deposit} ${quantity} 股，申購金額 ${amount} TWD`;
      const existing = purchases.get(key);
      if (existing) {
        existing.quantity = decimal(existing.quantity).plus(quantity).toString();
        existing.amount = decimal(existing.amount).plus(amount).toString();
        existing.comment += ` | ${comment}`;
      } else purchases.set(key, { ...empty(), date, symbol, activityType: 'BUY',
        quantity: quantity.toString(), amount: amount.toString(), currency: 'TWD', fee: '0',
        comment: `CTBC ESPP | ${target} | ${comment}` });
    } catch (error) { issue(issues, i + 2, error instanceof Error ? error.message : String(error)); }
  }
  if (issues.some((item) => item.severity === 'error')) return [];
  return [...purchases.values()].sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol))
    .map((activity) => ({ ...activity,
      unitPrice: decimal(activity.amount).div(decimal(activity.quantity)).round(8, Big.roundHalfUp).toString(),
      amount: decimal(activity.amount).round(8, Big.roundHalfUp).toString(),
    }));
}

function ctbcEspp(rows: Array<Record<string, string>>, issues: ConversionIssue[]): NormalizedActivity[] {
  if (rows.some((row) => '日期' in row || '類型' in row)) return ctbcEsppPurchases(rows, issues);
  const output: NormalizedActivity[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]; const line = i + 2;
    try {
      const date = isoDate(row['買入日期']);
      const quantity = decimal(row['股數']);
      const unitPrice = decimal(row['均價']);
      const target = row['標的']?.trim() || '';
      if (!target) throw new Error('缺少標的');
      if (quantity.lte(0)) throw new Error('股數必須大於 0');
      if (unitPrice.lte(0)) throw new Error('均價必須大於 0');
      const [symbol] = target.split(/\s+/);
      const amount = quantity.times(unitPrice);
      output.push({
        ...empty(), date, symbol, quantity: quantity.toString(), activityType: 'BUY',
        unitPrice: unitPrice.toString(), currency: 'TWD', fee: '', amount: amount.toString(),
        comment: `CTBC ESPP | ${target}`,
      });
    } catch (error) { issue(issues, line, error instanceof Error ? error.message : String(error)); }
  }
  return output;
}

export function convert(broker: BrokerKind, rows: Array<Record<string, string>>): ConversionResult {
  const issues: ConversionIssue[] = []; let activities: NormalizedActivity[];
  if (broker === 'fubon') activities = fubon(rows, issues); else if (broker === 'sinopac') activities = sinopac(rows, issues); else if (broker === 'schwab') activities = schwab(rows, issues); else if (broker === 'fundrich') activities = fundrich(rows, issues); else activities = ctbcEspp(rows, issues);
  // Wealthfolio 3.8 treats an explicit amount as the final cash paid or
  // received. Preserve broker unit prices and totals so the host can validate
  // or derive only when amount is genuinely missing; do not rewrite prices to
  // make a legitimate settlement total fit quantity × price.
  return { broker, sourceRows: rows.length, activities: validateNormalizedActivities(activities, issues), issues };
}
