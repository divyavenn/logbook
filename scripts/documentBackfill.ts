// Gives every stored entry its document, parsed from the markdown it was kept
// as with the editor's own schema. Reads nothing but content and tags, and
// writes nothing else: the text stays exactly as it was written.
import { DatabaseSync } from 'node:sqlite';
import { documentWithTags, serializeEntry } from '../src/markdown';
import { normalizeTag } from '../src/tagSyntax';

type Row = { id: number; content: string; tags: string; document: string | null };

const [path, ...flags] = process.argv.slice(2);
if (!path) {
  console.error('Usage: backfill-documents <database> [--write]');
  process.exit(2);
}
const write = flags.includes('--write');
const db = new DatabaseSync(path, { readOnly: !write });
const columns = db.prepare('PRAGMA table_info(entries)').all() as { name: string }[];
if (!columns.some(column => column.name === 'document')) {
  console.error('This database has no document column yet. Start the server once to migrate it.');
  process.exit(1);
}

const rows = db.prepare('SELECT id, content, tags, document FROM entries').all() as unknown as Row[];
let written = 0, already = 0, retagged = 0;
const dropped: { id: number; names: string[] }[] = [];
const update = write
  ? db.prepare('UPDATE entries SET document = ?, tags = ? WHERE id = ?')
  : null;

for (const row of rows) {
  if (row.document) { already++; continue; }
  const stored: string[] = JSON.parse(row.tags);
  // A name held only in the tag list, with no "#name" in the text, is dropped:
  // the text is what the entry says.
  const present = stored.filter(name => serializeEntry(documentWithTags(row.content, [name])).tags.includes(name)
    && new RegExp(`#${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu').test(row.content));
  const missing = stored.filter(name => !present.includes(name));
  if (missing.length) dropped.push({ id: row.id, names: missing });
  const document = documentWithTags(row.content, present);
  const projected = serializeEntry(document);
  const tags = JSON.stringify([...new Set(projected.tags.map(normalizeTag))]);
  if (tags !== JSON.stringify(stored)) retagged++;
  // The content column is left alone. It is already the better text: writing
  // it back from the document would add the serializer's own escaping.
  update?.run(JSON.stringify(document), tags, row.id);
  written++;
}

console.log(`entries            ${rows.length}`);
console.log(`documents written  ${written}${write ? '' : ' (dry run)'}`);
console.log(`already had one    ${already}`);
console.log(`tag lists corrected ${retagged}`);
for (const row of dropped) console.log(`  dropped from ${row.id}: ${row.names.map(name => '#' + name).join(' ')}`);
if (!write) console.log('\nNothing was changed. Pass --write to apply.');
