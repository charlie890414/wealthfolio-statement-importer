import type { ActivityImport } from '@wealthfolio/addon-sdk';
import type { NormalizedActivity } from './types';
import { parseCheckedActivities } from './validation';

export const IMPORT_CHECK_BATCH_SIZE = 50;

type CheckImport = (activities: ActivityImport[]) => Promise<ActivityImport[]>;
type ProgressCallback = (completed: number, total: number) => void;

export interface ImportRowWithLine {
  lineNumber?: number;
}

export type CheckedActivity = ActivityImport & { source: NormalizedActivity };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Converts a broker calendar date to the instant representing midnight in an IANA timezone. */
export function dateAtLocalMidnight(date: string, timezone: string): string {
  const match = date.match(DATE_ONLY);
  if (!match) return date;

  const target = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day);
  let candidate = targetAsUtc;

  // Recalculate the timezone offset at the candidate instant. Iterating also
  // handles daylight-saving offsets without relying on the machine timezone.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const representedAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const next = candidate + targetAsUtc - representedAsUtc;
    if (next === candidate) break;
    candidate = next;
  }

  return new Date(candidate).toISOString();
}

export function activityFromSource(
  source: NormalizedActivity,
  lineNumber: number,
  accountId: string,
  timezone?: string,
): CheckedActivity {
  return {
    accountId,
    currency: source.currency,
    activityType: source.activityType as ActivityImport['activityType'],
    date: timezone ? dateAtLocalMidnight(source.date, timezone) : source.date,
    symbol: source.symbol,
    amount: source.amount || null,
    quantity: source.quantity || null,
    unitPrice: source.unitPrice || null,
    fee: source.fee || null,
    fxRate: source.fxRate || null,
    subtype: source.subtype || undefined,
    instrumentType: source.instrumentType || undefined,
    exchangeMic: source.exchangeMic,
    quoteCcy: source.quoteCcy,
    providerId: source.providerId,
    providerSymbol: source.providerSymbol,
    symbolName: source.symbolName,
    isValid: true,
    lineNumber,
    isDraft: false,
    comment: source.comment,
    source,
  };
}

export function selectImportRows<T extends ImportRowWithLine>(rows: readonly T[], selected: ReadonlySet<number>): T[] {
  return rows.filter((row, index) => selected.has(row.lineNumber ?? index + 1));
}

export function allImportRowNumbers<T extends ImportRowWithLine>(rows: readonly T[]): Set<number> {
  return new Set(rows.map((row, index) => row.lineNumber ?? index + 1));
}

export async function checkImportInBatches(
  activities: ActivityImport[],
  checkImport: CheckImport,
  onProgress?: ProgressCallback,
  batchSize = IMPORT_CHECK_BATCH_SIZE,
): Promise<ActivityImport[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('驗證批次大小必須是正整數');
  }

  const total = activities.length;
  const totalBatches = Math.ceil(total / batchSize);
  const checked: ActivityImport[] = [];

  for (let start = 0; start < total; start += batchSize) {
    const end = Math.min(start + batchSize, total);
    const batchNumber = Math.floor(start / batchSize) + 1;
    const batch = activities.slice(start, end);
    let result: ActivityImport[];

    try {
      result = parseCheckedActivities(await checkImport(batch), batchNumber);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`驗證第 ${batchNumber}/${totalBatches} 批（第 ${start + 1}-${end} 筆）失敗：${detail}`);
    }

    if (result.length !== batch.length) {
      throw new Error(`驗證第 ${batchNumber}/${totalBatches} 批（第 ${start + 1}-${end} 筆）回傳筆數不符：送出 ${batch.length} 筆，收到 ${result.length} 筆`);
    }

    checked.push(...result);
    onProgress?.(checked.length, total);
  }

  return checked;
}
