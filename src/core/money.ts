// Money helpers. All amounts are integer US cents (see types.ts).

/** 105000 -> "$1,050.00". Throws on non-integer input so a float never reaches a card. */
export function formatUsd(cents: number): string {
  if (!Number.isInteger(cents)) throw new RangeError(`amount must be integer cents, got ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

/** 95 -> "95 min", 130 -> "2 h 10 min". Used in reasons so they never depend on a time zone. */
export function formatMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 120) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
