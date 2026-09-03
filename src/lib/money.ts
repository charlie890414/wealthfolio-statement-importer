import Big from 'big.js';

const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'TWD', 'VND']);

export function moneyDecimalPlaces(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
}

export function moneyValue(value: string | number | null | undefined): Big {
  if (value === null || value === undefined || String(value).trim() === '') return new Big(0);
  try { return new Big(String(value).replace(/,/g, '')); } catch { return new Big(0); }
}
