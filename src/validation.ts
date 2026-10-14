export type Decoder<T> = (value: unknown) => T;

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected text.');
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected a finite number.');
  return value;
}
export function integer(value: unknown): number {
  const result = number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Expected a whole number.');
  return result;
}
export function positiveId(value: unknown): number {
  const result = integer(value);
  if (result <= 0) throw new Error('Expected a saved entry ID.');
  return result;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Expected true or false.');
  return value;
}
export function array<T>(value: unknown, decode: Decoder<T>): T[] {
  if (!Array.isArray(value)) throw new Error('Expected a list.');
  return value.map(decode);
}
export function nullable<T>(value: unknown, decode: Decoder<T>): T | null {
  return value == null ? null : decode(value);
}
export function optional<T>(value: unknown, decode: Decoder<T>, fallback: T): T {
  return value == null ? fallback : decode(value);
}
export function strings(value: unknown): string[] { return array(value, text); }
export function nonnegative(value: unknown): number {
  const result = number(value);
  if (result < 0) throw new Error('Expected a number at least zero.');
  return result;
}
