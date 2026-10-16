import { CURRENCY_CODES, CURRENCY_DEFINITIONS, TERRITORY_CURRENCY_PERIODS } from './currency-data.ts';
export { CURRENCY_DATA_SOURCE } from './currency-data.ts';
export const SUPPORTED_CURRENCIES = CURRENCY_CODES;
export type CurrencyCode = typeof CURRENCY_CODES[number];
export const CURRENCY_NAMES = Object.fromEntries(CURRENCY_CODES.map(code=>[code,CURRENCY_DEFINITIONS[code].name])) as Record<CurrencyCode,string>;
export const ZERO_DECIMAL_CURRENCIES: readonly CurrencyCode[] = CURRENCY_CODES.filter(code=>CURRENCY_DEFINITIONS[code].digits===0);
export function normalizeCurrency(value: unknown): CurrencyCode {
  const code=typeof value==='string'?value.trim().toUpperCase():'';
  if(!SUPPORTED_CURRENCIES.includes(code as CurrencyCode)) throw Error('Currency must be one of: the current ISO 4217 planning currencies.');
  return code as CurrencyCode;
}
export function currencyFractionDigits(currency: CurrencyCode): number { return CURRENCY_DEFINITIONS[currency].digits; }
export function currencyStep(currency: CurrencyCode): number { return 10 ** -currencyFractionDigits(currency); }
export function hasValidCurrencyPrecision(value: number, currency: CurrencyCode): boolean {
  if(!Number.isFinite(value)) return false;
  const units=value*10**currencyFractionDigits(currency), rounded=Math.round(units);
  return Number.isSafeInteger(rounded) && Math.abs(units-rounded)<=Math.max(1e-7,Number.EPSILON*Math.abs(units)*2);
}
export function roundMoney(value: number,currency: CurrencyCode): number {
  const scale=10**currencyFractionDigits(currency), units=Math.round((value+Math.sign(value)*Number.EPSILON)*scale);
  if(!Number.isSafeInteger(units)) throw Error('Monetary amount exceeds safe precision.');
  return units/scale;
}
export function sumMoney(values: number[], currency: CurrencyCode): number {
  const scale=10**currencyFractionDigits(currency);
  const units=values.reduce((sum,value)=>sum+BigInt(Math.round(roundMoney(value,currency)*scale)),BigInt(0));
  if(units>BigInt(Number.MAX_SAFE_INTEGER)||units<BigInt(Number.MIN_SAFE_INTEGER)) throw Error('Monetary total exceeds safe precision.');
  return Number(units)/scale;
}
export function formatMoney(value: number, currency: CurrencyCode): string {
  const digits=currencyFractionDigits(currency);
  return new Intl.NumberFormat('en-US',{style:'currency',currency,currencyDisplay:'code',minimumFractionDigits:digits,maximumFractionDigits:digits}).format(value);
}
export function destinationCurrencies(countryCode: string, date=new Date().toISOString().slice(0,10)): CurrencyCode[] {
  const periods=TERRITORY_CURRENCY_PERIODS[countryCode.toUpperCase() as keyof typeof TERRITORY_CURRENCY_PERIODS]??[];
  return [...new Set(periods.filter(period=>(!period.from||period.from<=date)&&(!period.to||period.to>=date)).map(period=>period.code))];
}
