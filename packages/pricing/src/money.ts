/**
 * All amounts are whole micro-dollars: 1 USD = 1,000,000. That is exactly
 * USDC's smallest unit, so a quoted amount can be paid onchain without any
 * conversion or rounding.
 */
export type MicroUsd = number;

export const MICRO_PER_USD = 1_000_000;

export function usd(amount: number): MicroUsd {
  const micro = Math.round(amount * MICRO_PER_USD);
  if (!Number.isSafeInteger(micro) || micro < 0) throw new RangeError("amount out of range");
  return micro;
}

export function formatUsd(micro: MicroUsd): string {
  if (!Number.isSafeInteger(micro)) throw new RangeError("amount out of range");
  const sign = micro < 0 ? "-" : "";
  const abs = Math.abs(micro);
  const whole = Math.floor(abs / MICRO_PER_USD);
  const fraction = String(abs % MICRO_PER_USD).padStart(6, "0").replace(/0{1,4}$/, "");
  return `${sign}$${whole.toLocaleString("en-US")}.${fraction}`;
}
