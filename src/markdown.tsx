import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { getSchema, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { MarkdownSerializer, defaultMarkdownSerializer } from 'prosemirror-markdown';
import { MarkdownManager } from '@tiptap/markdown';
import styled, { css } from 'styled-components';
import { normalizeTag, tagMatches } from './tagSyntax';
import { JournalTag } from './tagEditor';
import { DOMParser as ProseMirrorDOMParser, Slice } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { textPositions } from './textSelection';
import type { EntryFormat } from './entryFormatting';

export function safeHref(value: string): string | null {
  if (/^[\s\u0000-\u001f]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return null;
  if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
  if (/^(\/(?!\/)|#)/.test(value)) return value;
  return null;
}

export const formattingExtensions = () => [
  JournalTag,
  StarterKit.configure({
    bulletList: false, orderedList: false, listItem: false, listKeymap: false,
    dropcursor: false, gapcursor: false, trailingNode: false, horizontalRule: false,
    link: {
      openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https',
      isAllowedUri: value => safeHref(value) !== null,
      HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
    },
  }),
];

// ProseMirror's serializer preserves literal Markdown characters and code fences.
// The editor and read view share Tiptap's Markdown parser (including ++underline++).
const base = defaultMarkdownSerializer;
const codeFence = (text: string) => {
  const length = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  return { fence: '`'.repeat(length + 1), padding: length || /^ .* $/.test(text) && text.trim() ? ' ' : '' };
};
export const markdownSerializer = new MarkdownSerializer({
  journalTag() {},
  paragraph: base.nodes.paragraph, text: base.nodes.text, hardBreak: base.nodes.hard_break,
  heading: base.nodes.heading, blockquote: base.nodes.blockquote,
  codeBlock(state, node) {
    const longest = Math.max(2, ...(node.textContent.match(/`+/g) ?? []).map(run => run.length));
    const fence = '`'.repeat(longest + 1);
    state.write(fence + String(node.attrs.language ?? '').replace(/[\r\n`]/g, '') + '\n');
    state.text(node.textContent, false); state.write('\n' + fence); state.closeBlock(node);
  },
}, {
  bold: base.marks.strong, italic: base.marks.em, link: base.marks.link,
  underline: { open: '++', close: '++', mixable: true, expelEnclosingWhitespace: true },
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
  code: {
    open(_state, _mark, parent, index) { const { fence, padding } = codeFence(parent.child(index).textContent); return fence + padding; },
    close(_state, _mark, parent, index) { const { fence, padding } = codeFence(parent.child(index - 1).textContent); return padding + fence; },
    escape: false,
  },
}, { hardBreakNodeName: 'hardBreak', escapeExtraCharacters: /(?<!\\)(?:\\\\)*[+<&]/g });

const schema = getSchema(formattingExtensions());
const manager = new MarkdownManager({ extensions: formattingExtensions() });
export const parseMarkdown = (source: string) => manager.parse(source);
// Joining two entries joins the documents themselves. Their text follows from
// the result, as it does for every other edit.
export function mergeEntries(first: JSONContent, second: JSONContent): JSONContent {
  const a = structuredClone(first), b = structuredClone(second);
  const last = a.content?.at(-1), next = b.content?.[0];
  if (last?.type === 'paragraph' && next?.type === 'paragraph') {
    last.content = [...last.content ?? [], ...next.content ?? []]; b.content?.shift();
  }
  return { ...a, content: [...a.content ?? [], ...b.content ?? []] };
}

type SelectedEntry = { document: JSONContent; from: number; to: number };
export function replaceEntryRange(first: SelectedEntry, last: SelectedEntry, text = '', html = '') {
  const a = schema.nodeFromJSON(first.document);
  const b = schema.nodeFromJSON(last.document);
  const doc = first === last ? a : schema.topNodeType.create(null, a.content.append(b.content));
  const from = textPositions(a).positionAt(first.from);
  const to = (first === last ? 0 : a.content.size) + textPositions(b).positionAt(last.to);
  const marks = doc.resolve(from).marks();
  const tr = new Transform(doc).delete(from, to);
  const caret = tr.mapping.map(from, -1);
  if (html || text.includes('\n')) {
    // Keep clipboard whitespace until after the fragments have been joined.
    // Serializing a standalone entry first would trim its boundary spaces.
    const insert = pastedDocument(text, html);
    tr.replaceRange(caret, caret, Slice.maxOpen(insert.content));
  } else if (text) tr.insert(caret, schema.text(text, marks));
  const offset = textPositions(tr.doc).offsetAt(tr.mapping.map(from, 1));
  const document = tr.doc.toJSON();
  return { ...serializeEntry(document), document, offset };
}
export function formatDocument(document: JSONContent, format: EntryFormat): JSONContent {
  const doc = structuredClone(document), texts: JSONContent[] = [];
  const visit = (node: JSONContent) => { if (node.type === 'text') texts.push(node); node.content?.forEach(visit); };
  visit(doc);
  const remove = texts.every(node => node.marks?.some(mark => mark.type === format));
  for (const node of texts) node.marks = remove ? node.marks?.filter(mark => mark.type !== format)
    : [...(format === 'code' ? [] : node.marks?.filter(mark => mark.type !== format && mark.type !== 'code') ?? []), { type: format }];
  return doc;
}
function pastedDocument(text: string, html: string) {
  if (html) {
    const dom = new DOMParser().parseFromString(html, 'text/html');
    return ProseMirrorDOMParser.fromSchema(schema).parse(dom.body, { preserveWhitespace: true });
  }
  const content: JSONContent[] = [];
  text.split('\n').forEach((line, index) => {
    if (index) content.push({ type: 'hardBreak' });
    if (line) content.push({ type: 'text', text: line });
  });
  return schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph', content }] });
}
export function pastedEntry(text: string, html = '') {
  const document = pastedDocument(text, html).toJSON();
  return { ...serializeEntry(document), document };
}
function hideTags(node: JSONContent, hidden: Set<string>): JSONContent | null {
  if (node.type === 'codeBlock' || node.marks?.some(mark => mark.type === 'code' || mark.type === 'link')) return node;
  if (node.text) {
    const matches = tagMatches(node.text).filter(match => hidden.has(match.name));
    if (!matches.length) return node;
    let text = '', offset = 0;
    for (const match of matches) {
      text += node.text.slice(offset, match.from);
      offset = match.to;
    }
    text += node.text.slice(offset);
    return text ? { ...node, text } : null;
  }
  if (node.content) node.content = node.content.map(child => hideTags(child, hidden)).filter((child): child is JSONContent => child !== null);
  return node;
}

// Where each hidden tag sat, as an offset into the text left behind. The
// editor tracks these positions so editing around a hidden tag cannot move it.
export function hiddenTagPositions(source: string, hiddenTags: string[] = []): { name: string; offset: number }[] {
  const hidden = new Set(hiddenTags.map(normalizeTag));
  if (!hidden.size) return [];
  const doc = schema.nodeFromJSON(parseMarkdown(source));
  const found: { name: string; offset: number }[] = [];
  let length = 0, removed = 0, first = true;
  doc.descendants(block => {
    if (!block.isTextblock) return true;
    if (!first) length += 1;
    first = false;
    const literal = block.type.name === 'codeBlock';
    block.forEach(node => {
      const quoted = node.marks.some(mark => mark.type.name === 'code' || mark.type.name === 'link');
      if (node.isText && !literal && !quoted) {
        for (const match of tagMatches(node.text ?? '')) {
          if (!hidden.has(match.name)) continue;
          found.push({ name: match.name, offset: length + match.from - removed });
          removed += match.to - match.from;
        }
      }
      length += node.isText ? node.nodeSize : node.type.name === 'journalTag' ? String(node.attrs.name).length + 1 : 1;
    });
    return false;
  });
  return found;
}

export function markdownText(source: string, hiddenTags: string[] = []): string {
  const hidden = new Set(hiddenTags.map(normalizeTag));
  const parsed = parseMarkdown(source);
  const document = hidden.size ? hideTags(parsed, hidden) ?? { type: 'doc' as const } : parsed;
  const visit = (node: JSONContent): string => node.text ?? (node.type === 'hardBreak' ? '\n' : (node.content ?? []).map(visit).join(node.type === 'doc' ? '\n' : ''));
  return visit(document);
}

export function documentWithTags(content: string, tags: string[], hiddenTags: string[] = []): JSONContent {
  const hidden = new Set(hiddenTags.map(normalizeTag));
  const parsed = parseMarkdown(content);
  const document = (hidden.size ? hideTags(parsed, hidden) : parsed) ?? { type: 'doc' as const };
  document.content ??= [];
  const expected = new Set(tags);
  const found = new Set<string>();
  const placeTags = (node: JSONContent): JSONContent => {
    if (node.type === 'codeBlock' || node.marks?.some(mark => mark.type === 'code' || mark.type === 'link')) return node;
    if (node.text) {
      const matches = tagMatches(node.text).filter(match => expected.has(match.name));
      if (!matches.length) return node;
      const content: JSONContent[] = [];
      let offset = 0;
      for (const match of matches) {
        if (match.from > offset) content.push({ ...node, text: node.text.slice(offset, match.from) });
        found.add(match.name);
        content.push({ type: 'journalTag', attrs: { name: match.name } });
        offset = match.to;
      }
      if (offset < node.text.length) content.push({ ...node, text: node.text.slice(offset) });
      return { type: 'tagFragment', content };
    }
    if (node.content) {
      node.content = node.content.flatMap(child => {
        const placed = placeTags(child);
        return placed.type === 'tagFragment' ? placed.content ?? [] : [placed];
      });
    }
    return node;
  };
  placeTags(document);
  const missing = [...expected].filter(name => !found.has(name));
  if (missing.length) {
    let last = document.content.at(-1);
    if (!last || last.type !== 'paragraph') { last = { type: 'paragraph', content: [] }; document.content.push(last); }
    last.content ??= [];
    for (const name of missing) {
      const tail = last.content.at(-1);
      if (last.content.length && !(tail?.type === 'text' && /\s$/u.test(tail.text ?? ''))) last.content.push({ type: 'text', text: ' ' });
      last.content.push({ type: 'journalTag', attrs: { name } });
    }
  }
  if (!document.content.length) document.content.push({ type: 'paragraph' });
  return document;
}

// A tag is a node, never text. The editor leaves the one being typed as text
// so the reader can keep typing it, so what gets stored, and what gets read
// back, is put right here: in a stored document every tag is a node.
export function withTagNodes(document: JSONContent): JSONContent {
  const place = (node: JSONContent): JSONContent | JSONContent[] => {
    if (node.type === 'codeBlock' || node.marks?.some(mark => mark.type === 'code' || mark.type === 'link')) return node;
    if (node.text) {
      const matches = tagMatches(node.text);
      if (!matches.length) return node;
      const parts: JSONContent[] = [];
      let offset = 0;
      for (const match of matches) {
        if (match.from > offset) parts.push({ ...node, text: node.text.slice(offset, match.from) });
        parts.push({ type: 'journalTag', attrs: { name: normalizeTag(match.name) } });
        offset = match.to;
      }
      if (offset < node.text.length) parts.push({ ...node, text: node.text.slice(offset) });
      return parts;
    }
    if (!node.content) return node;
    return { ...node, content: node.content.flatMap(child => place(child)) };
  };
  const placed = place(document);
  return Array.isArray(placed) ? document : placed;
}

// A tag the editor was never shown is still the entry's own. It joins the
// document where the entry is written, once, rather than being re-derived from
// a list of names on every read.
export function withTags(document: JSONContent, names: string[]): JSONContent {
  const present = new Set<string>();
  const find = (node: JSONContent) => {
    if (node.type === 'journalTag') present.add(normalizeTag(String(node.attrs?.name ?? '')));
    node.content?.forEach(find);
  };
  find(document);
  const missing = names.map(normalizeTag).filter(name => !present.has(name));
  if (!missing.length) return document;
  const content = [...(document.content ?? [])];
  let last = content.at(-1);
  if (!last || last.type !== 'paragraph') { last = { type: 'paragraph', content: [] }; content.push(last); }
  const children = [...(last.content ?? [])];
  for (const name of missing) {
    const tail = children.at(-1);
    if (children.length && !(tail?.type === 'text' && /\s$/u.test(tail.text ?? ''))) children.push({ type: 'text', text: ' ' });
    children.push({ type: 'journalTag', attrs: { name } });
  }
  content[content.length - 1] = { ...last, content: children };
  return { ...document, content };
}

// What was written in an entry, tags aside: an entry holding nothing but its
// tags has nothing left in it.
export function entryText(document: JSONContent): string {
  let text = '';
  const visit = (node: JSONContent) => {
    if (node.type === 'journalTag') return;
    if (node.text) text += node.text;
    if (node.type === 'hardBreak') text += '\n';
    node.content?.forEach(visit);
  };
  visit(document);
  return text;
}

export function serializeEntry(document: JSONContent): { content: string; tags: string[] } {
  const tags = new Set<string>();
  const visit = (node: JSONContent): JSONContent | null => {
    if (node.type === 'journalTag') {
      const name = String(node.attrs?.name);
      tags.add(name);
      return { type: 'text', text: '#' + name };
    }
    if (node.type === 'codeBlock' || node.marks?.some(mark => mark.type === 'code' || mark.type === 'link')) return node;
    if (node.text) {
      let text = node.text;
      for (const match of tagMatches(text)) tags.add(match.name);
      return text ? { ...node, text } : null;
    }
    const children = (node.content ?? [])
      .map(child => ({ fromTag: child.type === 'journalTag', node: visit(child) }))
      .filter((child): child is { fromTag: boolean; node: JSONContent } => child.node !== null);
    const content = node.content ? children.map(child => child.node) : undefined;
    if (node.content?.some(child => child.type === 'journalTag') && content) {
      for (let i = 1; i < content.length; i++) {
        if (/\s$/.test(content[i - 1].text ?? '') && /^\s/.test(content[i].text ?? '')) content[i].text = content[i].text!.replace(/^[ \t]+/, '');
      }
      // A tag reads as a tag only with a space beside it. Two run together, or
      // one against a word, would parse back as neither.
      for (let i = content.length - 1; i > 0; i--) {
        if (!children[i].fromTag && !children[i - 1].fromTag) continue;
        if (content[i].type !== 'text' || content[i - 1].type !== 'text') continue;
        if (/\s$/.test(content[i - 1].text ?? '') || /^\s/.test(content[i].text ?? '')) continue;
        const spacer = { fromTag: false, node: { type: 'text', text: ' ' } };
        content.splice(i, 0, spacer.node); children.splice(i, 0, spacer);
      }
      for (let i = content.length - 1; i >= 0; i--) if (content[i].type === 'text' && !content[i].text) content.splice(i, 1);
    }
    if (node.type !== 'doc' && node.content && !content?.length) return null;
    return { ...node, content };
  };
  const clean = visit(document)!;
  if (!clean.content?.length) clean.content = [{ type: 'paragraph' }];
  return { content: markdownSerializer.serialize(schema.nodeFromJSON(clean)).trim(), tags: [...tags] };
}

const inlineTagStyles = css`
  display: inline-block; position: relative; isolation: isolate; max-width: 100%; vertical-align: baseline; translate: 0 0;
  padding: 0 8px 0 7px; margin: 0; color: var(--tag-ink);
  font: inherit; font-size: calc(1em - .5px); white-space: normal; overflow-wrap: anywhere;
  /* The pill keeps its place on the line while its text rides 1px higher. */
  &::before {
    content: ''; position: absolute; z-index: -1; inset: 0 0 -2px;
    border-radius: 999px; background: var(--tag-bg);
  }
`;
const TagBubble = styled.span`${inlineTagStyles}`;

export const richTextStyles = css`
  font-size: var(--entry-size, 18px); line-height: var(--entry-line-height, 1.4); overflow-wrap: anywhere; white-space: pre-wrap;
  .journal-tag { ${inlineTagStyles} }
  .journal-tag-query::after { content: var(--tag-completion, ''); color: var(--link); }
  .journal-tag.ProseMirror-selectednode { outline: none; color: var(--paper); }
  .journal-tag.ProseMirror-selectednode::before { background: var(--tag-ink); }
  p { margin: 0; }
  p + p { margin-top: var(--entry-paragraph-gap, .4em); }
  strong { font-weight: 700; }
  em { font-style: italic; }
  u { text-underline-offset: 2px; }
  a { color: var(--link); font-weight: inherit; text-decoration: none; cursor: pointer; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em;
    color: var(--code-ink); background: transparent; border-radius: 0; padding: 0; }
  pre { margin: 4px 0; padding: 8px 10px; background: var(--code-bg); border-radius: 4px; overflow-x: auto; }
  pre code { padding: 0; background: transparent; white-space: pre; }
  blockquote { margin: 4px 0; padding-left: 12px; border-left: 2px solid var(--line); color: var(--quote); }
  h1, h2, h3, h4, h5, h6 { margin: 0; font-weight: 600; line-height: 1.4; }
  h1 { font-size: 1.5em; } h2 { font-size: 1.35em; } h3 { font-size: 1.2em; }
  h4, h5, h6 { font-size: 1em; }
`;

function renderNode(node: JSONContent, key: number): ReactNode {
  const content = node.content?.map(renderNode);
  if (node.type === 'text') {
    let result: ReactNode = node.text;
    for (const mark of node.marks ?? []) {
      switch (mark.type) {
        case 'bold': result = <strong>{result}</strong>; break;
        case 'italic': result = <em>{result}</em>; break;
        case 'underline': result = <u>{result}</u>; break;
        case 'strike': result = <s>{result}</s>; break;
        case 'code': result = <code>{result}</code>; break;
        case 'link': {
          const href = safeHref(String(mark.attrs?.href ?? ''));
          if (href) result = <a href={href} target="_blank" rel="noopener noreferrer">{result}</a>;
          break;
        }
      }
    }
    return <Fragment key={key}>{result}</Fragment>;
  }
  switch (node.type) {
    case 'journalTag': return <TagBubble key={key} data-tag={node.attrs?.name}>#{node.attrs?.name}</TagBubble>;
    case 'paragraph': return <p key={key}>{content}</p>;
    case 'hardBreak': return <br key={key} />;
    case 'blockquote': return <blockquote key={key}>{content}</blockquote>;
    case 'codeBlock': return <pre key={key}><code>{node.content?.map(child => child.text ?? '').join('')}</code></pre>;
    case 'heading': {
      const Tag = `h${Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)))}` as 'h1';
      return <Tag key={key}>{content}</Tag>;
    }
    default: return <Fragment key={key}>{content}</Fragment>;
  }
}

// Hiding the active tag is a matter of not drawing it. The stored document
// keeps every tag the entry was written with, so nothing has to be put back.
function withoutTags(node: JSONContent, hidden: Set<string>): JSONContent | null {
  if (node.type === 'journalTag') return hidden.has(normalizeTag(String(node.attrs?.name ?? ''))) ? null : node;
  if (!node.content) return node;
  return { ...node, content: node.content.map(child => withoutTags(child, hidden)).filter((child): child is JSONContent => child !== null) };
}

export const MarkdownContent = memo(function MarkdownContent({ document: stored, content, tags = [], hiddenTags = [] }: {
  document?: JSONContent | null; content: string; tags?: string[]; hiddenTags?: string[];
}) {
  const document = useMemo(() => {
    // A stored document needs no parsing. Rows written before documents were
    // kept still arrive as markdown, and are read the long way round.
    if (!stored) return documentWithTags(content, tags, hiddenTags);
    // A document written before a tag was committed holds it as text. It reads
    // as the tag it is either way.
    const placed = withTagNodes(stored);
    const hidden = new Set(hiddenTags.map(normalizeTag));
    return (hidden.size ? withoutTags(placed, hidden) : placed) ?? { type: 'doc' as const };
  }, [stored, content, tags, hiddenTags]);
  // Explicit React elements only: raw HTML, scripts, images and unsafe links never execute.
  return <>{document.content?.map(renderNode)}</>;
});
