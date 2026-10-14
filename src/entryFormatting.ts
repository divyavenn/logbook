const SHORTCUTS = { b: 'bold', i: 'italic', u: 'underline' } as const;
export type EntryFormat = typeof SHORTCUTS[keyof typeof SHORTCUTS] | 'code';

export function formattingShortcut(key: string, shift = false): EntryFormat | null {
  const lower = key.toLowerCase();
  if (lower === 'c' && shift) return 'code';
  if (lower in SHORTCUTS) return SHORTCUTS[lower as keyof typeof SHORTCUTS];
  return null;
}
