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
const CTBC_ESPP_AVERAGE_HEADERS = ['日期', '類型', '股數', '均價', '標的'];
const CTBC_ESPP_SOURCE_HEADERS = [...CTBC_ESPP_AVERAGE_HEADERS, '申購金額'];
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
  if (CTBC_ESPP_SOURCE_HEADERS.every((header) => headers.includes(header))) return { broker: 'ctbc_espp', missing: [] };
  if (CTBC_ESPP_PURCHASE_HEADERS.every((header) => headers.includes(header))) return { broker: 'ctbc_espp', missing: [] };
  if (CTBC_ESPP_AVERAGE_HEADERS.every((header) => headers.includes(header))) return { broker: 'ctbc_espp', missing: [] };
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

const schwabOption = (action: string) => ({ 'Sell to Open': ['SELL', 'POSITION_OPEN'], 'Buy to Open': ['BUY', 'POSITION_OPEN'], 'Sell to Close': ['SELL', 'POSITION_CLOSE'], 'Buy to Close': ['BUY', 'POSITION_CLOSE'], Expired: ['ADJUSTMENT', 'OPTION_EXPIRY'] } as Record<string, string[]>)[action];
const occ = (symbol: string) => { const m = symbol.match(/^(.+?)\s+(\d{2})\/(\d{2})\/(\d{4})\s+([\d.]+)\s+([CP])$/); if (!m) return symbol; return `${m[1].trim().toUpperCase().slice(0, 6)}${m[4].slice(-2)}${m[2]}${m[3]}${m[6]}${decimal(m[5]).times(1000).round().toString().padStart(8, '0')}`; };
const isBond = (symbol: string) => /^[A-Z0-9]{9}$/.test(symbol) && /\d/.test(symbol);
const schwabDividendSymbol = (symbol: string, description: string) => {
  if (symbol) return symbol;
  // Older Schwab/TDA rows put the ticker only in descriptions such as
  // "TDA TRAN - ORDINARY DIVIDEND (VOO)".
  return description.match(/\(([A-Z0-9.:-]+)\)\s*$/i)?.[1]?.toUpperCase() || '';
};

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

interface InferredSplit {
  ratio: string;
  date: string;
  detail: string;
}

const schwabDate = (row: Record<string, string>) => isoDate(
  row.Date.split(' as of ')[0], ['MM/DD/YYYY']);

/** Infer only exact forward integer splits from the source share ledger.
 * Consecutive split postings may contain whole-share and fractional deliveries.
 * An intervening trade, unknown transfer or negative balance prevents inference.
 */
function inferSchwabSplits(rows: Array<Record<string, string>>, excluded: Set<number>) {
  const plans = new Map<number, InferredSplit>();
  const consumed = new Set<number>();
  const bySymbol = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (excluded.has(index) || !row.Symbol?.trim()) return;
    if (!['Buy', 'Sell', 'Reinvest Shares', 'Stock Split', 'Internal Transfer', 'Journaled Shares'].includes(row.Action?.trim())) return;
    const symbol = row.Symbol.trim();
    bySymbol.set(symbol, [...(bySymbol.get(symbol) || []), index]);
  });
  for (const indexes of bySymbol.values()) {
    try {
      indexes.sort((a, b) => schwabDate(rows[a]).localeCompare(schwabDate(rows[b])) || a - b);
      let balance = new Big(0);
      let known = true;
      for (let position = 0; position < indexes.length; position += 1) {
        const index = indexes[position];
        const row = rows[index];
        if (row.Action === 'Stock Split') {
          if (money(row['Split Ratio'])) {
            balance = balance.times(decimal(row['Split Ratio']));
            continue;
          }
          const group = [index];
          const startDate = schwabDate(row);
          while (position + 1 < indexes.length) {
            const delivered = group.reduce((total, item) => total.plus(decimal(rows[item].Quantity)), new Big(0));
            if (balance.gt(0) && delivered.gt(0) && balance.plus(delivered).mod(balance).eq(0)) break;
            const next = rows[indexes[position + 1]];
            if (next.Action !== 'Stock Split' || money(next['Split Ratio']) ||
                Date.parse(schwabDate(next)) - Date.parse(startDate) > 7 * 86400000) break;
            group.push(indexes[++position]);
          }
          const delta = group.reduce((total, item) => total.plus(decimal(rows[item].Quantity)), new Big(0));
          const after = balance.plus(delta);
          // Do not round a nearly integral ratio into a supposed split.
          if (known && balance.gt(0) && delta.gt(0) && after.mod(balance).eq(0)) {
            const ratio = after.div(balance);
            const date = schwabDate(rows[group[group.length - 1]]);
            const detail = group.map((item) => `CSV列${item + 2}:日期=${rows[item].Date},新增股數=${rows[item].Quantity},原始價格=${rows[item].Price || '空白'}`).join(' | ');
            plans.set(group[0], { ratio: ratio.toString(), date,
              detail: `推算拆股比例 ${ratio}:1；來源拆股前股數 ${balance} + 新增 ${delta} = ${after}；以CSV歷史完整為前提 | ${detail}` });
            group.slice(1).forEach((item) => consumed.add(item));
          }
          balance = after;
        } else if (row.Action === 'Buy' || row.Action === 'Reinvest Shares') {
          balance = balance.plus(decimal(row.Quantity).abs());
        } else if (row.Action === 'Sell') {
          balance = balance.minus(decimal(row.Quantity).abs());
          if (balance.lt(0)) known = false;
        } else {
          known = false;
        }
      }
    } catch { /* Invalid source rows are reported by the converter; no guesses. */ }
  }
  return { plans, consumed };
}

function schwab(rows: Array<Record<string, string>>, issues: ConversionIssue[]): NormalizedActivity[] {
  const output: NormalizedActivity[] = [];
  const tdaMigrationRows = schwabTdaMigrationRowIndexes(rows);
  const splits = inferSchwabSplits(rows, tdaMigrationRows);
  const assignedStockRows = new Set<Record<string, string>>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]; const line = i + 2; const action = row.Action?.trim();
    try {
      if (tdaMigrationRows.has(i) || splits.consumed.has(i)) continue;
      if (action === 'Journal') continue;
      const date = schwabDate(row); const rawSymbol = row.Symbol?.trim(); const symbol = occ(rawSymbol); const desc = row.Description?.trim() || ''; const descUpper = desc.toUpperCase();
      const base: NormalizedActivity = { ...empty(), date, symbol, instrumentType: inferInstrumentType({ broker: 'schwab', symbol: rawSymbol, name: desc, action }), quantity: absoluteMoney(row.Quantity), unitPrice: money(row.Price), fee: absoluteMoney(row['Fees & Comm']), amount: absoluteMoney(row.Amount), currency: 'USD', comment: desc };
      if (isBond(rawSymbol || '')) {
        if (action === 'Full Redemption' || action === 'Full Redemption Adj') {
          const pairedAction = action === 'Full Redemption' ? 'Full Redemption Adj' : 'Full Redemption';
          const pairs = rows.filter((candidate) => candidate.Symbol?.trim() === rawSymbol && candidate.Date === row.Date && candidate.Action?.trim() === pairedAction);
          if (pairs.length !== 1) throw new Error('債券到期找不到唯一對應的原始本金／面額紀錄');
          const security = action === 'Full Redemption' ? row : pairs[0];
          const cash = action === 'Full Redemption Adj' ? row : pairs[0];
          let price = money(security.Price) || money(cash.Price);
          if (!number(security.Quantity) || !decimal(security.Quantity).lt(0) ||
              !number(cash.Amount) || !decimal(cash.Amount).gt(0)) throw new Error('債券到期須有負的沖銷面額及正的原始本金');
          if (!decimal(security.Amount).eq(0) || !decimal(cash.Quantity).eq(0)) throw new Error('債券到期配對紀錄含額外本金或面額，不能重複計入');
          if (money(security.Price) && money(cash.Price) && !decimal(security.Price).eq(decimal(cash.Price))) throw new Error('債券到期配對原始價格不同');
          const fee = decimal(security['Fees & Comm']).abs().plus(decimal(cash['Fees & Comm']).abs());
          const parException = !price;
          if (parException) {
            if (!/MATURED|MATURITY|到期/i.test(`${security.Description} ${cash.Description}`) ||
                !decimal(security.Quantity).abs().eq(decimal(cash.Amount)) || !fee.eq(0)) {
              throw new Error('到期按面額贖回特例不適用：須確認到期、本金等於沖銷面額且無費用；不得推算價格');
            }
            price = '100';
          }
          if (!decimal(price).gt(0)) throw new Error('債券到期價格必須大於0');
          if (action === 'Full Redemption Adj') continue;
          if (parException) {
            const explanation = '到期按面額全額贖回特例：每百元價格100，非CSV原始價格；本金保留原始Amount';
            base.comment += ` | ${explanation}`;
            issue(issues, line, explanation, 'warning');
          }
          base.activityType = 'SELL'; base.unitPrice = price; base.amount = absoluteMoney(cash.Amount); base.fee = fee.toString();
          base.quantity = decimal(security.Quantity).abs().div(100).toString();
          base.comment += ` | 到期本金來自配對原始紀錄；原始面額:${number(security.Quantity)} USD；每單位100 USD面額`;
          output.push(base); continue;
        }
        if (!['Buy', 'Sell'].includes(action)) throw new Error(`未支援的債券交易：${action}`);
        if (!base.quantity || !decimal(base.quantity).gt(0)) throw new Error('債券缺少正的原始面額');
        base.quantity = decimal(base.quantity).div(100).toString();
        base.comment += ` | 原始面額:${number(row.Quantity)} USD；每單位代表100 USD面額，價格保留每百元報價`;
      }
      const option = schwabOption(action);
      if (option) { if (action === 'Expired' && base.amount && !decimal(base.amount).eq(0)) throw new Error('到期紀錄包含非零現金，不能以無現金平倉替代'); if (!base.quantity || !decimal(base.quantity).gt(0)) throw new Error('選擇權缺少正的原始合約數'); base.activityType = option[0]; base.subtype = option[1]; base.instrumentType = 'OPTION'; output.push(base); continue; }
      if (action === 'Assigned') {
        if (base.amount && !decimal(base.amount).eq(0)) throw new Error('指派合約包含非零現金，不能以無現金平倉替代');
        const contract = rawSymbol.match(/^(.+?)\s+\d{2}\/\d{2}\/\d{4}\s+([\d.]+)\s+([CP])$/);
        if (!contract || !base.quantity || !decimal(base.quantity).gt(0)) throw new Error('指派缺少有效原始合約代號或合約數');
        const delivered = decimal(base.quantity).times(100);
        const side = contract[3] === 'P' ? 'Buy' : 'Sell';
        const matches = rows.filter((candidate) => candidate.Symbol?.trim() === contract[1].trim()
          && candidate.Action?.trim() === side
          && candidate.Date === row.Date
          && decimal(candidate.Quantity).abs().eq(delivered)
          && decimal(candidate.Price).eq(decimal(contract[2]))
          && number(candidate.Amount) !== '');
        if (matches.length !== 1 || assignedStockRows.has(matches[0])) throw new Error('指派找不到唯一且未使用的原始股票交割交易；不推算股票數量、價格或金額');
        assignedStockRows.add(matches[0]);
        base.activityType = 'ADJUSTMENT'; base.subtype = 'OPTION_EXPIRY'; base.instrumentType = 'OPTION';
        base.comment += ' | Assigned：關閉原始合約數；股票交割採用CSV既有買賣，不另造交易';
        output.push(base); continue;
      }
      if (action === 'Stock Split') {
        const inferred = splits.plans.get(i);
        const ratio = money(row['Split Ratio']) || inferred?.ratio;
        if (!ratio || !decimal(ratio).gt(0)) throw new Error('拆股缺少原始比例，且無法由來源持倉精確推算；需完整買賣歷史與可核對的增配股數');
        if (inferred) {
          base.date = inferred.date; base.quantity = ''; base.unitPrice = '';
          base.comment += ` | ${inferred.detail}`;
          issue(issues, line, inferred.detail, 'warning');
        }
        base.activityType = 'SPLIT'; base.quantity = ''; base.unitPrice = ''; base.amount = decimal(ratio).toString();
        base.comment += ` | 原始增配股數:${number(row.Quantity)}；amount為拆股比例，非現金總價`;
        output.push(base); continue;
      }
      if (action === 'Full Redemption' || action === 'Full Redemption Adj') throw new Error('贖回交易尚未完成原始價格、數量與金額的映射；不可推算補值');
      if (action === 'Buy' || action === 'Reinvest Shares' || action === 'Sell') { base.activityType = action === 'Sell' ? 'SELL' : 'BUY'; if (isBond(symbol)) base.instrumentType = 'BOND'; output.push(base); continue; }
      if (['Cash Dividend', 'Qualified Dividend', 'Reinvest Dividend', 'Qual Div Reinvest'].includes(action)) { base.activityType = 'DIVIDEND'; base.symbol = schwabDividendSymbol(rawSymbol, desc);  base.instrumentType = ''; output.push(base); continue; }
      if (['Bond Interest', 'Credit Interest'].includes(action)) { base.activityType = 'INTEREST'; base.symbol = ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'ADR Mgmt Fee') { base.activityType = 'FEE'; base.subtype = 'ADR_FEE'; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'Foreign Tax Paid') { base.activityType = 'TAX'; base.subtype = 'WITHHOLDING'; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'NRA Tax Adj' || (action === 'Journaled Shares' && descUpper.includes('W-8 WITHHOLDING'))) { base.activityType = 'TAX'; base.symbol = ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'MoneyLink Transfer' || action === 'Wire Received') { base.activityType = action === 'Wire Received' || asFloat(row.Amount) >= 0 ? 'DEPOSIT' : 'WITHDRAWAL'; base.symbol = ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'Internal Transfer') { base.activityType = asFloat(row.Amount) >= 0 ? 'DEPOSIT' : 'WITHDRAWAL'; base.symbol = rawSymbol || ''; base.instrumentType = ''; output.push(base); continue; }
      if (action === 'Journaled Shares') {
        if (!asFloat(base.amount)) continue;
        if (descUpper.includes('CASH MOVEMENT OF OUTGOING ACCOUNT TRANSFER')) base.activityType = 'WITHDRAWAL';
        else if (descUpper.includes('EF RETURN FEE')) base.activityType = 'FEE';
        else throw new Error(`未支援的 Schwab Journaled Shares 現金交易：${desc || row.Amount}`);
        base.symbol = ''; base.instrumentType = ''; output.push(base); continue;
      }
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
      const grossDecimal = decimal(row['交易金額（含手續費）'] || row['交易金額']); const quantityDecimal = decimal(row['單位數']); const navPrice = money(row['淨值']);
      const explicitFee = decimal(row['手續費用']).plus(decimal(row['其他費用']));
      const transferNet = decimal(row['總金額']);
      const inferredTransferFee = row['交易類別'].startsWith('轉換') && grossDecimal.gt(0) && transferNet.gt(0)
        ? grossDecimal.minus(transferNet).abs()
        : new Big(0);
      const feeDecimal = explicitFee.gt(0) ? explicitFee : inferredTransferFee;
      const amount = absoluteMoney(row['總金額']);
      const trade: NormalizedActivity = { ...empty(), date, symbol: row['基金代碼'], instrumentType: 'FUND', quantity: quantityDecimal.toString(), activityType: type, unitPrice: navPrice, currency, fee: decimalString(feeDecimal), amount, comment: `基富通 | ${(row['基金名稱'] || '').replace(/^【[^】]*】/, '')} | ${row['交易類別']}` };
      output.push(trade);
    } catch (error) { issue(issues, line, error instanceof Error ? error.message : String(error)); }
  }
  return output.sort((a, b) => a.date.localeCompare(b.date));
}

function ctbcEspp(rows: Array<Record<string, string>>, issues: ConversionIssue[]): NormalizedActivity[] {
  const output: NormalizedActivity[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    try {
      if ('類型' in row) {
        const type = row['類型']?.trim();
        if (type === '轉出') continue;
        if (type !== '買入') throw new Error(`未支援的 ESPP 類型：${type || ''}`);
      }
      const date = isoDate(row['日期'] ?? row['買入日期'] ?? '');
      const target = row['標的']?.trim() || '';
      if (!target) throw new Error('缺少標的');
      const quantity = decimal(row['股數']);
      if (quantity.lte(0)) throw new Error('股數必須大於 0');
      if (!row['均價']?.trim()) throw new Error('缺少原始均價；不可依申購金額推算價格');
      const unitPrice = decimal(row['均價']);
      if (unitPrice.lte(0)) throw new Error('均價必須大於 0');
      if (!row['申購金額']?.trim()) throw new Error('缺少原始申購金額；不可依股數與均價推算總價');
      const amount = decimal(row['申購金額']);
      if (amount.lte(0)) throw new Error('申購金額必須大於 0');
      const deposit = row['提存別']?.trim();
      if ('提存別' in row && !['公提', '自提'].includes(deposit || '')) throw new Error('提存別必須為公提或自提');
      const [symbol] = target.split(/\s+/);
      output.push({
        ...empty(), date, symbol, activityType: 'BUY', quantity: quantity.toString(),
        unitPrice: unitPrice.toString(), amount: amount.toString(), currency: 'TWD', fee: '0',
        comment: `CTBC ESPP | ${target}${deposit ? ` | ${deposit}` : ''}`,
      });
    } catch (error) { issue(issues, i + 2, error instanceof Error ? error.message : String(error)); }
  }
  // Never submit partial or missing economics for the host to derive.
  return issues.some((item) => item.severity === 'error') ? [] : output;
}

export function convert(broker: BrokerKind, rows: Array<Record<string, string>>): ConversionResult {
  const issues: ConversionIssue[] = []; let activities: NormalizedActivity[];
  if (broker === 'fubon') activities = fubon(rows, issues); else if (broker === 'sinopac') activities = sinopac(rows, issues); else if (broker === 'schwab') activities = schwab(rows, issues); else if (broker === 'fundrich') activities = fundrich(rows, issues); else activities = ctbcEspp(rows, issues);
  // Require independent source economics before submitting to host validation.
  return { broker, sourceRows: rows.length, activities: validateNormalizedActivities(activities.filter((activity) => {
    const required = ['BUY', 'SELL'].includes(activity.activityType)
      ? ['quantity', 'unitPrice', 'amount'] as const
      : ['ADJUSTMENT', 'SPLIT'].includes(activity.activityType) ? [] : ['amount'] as const;
    const missing = required.filter((field) => activity[field].trim() === '');
    if (!missing.length) return true;
    issues.push({ severity: 'error', message: `${activity.date} ${activity.symbol} ${activity.activityType} 缺少原始欄位 ${missing.join('、')}；不可推算補值` });
    return false;
  }), issues), issues };
}
