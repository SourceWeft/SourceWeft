/** Formats USD cents; whole-dollar amounts drop the decimals ($99), others keep them ($9.90). */
export function formatPrice(cents: number, freeLabel: string): string {
  if (cents === 0) return freeLabel;
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}
