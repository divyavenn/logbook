import type { EntryKind } from './types';

type Identity = { kind: EntryKind; id: number; expected_revision?: number | null };
type TextChange = { content: string; tags?: string[]; allow_empty?: boolean };
type Placement = { parent_id?: number | null; after_id?: number | null; before_id?: number | null };

export type CreateEntry = TextChange & Placement & {
  kind: EntryKind; id?: null; date?: string; client_id: string; delete?: false; move?: false;
};
export type UpdateEntry = Identity & TextChange & { delete?: false; move?: false };
// A date carries a dated entry, and its branch, to another day.
export type MoveEntry = Identity & Placement & { parent_id: number | null; move: true; date?: string; delete?: false };
export type DeleteEntry = Identity & { delete: true; move?: false };
export type DocumentChange = CreateEntry | UpdateEntry | MoveEntry | DeleteEntry;

type LocalIdentity = { id: number; kind: EntryKind };
export type OutlineChange =
  | (LocalIdentity & TextChange & Placement & { type: 'create'; client_id: string; date?: string })
  | (LocalIdentity & TextChange & { type: 'update' })
  | (LocalIdentity & Placement & { type: 'move'; parent_id: number | null; target_kind: EntryKind })
  | (LocalIdentity & { type: 'delete' });
