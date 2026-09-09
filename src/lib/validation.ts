import { z } from 'zod';
import type { ActivityImport } from '@wealthfolio/addon-sdk';
import type { ConversionIssue, NormalizedActivity } from './types';

const activityTypes = ['BUY', 'SELL', 'SPLIT', 'DIVIDEND', 'INTEREST', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'CREDIT', 'ADJUSTMENT', 'UNKNOWN'] as const;

export const activityImportSchema = z.object({
  accountId: z.string().min(1), activityType: z.enum(activityTypes), isValid: z.boolean(), isDraft: z.boolean(),
  date: z.union([z.string(), z.date()]).optional(), currency: z.string().optional(), symbol: z.string().optional(), assetId: z.string().optional(),
  amount: z.union([z.number(), z.string(), z.null()]).optional(), quantity: z.union([z.number(), z.string(), z.null()]).optional(), unitPrice: z.union([z.number(), z.string(), z.null()]).optional(), fee: z.union([z.number(), z.string(), z.null()]).optional(), tax: z.union([z.number(), z.string(), z.null()]).optional(), fxRate: z.union([z.number(), z.string(), z.null()]).optional(),
  lineNumber: z.number().int().positive().optional(), duplicateOfId: z.string().optional(), duplicateOfLineNumber: z.number().int().positive().optional(),
}).passthrough();

export function parseCheckedActivities(value: unknown, batchNumber: number): ActivityImport[] {
  const result = z.array(activityImportSchema).safeParse(value);
  if (!result.success) throw new Error(`驗證第 ${batchNumber} 批回傳資料格式不符：${result.error.issues[0]?.message ?? '回傳資料格式不符'}`);
  return result.data as ActivityImport[];
}

export function assertValidCalendarDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`無法解析日期：${value}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) throw new Error(`無法解析日期：${value}`);
  return value;
}

const decimalText = z.string().refine((value) => value === '' || /^-?(?:\d+\.?\d*|\.\d+)$/.test(value), '必須是有效數字');
const normalizedActivitySchema = z.object({
  date: z.string().refine(isCalendarDate, '必須是有效日期'), symbol: z.string(), instrumentType: z.string(), quantity: decimalText,
  activityType: z.enum(activityTypes), unitPrice: decimalText, currency: z.string().min(1), fee: decimalText, tax: decimalText, amount: decimalText,
  fxRate: decimalText, subtype: z.string(), comment: z.string(), account: z.string(),
}).passthrough();

function isCalendarDate(value: string): boolean {
  try { assertValidCalendarDate(value); return true; } catch { return false; }
}

export function validateNormalizedActivities(rows: NormalizedActivity[], issues: ConversionIssue[]): NormalizedActivity[] {
  return rows.filter((row) => {
    const result = normalizedActivitySchema.safeParse(row);
    if (result.success) return true;
    issues.push({ severity: 'error', message: `轉換結果格式不符：${result.error.issues[0]?.message ?? '資料無效'}` });
    return false;
  });
}
