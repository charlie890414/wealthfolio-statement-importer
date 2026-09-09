export type BrokerKind = 'fubon' | 'sinopac' | 'schwab' | 'fundrich' | 'ctbc_espp';

export const CSV_FIELDS = [
  'date',
  'symbol',
  'instrumentType',
  'quantity',
  'activityType',
  'unitPrice',
  'currency',
  'fee',
  'tax',
  'amount',
  'fxRate',
  'subtype',
  'comment',
  'account',
] as const;

export type CsvField = (typeof CSV_FIELDS)[number];

export interface NormalizedActivity {
  date: string;
  symbol: string;
  instrumentType: string;
  quantity: string;
  activityType: string;
  unitPrice: string;
  currency: string;
  fee: string;
  tax: string;
  amount: string;
  fxRate: string;
  subtype: string;
  comment: string;
  account: string;
  /** Original broker symbol, retained when the user maps it to another ticker. */
  sourceSymbol?: string;
  exchangeMic?: string;
  quoteCcy?: string;
  providerId?: string;
  providerSymbol?: string;
  symbolName?: string;
}

export interface ConversionIssue {
  lineNumber?: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface ConversionResult {
  broker: BrokerKind;
  sourceRows: number;
  activities: NormalizedActivity[];
  issues: ConversionIssue[];
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export interface BrokerDetection {
  broker: BrokerKind | null;
  missing: string[];
}
