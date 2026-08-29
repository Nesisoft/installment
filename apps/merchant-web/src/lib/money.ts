/**
 * Cedis typed by a person → integer pesewas.
 *
 * Money is integer pesewas everywhere below this line; a float would round
 * GHS 289.90 to something that is not 28990 and then quietly bill it. Parsing
 * the digits rather than multiplying a float is what keeps that from happening.
 *
 * Returns null for anything that is not a plain amount, so the caller can say
 * so rather than send a NaN the API refuses.
 */
export function parseGhsToPesewas(input: string): number | null {
  const trimmed = input.trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [cedis = '0', pesewas = ''] = trimmed.split('.');
  return Number(cedis) * 100 + Number(pesewas.padEnd(2, '0'));
}

/** The inverse, for putting an existing price back into an editable field. */
export function pesewasToGhsInput(pesewas: number): string {
  return (pesewas / 100).toFixed(2);
}
