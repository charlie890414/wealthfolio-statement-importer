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

const empty = (): NormalizedActivity => ({ date: '', symbol: '', instrumentType: '', quantity: '', activityType: '', unitPrice: '', currency: '', fee: '', amount: '', fxRate: '', subtype: '', comment: '', account: '' });
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
const dedupe = (rows: NormalizedActivity[]) => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = JSON.stringify(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export function detectBroker(headers: string[]): BrokerDetection {
  const has = (required: string[]) => required.filter((header) => !headers.includes(header));
  const candidates: Array<[BrokerKind, string[]]> = [['fubon', FUBON_HEADERS], ['sinopac', SINOPAC_HEADERS], ['schwab', SCHWAB_HEADERS], ['fundrich', FUNDRICH_HEADERS]];
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
      const suffix: Record<string, string> = { GB: 'L', TW: 'TW', HK: 'HK', JP: 'T', DE: 'DE', FR: 'PA', NL: 'AS', CH: 'SW', CA: 'TO', AU: 'AX' };
      const base = code.split(/[.\s]/)[0]; const symbol = suffix[market] ? `${base}.${suffix[market]}` : base;
      const fee = ['手續費', '處理費', '交易費', '結算費', '交易稅', '印花稅'].reduce((sum, key) => sum.plus(decimal(row[key])), new Big(0));
      const currency = row['幣別']?.trim() || 'USD';
      const trade: NormalizedActivity = { ...empty(), date, symbol, instrumentType: 'ETF', quantity: money(row['股數']), activityType: side === 'B' ? 'BUY' : 'SELL', unitPrice: money(row['價格']), currency, fee: decimalString(fee), amount: absoluteMoney(row['應收付']), comment: `${code} | ${row['名稱']?.trim() || ''} | 市場:${market} 交割日:${settle}（CSV 日期）`, };
      output.push(trade);
    } catch (error) { issue(issues, line, error instanceof Error ? error.message : String(error)); }
  }
  return output;
}

const SINOPAC_ETFS = new Set(['0050', '0051', '0056', '006201', '006208', '00631L', '00632R', '00663L', '00878', '00885']);
function sinopac(rows: Array<Record<string, string>>, issues: ConversionIssue[]): NormalizedActivity[] {
  const output: NormalizedActivity[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]; const line = i + 2;
    try {
      const side = row['買賣']?.trim(); if (!['現買', '現賣'].includes(side)) throw new Error(`未支援的買賣類別或非現金交易：${row['買賣']}`);
      for (const key of ['融資金額', '保證金', '利息', '融券手續費']) if (asFloat(row[key])) throw new Error('不支援融資、融券或其他非現金交易');
      const date = isoDate(row['成交日']); const [code, ...nameParts] = (row['商品'] || '').trim().split(/\s+/); const name = nameParts.join(' '); const currency = row['幣別']?.trim() || 'TWD';
      const type = side === '現買' ? 'BUY' : 'SELL'; const fee = decimal(row['手續費']).plus(decimal(row['交易稅']));
      // Sinopac reports the settled cash total in separate buy/sell columns.
      // Keep that economic amount on the activity so preview, native checking,
      // and addon duplicate matching all see the same transaction value.
      const amount = side === '現買' ? money(row['應付金額']) : money(row['應收金額']);
      const trade: NormalizedActivity = { ...empty(), date, symbol: code, instrumentType: SINOPAC_ETFS.has(code) ? 'ETF' : 'EQUITY', quantity: money(row['數量']), activityType: type, unitPrice: money(row['成交價']), currency, fee: decimalString(fee), amount, comment: `${code} ${name}`.trim() };
      output.push(trade);
    } catch (error) { issue(issues, line, error instanceof Error ? error.message : String(error)); }
  }
  return output;
}

const schwabOption = (action: string) => ({ 'Sell to Open': ['SELL', 'POSITION_OPEN'], 'Buy to Close': ['BUY', 'POSITION_CLOSE'], Expired: ['ADJUSTMENT', 'OPTION_EXPIRY'] } as Record<string, string[]>)[action];
const occ = (symbol: string) => { const m = symbol.match(/^(.+?)\s+(\d{2})\/(\d{2})\/(\d{4})\s+([\d.]+)\s+([CP])$/); if (!m) return symbol; return `${m[1].trim().toUpperCase().slice(0, 6)}${m[4].slice(-2)}${m[2]}${m[3]}${m[6]}${decimal(m[5]).times(1000).round().toString().padStart(8, '0')}`; };
const isBond = (symbol: string) => /^[A-Z0-9]{9}$/.test(symbol) && /\d/.test(symbol);
function schwab(rows: Array<Record<string, string>>, issues: ConversionIssue[]): NormalizedActivity[] {
  const output: NormalizedActivity[] = []; const cash = '$CASH-USD';
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]; const line = i + 2; const action = row.Action?.trim();
    try {
      if (action === 'Journal' || action === 'Full Redemption Adj') continue;
      const date = isoDate(row.Date, ['MM/DD/YYYY']); const rawSymbol = row.Symbol?.trim(); const symbol = occ(rawSymbol); const desc = row.Description?.trim() || '';
      const base: NormalizedActivity = { ...empty(), date, symbol, quantity: number(row.Quantity), unitPrice: money(row.Price), fee: money(row['Fees & Comm']), amount: money(row.Amount), currency: 'USD', comment: desc };
      const option = schwabOption(action);
      if (option) { base.activityType = option[0]; base.subtype = option[1]; base.instrumentType = 'OPTION'; base.amount = absoluteMoney(row.Amount); if (!base.quantity) base.quantity = '1'; output.push(base); continue; }
      if (action === 'Assigned') { base.activityType = 'ADJUSTMENT'; base.subtype = 'POSITION_CLOSE'; base.instrumentType = 'OPTION'; base.unitPrice = ''; base.amount = ''; output.push(base); continue; }
      if (action === 'Stock Split') { base.activityType = 'SPLIT'; base.unitPrice = base.unitPrice || '1'; base.amount = ''; output.push(base); continue; }
      if (action === 'Full Redemption') { base.activityType = 'SELL'; base.instrumentType = isBond(rawSymbol) ? 'BOND' : ''; base.quantity = base.quantity.replace('-', ''); base.unitPrice = '1'; base.amount = base.quantity; output.push(base); continue; }
      if (action === 'Buy' || action === 'Reinvest Shares' || action === 'Sell') { base.activityType = action === 'Sell' ? 'SELL' : 'BUY'; base.amount = absoluteMoney(row.Amount); if (isBond(symbol)) { base.instrumentType = 'BOND'; const q = asFloat(base.quantity); const amt = Math.abs(asFloat(row.Amount)); base.unitPrice = q && amt ? String((amt + Math.abs(asFloat(base.fee))) / q) : base.unitPrice; } output.push(base); continue; }
      if (['Cash Dividend', 'Qualified Dividend', 'Reinvest Dividend', 'Qual Div Reinvest'].includes(action)) { base.activityType = 'DIVIDEND'; base.symbol = rawSymbol || cash; base.quantity = '1'; base.unitPrice = '1'; base.instrumentType = ''; output.push(base); continue; }
      if (['Bond Interest', 'Credit Interest'].includes(action)) { base.activityType = 'INTEREST'; base.symbol = ''; base.quantity = ''; base.unitPrice = ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'NRA Tax Adj' || (action === 'Journaled Shares' && desc.includes('W-8 WITHHOLDING'))) { base.activityType = 'TAX'; base.symbol = ''; base.quantity = ''; base.unitPrice = ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'MoneyLink Transfer' || action === 'Wire Received') { base.activityType = action === 'Wire Received' || asFloat(base.amount) >= 0 ? 'DEPOSIT' : 'WITHDRAWAL'; base.symbol = ''; base.quantity = ''; base.unitPrice = ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'Internal Transfer') { base.activityType = asFloat(base.amount) >= 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT'; base.symbol = rawSymbol || ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'Journaled Shares') { if (asFloat(base.amount) !== 0) { base.activityType = 'TAX'; base.symbol = ''; base.quantity = ''; base.unitPrice = ''; base.instrumentType = ''; output.push(base); } continue; }
      throw new Error(`未支援的 Schwab Action：${action}`);
    } catch (error) { issue(issues, line, error instanceof Error ? error.message : String(error)); }
  }
  return output;
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
      const priceDecimal = grossDecimal.gt(0) && quantityDecimal.gt(0) ? grossDecimal.div(quantityDecimal) : navDecimal;
      // Keep the consideration for each fund leg as the trade amount. For a
      // conversion, 總金額 is the shared net amount transferred between
      // the outgoing and incoming funds, so using it would make both legs look
      // identical and hide their respective fees.
      const amount = absoluteMoney(row['交易金額（含手續費）'] || row['交易金額'] || row['總金額']);
      const trade: NormalizedActivity = { ...empty(), date, symbol: row['基金代碼'], instrumentType: 'FUND', quantity: quantityDecimal.toString(), activityType: type, unitPrice: priceDecimal.toFixed(8), currency, fee: decimalString(feeDecimal), amount, comment: `基富通 | ${(row['基金名稱'] || '').replace(/^【[^】]*】/, '')} | ${row['交易類別']}` };
      output.push(trade);
    } catch (error) { issue(issues, line, error instanceof Error ? error.message : String(error)); }
  }
  return output.sort((a, b) => a.date.localeCompare(b.date));
}

export function convert(broker: BrokerKind, rows: Array<Record<string, string>>): ConversionResult {
  const issues: ConversionIssue[] = []; let activities: NormalizedActivity[];
  if (broker === 'fubon') activities = fubon(rows, issues); else if (broker === 'sinopac') activities = sinopac(rows, issues); else if (broker === 'schwab') activities = schwab(rows, issues); else activities = fundrich(rows, issues);
  return { broker, sourceRows: rows.length, activities: dedupe(validateNormalizedActivities(activities, issues)), issues };
}
