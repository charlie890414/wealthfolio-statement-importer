import Big from 'big.js';
import type { ActivityImport } from '@wealthfolio/addon-sdk';

export interface ExistingActivityForDedupe {
  id: string;
  accountId?: string;
  date?: string | Date;
  activityType?: string;
  subtype?: string | null;
  assetId?: string | null;
  assetSymbol?: string | null;
  symbol?: string | null;
  exchangeMic?: string | null;
  quantity?: string | number | null;
  unitPrice?: string | number | null;
  amount?: string | number | null;
  fee?: string | number | null;
  tax?: string | number | null;
  currency?: string | null;
}

const CASH_TYPES = new Set(['DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'CREDIT', 'INTEREST']);
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'TWD', 'VND']);
const text = (value: unknown) => String(value ?? '').trim();
const dateOnly = (value: unknown, timezone?: string) => {
  const formatCalendarDate = (date: Date) => {
    try {
      const parts = new Intl.DateTimeFormat('en', {
        timeZone: timezone?.trim() || undefined,
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(date);
      const fields = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
      return `${fields.year}-${fields.month}-${fields.day}`;
    } catch {
      return date.toISOString().slice(0, 10);
    }
  };
  if (value instanceof Date && !Number.isNaN(value.getTime())) return formatCalendarDate(value);
  const s = text(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ActivityDetails is typed as Date, but hosts may serialize it as an ISO
  // string or an epoch value across the addon boundary.
  const parsed = s ? new Date(s) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) return formatCalendarDate(parsed);
  return s;
};
const decimal = (value: unknown) => {
  const s = text(value).replace(/[$£€(),]/g, '');
  if (!s) return '';
  try { return new Big(s).abs().toString(); } catch { return s; }
};
const field = (value: unknown) => decimal(value) || '';
const zeroField = (value: unknown) => field(value) || '0';
const totalCost = (activity: ActivityImport | ExistingActivityForDedupe) => {
  try {
    return new Big(field(activity.fee) || 0)
      .plus(field((activity as ExistingActivityForDedupe).tax) || 0);
  } catch { return new Big(0); }
};
const roundedMoney = (value: Big, currency: string) => {
  const scale = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
  return value.round(scale, Big.roundHalfUp).toFixed(scale);
};
const settlementAmount = (type: string, gross: Big, cost: Big) => {
  if (type === 'BUY') return gross.plus(cost);
  if (type === 'SELL') return gross.minus(cost);
  return gross;
};
const assetKeys = (activity: ActivityImport | ExistingActivityForDedupe) => {
  const values = [
    text((activity as ActivityImport).symbol),
    text((activity as ExistingActivityForDedupe).assetSymbol),
    text(activity.assetId),
  ].filter(Boolean).map((value) => value.toUpperCase());
  return [...new Set(values.length ? values : [''])];
};
const sameValues = (left: unknown, right: unknown) => field(left) === field(right);

/** Explains why a same-day, same-asset activity was not marked duplicate. */
export function sameDayNonDuplicateReason(
  activity: ActivityImport,
  existing: ExistingActivityForDedupe[],
  accountId: string,
  timezone?: string,
  related: ActivityImport[] = [],
): string | undefined {
  const type = text(activity.activityType).toUpperCase();
  const date = dateOnly(activity.date, timezone);
  const assets = new Set(assetKeys(activity));
  const batchCandidates: ExistingActivityForDedupe[] = related
    .filter((item) => item !== activity)
    .map((item, index) => ({ ...item, id: `batch-${item.lineNumber ?? index}` }));
  const candidates = [...existing, ...batchCandidates].filter((item) =>
    (text(item.accountId) || accountId) === accountId &&
    dateOnly(item.date, timezone) === date &&
    assetKeys(item).some((asset) => assets.has(asset)),
  );
  if (!candidates.length) return undefined;
  const item = candidates[0];
  if (text(item.activityType).toUpperCase() !== type) return `同日同標的，但買賣類型不同（${type || '—'}／${text(item.activityType).toUpperCase() || '—'}）`;
  if (!sameValues(activity.quantity, item.quantity)) return `同日同標的，但數量不同（${text(activity.quantity) || '—'}／${text(item.quantity) || '—'}）`;
  if (!sameValues(activity.unitPrice, item.unitPrice)) return `同日同標的，但單價不同（${text(activity.unitPrice) || '—'}／${text(item.unitPrice) || '—'}）`;
  if (!sameValues(activity.fee, item.fee) || !sameValues((activity as ActivityImport & { tax?: unknown }).tax, item.tax)) return '同日同標的，但費用或稅額不同';
  if (!sameValues(activity.amount, item.amount)) return `同日同標的，但金額不同（${text(activity.amount) || '—'}／${text(item.amount) || '—'}）`;
  if (text(activity.subtype).toUpperCase() !== text(item.subtype).toUpperCase()) return '同日同標的，但活動子類型不同';
  return '同日同標的，但交易內容不同';
}
const tradeSettlementKeys = (
  activity: ActivityImport | ExistingActivityForDedupe,
  role: 'import' | 'existing',
  type: string,
  currency: string,
) => {
  const cost = totalCost(activity);
  const candidates: string[] = [];
  const explicit = field(activity.amount);
  if (explicit) {
    const amount = new Big(explicit);
    // Addon imports carry broker settlement totals, while persisted Wealthfolio
    // trades normally carry gross consideration. Keep the raw existing amount
    // as a compatibility candidate for older imports that already stored net.
    candidates.push(roundedMoney(amount, currency));
    if (role === 'existing') {
      candidates.push(roundedMoney(settlementAmount(type, amount, cost), currency));
    }
  }
  const quantity = field(activity.quantity);
  const unitPrice = field(activity.unitPrice);
  if (quantity && unitPrice) {
    const gross = new Big(quantity).times(unitPrice);
    candidates.push(roundedMoney(settlementAmount(type, gross, cost), currency));
  }
  return [...new Set(candidates.length ? candidates : [''])];
};

function keys(
  activity: ActivityImport | ExistingActivityForDedupe,
  accountId: string,
  role: 'import' | 'existing',
  timezone?: string,
) {
  const type = text(activity.activityType).toUpperCase();
  const isCash = CASH_TYPES.has(type) && !text((activity as ActivityImport).assetId || (activity as ExistingActivityForDedupe).assetId);
  const currency = text(activity.currency).toUpperCase();
  const common = [
    accountId,
    dateOnly(activity.date, timezone),
    type,
    text(activity.subtype).toUpperCase(),
    currency,
  ];
  if (isCash) {
    return [[...common, field(activity.amount), field(activity.fee), zeroField((activity as ExistingActivityForDedupe).tax)].join('|')];
  }
  const cost = totalCost(activity).toString();
  const result: string[] = [];
  for (const asset of assetKeys(activity)) {
    for (const settlement of tradeSettlementKeys(activity, role, type, currency)) {
      result.push([...common, asset, field(activity.quantity), cost, settlement].join('|'));
    }
  }
  return [...new Set(result)];
}

/** Marks imported activities matching existing economic transactions, ignoring notes. */
export function markExistingDuplicates(
  activities: ActivityImport[],
  existing: ExistingActivityForDedupe[],
  accountId: string,
  timezone?: string,
): ActivityImport[] {
  const queues = new Map<string, string[]>();
  for (const item of existing) {
    for (const itemKey of keys(item, text(item.accountId) || accountId, 'existing', timezone)) {
      const queue = queues.get(itemKey) ?? [];
      queue.push(item.id);
      queues.set(itemKey, queue);
    }
  }
  const consumed = new Set<string>();
  return activities.map((activity) => {
    if (activity.duplicateOfId || activity.duplicateOfLineNumber) return activity;
    let id: string | undefined;
    for (const activityKey of keys(activity, accountId, 'import', timezone)) {
      const queue = queues.get(activityKey);
      id = queue?.find((candidate) => !consumed.has(candidate));
      if (id) break;
    }
    if (!id) return activity;
    consumed.add(id);
    return { ...activity, duplicateOfId: id, warnings: { ...(activity.warnings ?? {}), _duplicate: ['Duplicate activity already exists'] } };
  });
}
