// Gives every stored entry its document, parsed from the markdown it was kept
// as with the editor's own schema. Reads nothing but content and tags, and
// writes nothing else: the text stays exactly as it was written.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { documentWithTags, serializeEntry } from '../src/markdown';
import { normalizeTag } from '../src/tagSyntax';

type Row = { id: number; content: string; tags: string; document: string | null };

const flags = process.argv.slice(2);
// Boots run this unattended, so the database is found the way the server finds
// it and anything already in order is simply left alone.
const path = flags.find(flag => !flag.startsWith('--')) ?? process.env.STILL_DB_PATH ?? 'data/still.sqlite3';
const write = flags.includes('--write');
const quiet = flags.includes('--quiet');
const say = (line: string) => { if (!quiet) console.log(line); };

// A tag held only in the list, with no "#name" in the text, is dropped: the
// text is what the entry says.
const inText = (content: string, name: string) =>
  new RegExp(`#${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'iu').test(content);

function planned(row: { content: string; tags: string[] }) {
  const present = row.tags.filter(name => inText(row.content, name));
  const document = documentWithTags(row.content, present);
  const tags = [...new Set(serializeEntry(document).tags.map(normalizeTag))];
  return { document, tags, dropped: row.tags.filter(name => !present.includes(name)) };
}

if (/^https?:\/\//.test(path)) {
  const password = process.env.STILL_PASSWORD;
  if (!password) {
    console.error('Set STILL_PASSWORD to the logbook password.');
    process.exit(2);
  }
  const base = path.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${password}`, 'content-type': 'application/json' };
  const response = await fetch(`${base}/api/export`, { headers });
  if (!response.ok) {
    console.error(`The logbook answered ${response.status} ${response.statusText}.`);
    process.exit(1);
  }
  const exported = await response.json() as {
    notes: { id: number; content: string; tags: string[]; document?: unknown }[];
    tasks: { id: number; content: string; tags: string[]; document?: unknown }[];
  };
  const kinds = [['notes', exported.notes], ['tasks', exported.tasks]] as const;
  let done = 0, had = 0, failed = 0;
  for (const [kind, list] of kinds) {
    for (const row of list) {
      if (row.document) { had++; continue; }
      const plan = planned(row);
      for (const name of plan.dropped) console.log(`  dropping #${name} from ${kind} ${row.id}`);
      if (!write) { done++; continue; }
      const saved = await fetch(`${base}/api/${kind}/${row.id}`, {
        method: 'PATCH', headers,
        // The text is sent back exactly as it was stored, so only the document
        // and the corrected tag list change.
        body: JSON.stringify({ content: row.content, tags: plan.tags, document: plan.document }),
      });
      if (saved.ok) done++;
      else { failed++; console.error(`  ${kind} ${row.id} answered ${saved.status} ${saved.statusText}`); }
    }
  }
  console.log(`entries            ${exported.notes.length + exported.tasks.length}`);
  console.log(`documents written  ${done}${write ? '' : ' (dry run)'}`);
  console.log(`already had one    ${had}`);
  if (failed) console.log(`refused            ${failed}`);
  if (!write) say('\nNothing was changed. Pass --write to apply.');
  process.exit(failed ? 1 : 0);
}

if (!existsSync(path)) {
  say(`No logbook at ${path} yet; nothing to migrate.`);
  process.exit(0);
}
const db = new DatabaseSync(path, { readOnly: !write });
const columns = db.prepare('PRAGMA table_info(entries)').all() as { name: string }[];
if (!columns.length || !columns.some(column => column.name === 'document')) {
  // The server writes the schema. Until it has, there is nothing to fill in.
  say('This logbook has no document column yet; leaving it to the server.');
  process.exit(0);
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
  const plan = planned({ content: row.content, tags: stored });
  if (plan.dropped.length) dropped.push({ id: row.id, names: plan.dropped });
  const document = plan.document;
  const tags = JSON.stringify(plan.tags);
  if (tags !== JSON.stringify(stored)) retagged++;
  // The content column is left alone. It is already the better text: writing
  // it back from the document would add the serializer's own escaping.
  update?.run(JSON.stringify(document), tags, row.id);
  written++;
}

say(`entries            ${rows.length}`);
say(`documents written  ${written}${write ? '' : ' (dry run)'}`);
say(`already had one    ${already}`);
say(`tag lists corrected ${retagged}`);
for (const row of dropped) say(`  dropped from ${row.id}: ${row.names.map(name => '#' + name).join(' ')}`);
if (!write) say('\nNothing was changed. Pass --write to apply.');
