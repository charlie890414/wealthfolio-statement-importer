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
  notes?: string | null;
}

const CASH_TYPES = new Set(['DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'CREDIT', 'INTEREST', 'DIVIDEND']);
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
const hasExplicitAmount = (activity: ActivityImport | ExistingActivityForDedupe) => field(activity.amount) !== '';
const zeroField = (value: unknown) => field(value) || '0';
const normalizedSubtype = (value: unknown) => {
  const subtype = text(value).toUpperCase();
  return ({
    POSITION_OPEN: 'OPTION_OPEN',
    POSITION_CLOSE: 'OPTION_CLOSE',
    OPTION_EXPIRY: 'OPTION_EXPIRE',
    'OPTION EXPIRY': 'OPTION_EXPIRE',
  } as Record<string, string>)[subtype] ?? subtype;
};
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
  const subtype = normalizedSubtype(activity.subtype);
  const description = text((activity as ActivityImport).comment || (activity as ExistingActivityForDedupe).notes)
    .replace(/\s+/g, ' ')
    .toUpperCase();
  // Some historical Wealthfolio rows have no asset_id/symbol for options.
  // Their normalized description is still a stable identity shared with the
  // Schwab export, so use it as a fallback only for options or symbol-less rows.
  if (description && (!values.length || subtype.startsWith('OPTION_'))) values.push(`NOTE:${description}`);
  return [...new Set(values.length ? values : [''])];
};
const sameValues = (left: unknown, right: unknown) => field(left) === field(right);
const sameAuthoritativeEconomics = (
  imported: ActivityImport,
  existing: ExistingActivityForDedupe,
  currency: string,
) => {
  if (!hasExplicitAmount(imported) || !hasExplicitAmount(existing)) return true;
  const sameFinalAmount = roundedMoney(new Big(field(imported.amount)), currency)
    === roundedMoney(new Big(field(existing.amount)), currency);
  // Host quote resolution may change insignificant display precision, but a
  // materially different execution price must not be hidden by an equal final
  // cash amount.
  const normalizedPrice = (value: unknown) => new Big(field(value) || 0).round(2, Big.roundHalfUp).toFixed(2);
  if (normalizedPrice(imported.unitPrice) !== normalizedPrice(existing.unitPrice)) return false;
  if (sameFinalAmount) return true;
  // A migrated legacy row can retain a fractional pre-rounding amount while
  // the broker import carries the rounded settlement. Allow only one minor
  // unit of this compatibility drift; larger final-amount differences are
  // distinct transactions under the 3.8 contract.
  const difference = Math.abs(Number(field(imported.amount)) - Number(field(existing.amount)));
  const minorUnit = ZERO_DECIMAL_CURRENCIES.has(currency) ? 1 : 0.01;
  return difference <= minorUnit;
};
const optionMultiplier = (activity: ActivityImport | ExistingActivityForDedupe) => {
  const subtype = normalizedSubtype(activity.subtype);
  const symbols = assetKeys(activity);
  return subtype.startsWith('OPTION_') || symbols.some((symbol) => /^[A-Z0-9]{1,6}\d{6}[CP]\d{8}$/.test(symbol))
    ? new Big(100)
    : new Big(1);
};

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
  const candidates = [...existing, ...batchCandidates].filter((item) => {
    if ((text(item.accountId) || accountId) !== accountId || dateOnly(item.date, timezone) !== date) return false;
    const itemType = text(item.activityType).toUpperCase();
    return CASH_TYPES.has(type) ? itemType === type : assetKeys(item).some((asset) => assets.has(asset));
  });
  if (!candidates.length) return undefined;
  const item = candidates[0];
  if (text(item.activityType).toUpperCase() !== type) return `同日同標的，但買賣類型不同（${type || '—'}／${text(item.activityType).toUpperCase() || '—'}）`;
  if (!sameValues(activity.quantity, item.quantity)) return `同日同標的，但數量不同（${text(activity.quantity) || '—'}／${text(item.quantity) || '—'}）`;
  if (!sameValues(activity.unitPrice, item.unitPrice)) return `同日同標的，但單價不同（${text(activity.unitPrice) || '—'}／${text(item.unitPrice) || '—'}）`;
  if (!sameValues(activity.fee, item.fee) || !sameValues((activity as ActivityImport & { tax?: unknown }).tax, item.tax)) return '同日同標的，但費用或稅額不同';
  if (!sameValues(activity.amount, item.amount)) return `同日同標的，但金額不同（${text(activity.amount) || '—'}／${text(item.amount) || '—'}）`;
  if (normalizedSubtype(activity.subtype) !== normalizedSubtype(item.subtype)) return '同日同標的，但活動子類型不同';
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
  const quantity = field(activity.quantity);
  const unitPrice = field(activity.unitPrice);
  const explicit = field(activity.amount);
  if (explicit) {
    // Wealthfolio 3.8 defines amount as final cash. Include the execution
    // price in this key so two same-day fills with the same settlement but
    // different economics are not collapsed into one duplicate. The plain
    // settlement candidate below remains for legacy rows whose stored amount
    // was gross and must be compared through quantity × price + charges.
    candidates.push(`final:${roundedMoney(new Big(explicit), currency)}:${unitPrice}`);
  }
  // When quantity and execution price are both available, they are the
  // authoritative trade identity. Using amount as an independent candidate
  // would mark a corrected import as duplicate of an older row whose price was
  // overwritten by a market quote but whose amount happened to remain intact.
  if (explicit && (!quantity || !unitPrice)) {
    const amount = new Big(explicit);
    // Addon imports carry broker settlement totals, while persisted Wealthfolio
    // trades normally carry gross consideration. Keep the raw existing amount
    // as a compatibility candidate only for older rows lacking price data.
    candidates.push(roundedMoney(amount, currency));
    if (role === 'existing') {
      candidates.push(roundedMoney(settlementAmount(type, amount, cost), currency));
    }
  }
  if (quantity && unitPrice) {
    const gross = new Big(quantity).times(unitPrice).times(optionMultiplier(activity));
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
  const isCash = CASH_TYPES.has(type);
  const currency = text(activity.currency).toUpperCase();
  const common = [
    accountId,
    dateOnly(activity.date, timezone),
    type,
    normalizedSubtype(activity.subtype),
    currency,
  ];
  if (isCash) {
    // Keep a missing amount distinct from an explicit zero. Wealthfolio 3.8
    // treats these differently during review and migration.
    const amountField = hasExplicitAmount(activity) ? field(activity.amount) : 'MISSING';
    const base = [...common, amountField, zeroField(activity.fee), zeroField((activity as ExistingActivityForDedupe).tax)];
    const result = [base.join('|')];
    // Keep a more specific key as a secondary candidate when the broker
    // provides a ticker. The amount-only key remains the fallback for older
    // DB rows whose cash activity is attached to a different asset (or none).
    for (const asset of assetKeys(activity)) result.push([...common, asset, ...base.slice(common.length)].join('|'));
    return [...new Set(result)];
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
  const existingById = new Map(existing.map((item) => [item.id, item]));
  for (const item of existing) {
    for (const itemKey of keys(item, text(item.accountId) || accountId, 'existing', timezone)) {
      const queue = queues.get(itemKey) ?? [];
      queue.push(item.id);
      queues.set(itemKey, queue);
    }
  }
  const consumed = new Set<string>();
  const matched = activities.map((activity) => {
    if (activity.duplicateOfId || activity.duplicateOfLineNumber) return activity;
    let id: string | undefined;
    for (const activityKey of keys(activity, accountId, 'import', timezone)) {
      const queue = queues.get(activityKey);
      id = queue?.find((candidate) => {
        if (consumed.has(candidate)) return false;
        const existingItem = existingById.get(candidate);
        return !existingItem || sameAuthoritativeEconomics(activity, existingItem, text(activity.currency).toUpperCase());
      });
      if (id) break;
    }
    if (!id) return activity;
    consumed.add(id);
    return { ...activity, duplicateOfId: id, warnings: { ...(activity.warnings ?? {}), _duplicate: ['Duplicate activity already exists'] } };
  });

  // Older imports may merge same-day fills into a single weighted-average
  // activity. Compare the remaining trade groups economically so a split CSV
  // group can be recognized as already covered by one merged database row.
  const groupKey = (activity: ActivityImport | ExistingActivityForDedupe, fallbackAccountId: string) => {
    const type = text(activity.activityType).toUpperCase();
    if (type !== 'BUY' && type !== 'SELL') return '';
    const asset = assetKeys(activity).find((value) => value) ?? '';
    if (!asset) return '';
    return [
      text((activity as ExistingActivityForDedupe).accountId) || fallbackAccountId,
      dateOnly(activity.date, timezone),
      type,
      normalizedSubtype(activity.subtype),
      text(activity.currency).toUpperCase(),
      asset,
    ].join('|');
  };
  const aggregate = (items: Array<ActivityImport | ExistingActivityForDedupe>) => {
    let quantity = new Big(0);
    let notional = new Big(0);
    let settlement = new Big(0);
    let cost = new Big(0);
    for (const item of items) {
      const itemQuantity = new Big(field(item.quantity) || 0);
      const itemCost = totalCost(item);
      const itemType = text(item.activityType).toUpperCase();
      const unitPrice = field(item.unitPrice);
      const explicitAmount = field(item.amount);
      const itemSettlement = explicitAmount
        ? new Big(explicitAmount).abs()
        : unitPrice
          ? settlementAmount(itemType, itemQuantity.times(unitPrice).times(optionMultiplier(item)), itemCost)
          : new Big(0);
      quantity = quantity.plus(itemQuantity);
      if (unitPrice) notional = notional.plus(itemQuantity.times(unitPrice).times(optionMultiplier(item)));
      cost = cost.plus(itemCost);
      settlement = settlement.plus(itemSettlement);
    }
    return { quantity, notional, settlement, cost };
  };
  const importGroups = new Map<string, number[]>();
  matched.forEach((activity, index) => {
    if (activity.duplicateOfId || activity.duplicateOfLineNumber) return;
    const key = groupKey(activity, accountId);
    if (!key) return;
    importGroups.set(key, [...(importGroups.get(key) ?? []), index]);
  });
  const existingGroups = new Map<string, ExistingActivityForDedupe[]>();
  existing.forEach((item) => {
    if (consumed.has(item.id)) return;
    const key = groupKey(item, accountId);
    if (!key) return;
    existingGroups.set(key, [...(existingGroups.get(key) ?? []), item]);
  });
  for (const [key, indexes] of importGroups) {
    const existingItems = existingGroups.get(key);
    if (!existingItems?.length || indexes.length < 2) continue;
    const importedTotal = aggregate(indexes.map((index) => matched[index]));
    const existingTotal = aggregate(existingItems);
    const currency = text(matched[indexes[0]].currency).toUpperCase();
    if (
      importedTotal.quantity.round(8).eq(existingTotal.quantity.round(8)) &&
      importedTotal.notional.round(8).eq(existingTotal.notional.round(8)) &&
      roundedMoney(importedTotal.settlement, currency) === roundedMoney(existingTotal.settlement, currency) &&
      roundedMoney(importedTotal.cost, currency) === roundedMoney(existingTotal.cost, currency)
    ) {
      const representativeId = existingItems[0].id;
      indexes.forEach((index) => {
        const activity = matched[index];
        matched[index] = {
          ...activity,
          duplicateOfId: representativeId,
          warnings: { ...(activity.warnings ?? {}), _duplicate: ['Duplicate activity covered by an existing merged same-day trade'] },
        };
      });
      existingItems.forEach((item) => consumed.add(item.id));
    }
  }
  return matched;
}
