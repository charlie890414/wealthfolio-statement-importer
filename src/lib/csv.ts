import type { ParsedCsv, NormalizedActivity } from './types';
import { CSV_FIELDS } from './types';
import Papa from 'papaparse';

export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), {
    delimiter: ',',
    quoteChar: '"',
    escapeChar: '"',
    skipEmptyLines: 'greedy',
  });
  if (result.errors.length > 0) {
    const first = result.errors[0];
    throw new Error(`CSV 格式錯誤（第 ${(first.row ?? 0) + 1} 列）：${first.message}`);
  }
  const rows = result.data;
  if (rows.length === 0) throw new Error('CSV 沒有資料');
  const headers = rows.shift()!.map((value) => value.trim());
  if (headers.some((value) => !value)) throw new Error('CSV 標題列含有空欄位');
  if (new Set(headers).size !== headers.length) throw new Error('CSV 標題列含有重複欄位');
  const malformedRow = rows.findIndex((row) => row.length !== headers.length);
  if (malformedRow >= 0) throw new Error(`CSV 第 ${malformedRow + 2} 列欄位數不符：預期 ${headers.length} 欄，收到 ${rows[malformedRow].length} 欄`);
  return { headers, rows };
}

export function rowsAsObjects(parsed: ParsedCsv): Array<Record<string, string>> {
  return parsed.rows.map((row) =>
    Object.fromEntries(parsed.headers.map((header, index) => [header, (row[index] ?? '').trim()])),
  );
}

export function stringifyActivities(rows: NormalizedActivity[]): string {
  const body = Papa.unparse({
    fields: [...CSV_FIELDS],
    data: rows.map((row) => CSV_FIELDS.map((field) => row[field])),
  }, {
    header: false,
    delimiter: ',',
    newline: '\r\n',
    quotes: false,
  });
  const header = CSV_FIELDS.join(',');
  return `${header}\r\n${body}\r\n`;
}
