import type { Decoder } from './validation';

const memory = new Map<string, string | null>();
const pending = new Set<string>();
const reported = new Set<string>();
const preserved = new Map<string, string>();

function report(key: string, error: unknown): void {
  if (reported.has(key)) return;
  reported.add(key);
  console.error('Could not read or save local data. This tab will keep a copy in memory.', key, error);
}

// Keep the newest value in this tab if the browser blocks storage or runs out of space.
export const storage = {
  getItem(key: string): string | null {
    if (pending.has(key)) return memory.get(key) ?? null;
    try {
      const value = localStorage.getItem(key);
      memory.set(key, value);
      return value;
    } catch (error) {
      report(key, error);
      return memory.get(key) ?? null;
    }
  },
  setItem(key: string, value: string): void {
    memory.set(key, value);
    try {
      localStorage.setItem(key, value);
      pending.delete(key);
    } catch (error) { pending.add(key); report(key, error); }
  },
  removeItem(key: string): void {
    memory.set(key, null);
    try {
      localStorage.removeItem(key);
      pending.delete(key);
    } catch (error) { pending.add(key); report(key, error); }
  },
  keys(): string[] {
    const keys = new Set(memory.keys());
    try { for (const key of Object.keys(localStorage)) keys.add(key); }
    catch (error) { report('storage', error); }
    return [...keys].filter(key => storage.getItem(key) !== null);
  },
};

export function preserveRecovery(key: string, raw: string, error: unknown): void {
  if (preserved.get(key) === raw) return;
  preserved.set(key, raw);
  // Save the original before replacing a damaged record with the parts we can use.
  storage.setItem(`still-recovery:${key}:${crypto.randomUUID()}`, raw);
  console.error('Some saved data could not be restored. Its original copy was kept for recovery.', key, error);
}

export function readStored<T>(key: string, decode: Decoder<T>, fallback: T): T {
  const raw = storage.getItem(key);
  if (raw === null) return fallback;
  try { return decode(JSON.parse(raw) as unknown); }
  catch (error) { preserveRecovery(key, raw, error); return fallback; }
}

export function recoverRecords<T>(value: unknown, decode: Decoder<T>, onInvalid: (error: unknown) => void): T[] {
  if (!Array.isArray(value)) { onInvalid(new Error('Expected a saved list.')); return []; }
  const result: T[] = [];
  for (const record of value) {
    try { result.push(decode(record)); }
    catch (error) { onInvalid(error); }
  }
  return result;
}
