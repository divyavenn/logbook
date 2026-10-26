import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import type { Mark, Node as DocumentNode } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state';
import styled from 'styled-components';
import { formattingExtensions, documentWithTags, serializeEntry, withTagNodes, richTextStyles, safeHref } from '../markdown';
import { Field, appear } from '../styles';
import { Modal } from './Modal';
import { useJournalContext } from '../JournalContext';
import { normalizeTag } from '../tagSyntax';
import { TagDecorations, commitTypedTags, selectTypedTag } from '../tagEditor';
import { documentUndo, historyShortcutDirection } from '../documentHistory';
import { entryError } from '../entryFeedback';
import { textPositions, type TextOffsets } from '../textSelection';
import { Code2, IndentDecrease, IndentIncrease, Link2 } from 'lucide-react';
import type { EntryFormat } from '../entryFormatting';

const Surface = styled.div`
  flex: 1; min-width: 0;
  .tiptap { ${richTextStyles}; min-height: var(--entry-row-height, 40px); padding: var(--entry-padding, 7px 0); outline: none; caret-color: var(--ink); }
  .tiptap:focus-visible { outline: none; }
`;
const LinkForm = styled.form`display: grid; gap: 8px; margin: 0;`;
const LinkField = styled(Field)<{ $url?: boolean }>`
  color: ${({ $url }) => $url ? "var(--url)" : "var(--link)"};
  transition: color 140ms ease-out;
  border: 0; outline: none; box-shadow: none; background: transparent;
  &:focus-visible { outline: none; background: var(--field); }
`;

const TagCompletion = styled.div<{ $left: number; $top: number }>`
  position: fixed; left: ${({ $left }) => $left}px; top: ${({ $top }) => $top}px; z-index: 20;
  width: min(230px, calc(100vw - 24px)); pointer-events: none;
  ${appear('3px', 140)};
  /* Once shown it slides to follow the caret instead of hopping after it. */
  transition: opacity 140ms ease-out, transform 140ms cubic-bezier(.2, 0, 0, 1), left 140ms ease-out, top 140ms ease-out;
  @media (prefers-reduced-motion: reduce) { transition: none; }
`;
const TagAlternatives = styled.div`
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding-top: 31px;
  max-height: 154px; overflow-y: auto; pointer-events: auto;
`;
const TagOption = styled.button<{ $selected: boolean }>`
  max-width: 100%; min-height: 28px; border: 0; border-radius: 999px; padding: 4px 9px;
  background: var(--tag-bg); color: ${({ $selected }) => $selected ? 'var(--link)' : 'var(--tag-ink)'}; font-size: 13px; line-height: 20px;
  transition: color 120ms ease-out;
  text-align: left; overflow-wrap: anywhere;
  &:hover { color: var(--ink); }
`;
const HiddenTagOption = styled.span`
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
`;
type TagSuggestion = { from: number; to: number; query: string; names: string[]; index: number; left: number; top: number };
type MobileFormatState = { left: number; top: number; width: number; entry: boolean; bold: boolean; italic: boolean; underline: boolean; code: boolean; link: boolean };
const MobileFormatBar = styled.div<{ $left: number; $top: number; $width: number }>`
  position: fixed; z-index: 39; left: ${({ $left }) => $left}px; top: ${({ $top }) => $top}px; width: ${({ $width }) => $width}px;
  display: none; align-items: center; padding: 2px; border-radius: 10px;
  color: var(--ink); background: var(--surface); box-shadow: 0 0 0 1px #0000000b, 0 5px 18px #20262024;
  ${appear('4px', 160)};
  transition: opacity 160ms ease-out, transform 160ms cubic-bezier(.2, 0, 0, 1),
    left 160ms ease-out, top 160ms ease-out, width 160ms ease-out;
  @media (prefers-reduced-motion: reduce) { transition: none; }
  @media(pointer: coarse) { display: flex; }
`;
const MobileFormatButton = styled.button<{ $active: boolean }>`
  flex: 1 1 40px; min-width: 0; height: 40px; padding: 0; border: 0; border-radius: 8px; display: grid; place-items: center;
  background: ${({ $active }) => $active ? 'var(--soft)' : 'transparent'}; color: ${({ $active }) => $active ? 'var(--link)' : 'var(--ink)'};
  transition: background-color 140ms ease-out, color 140ms ease-out;
  font-size: 14px; line-height: 1;
`;

function linkUrl(value: string): string | null {
  const raw = value.trim();
  if (!raw || /[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  if (/^(\/(?!\/)|#)/.test(raw)) return raw;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  if (!safeHref(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname && !parsed.pathname) return null;
    return parsed.href;
  } catch { return null; }
}

function clipboardUrl(value: string): string | null {
  const raw = value.trim();
  // A sentence or arbitrary copied word should leave the field alone.
  if (!/^(https?:\/\/|mailto:|tel:)/i.test(raw) &&
      !/^(?:[a-z\d-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(raw)) return null;
  return linkUrl(raw);
}
function sharedMarks(doc: DocumentNode, from: number, to: number): Mark[] {
  let marks: Mark[] = [];
  let first = true;
  doc.nodesBetween(from, to, node => {
    if (!node.isText) return;
    marks = first ? [...node.marks] : marks.filter(mark => mark.isInSet(node.marks));
    first = false;
  });
  return marks;
}

type LinkMode = 'shortcut' | 'insert' | 'context';
export type VerticalDirection = 'up' | 'down';
export type { TextOffsets } from '../textSelection';
const entryEdge = (doc: DocumentNode, start: boolean) => start ? TextSelection.atStart(doc).from : TextSelection.atEnd(doc).to;
const entireEntrySelected = (editor: Editor) => {
  const { doc, selection } = editor.state;
  if (selection.empty || selection.from > entryEdge(doc, true) || selection.to < entryEdge(doc, false)) return false;
  // A selection reaching past this editor belongs to the document, and must
  // not be treated as this one entry: selecting an entry stops its text from
  // being selectable, which would collapse the selection being made.
  const native = window.getSelection();
  if (!native || native.isCollapsed || !native.rangeCount) return true;
  const dom = editor.view.dom;
  return dom.contains(native.anchorNode) && dom.contains(native.focusNode);
};
export type RichTextHandle = {
  focus: (options?: FocusOptions, selection?: TextOffsets) => void;
  focusAt: (x: number, direction: VerticalDirection, options?: FocusOptions) => void;
  selection: () => TextOffsets | undefined;
  editLink: () => void;
  selectEntry: () => void;
  entireSelected: () => boolean;
  splitAtSelection: () => { before: { content: string; tags: string[] }; after: { content: string; tags: string[] } } | null;
};
type Props = {
  ref?: Ref<RichTextHandle>; value: string; tags: string[]; label: string; readOnly: boolean;
  // The entry as it is stored. Opening it needs no parsing; a row written
  // before documents were kept arrives as markdown in value instead.
  document?: JSONContent | null;
  onChange: (markdown: string, tags: string[], document: JSONContent | null) => void; onBlur: (event?: FocusEvent) => void; onKeyDown: (event: KeyboardEvent) => void;
  onEnter: () => void;
  onBoundary?: (direction: 'backspace' | 'delete') => void;
  onVerticalBoundary?: (direction: VerticalDirection, x: number) => boolean;
  onHorizontalBoundary?: (direction: 'left' | 'right') => boolean;
  onSelectDocument?: () => void;
  onSelectEntry?: (selected: boolean) => void;
  onDeleteEntry?: () => void;
  onShift?: (outdent: boolean) => void;
};

export function RichTextEditor({ ref, value, tags: entryTags, label, readOnly, document: stored = null, onChange, onBlur, onKeyDown, onEnter, onBoundary, onVerticalBoundary, onHorizontalBoundary, onSelectDocument, onSelectEntry, onDeleteEntry, onShift }: Props) {
  const { tags } = useJournalContext();
  const [suggestion, setSuggestion] = useState<TagSuggestion | null>(null);
  const [mobileFormat, setMobileFormat] = useState<MobileFormatState | null>(null);
  const suggestionRef = useRef<TagSuggestion | null>(null);
  const suggest = (next: TagSuggestion | null) => { suggestionRef.current = next; setSuggestion(next); };
  const callbacks = useRef({ onChange, onBlur, onKeyDown, onEnter, onBoundary, onVerticalBoundary, onHorizontalBoundary, onSelectDocument, onSelectEntry, onDeleteEntry, onShift });
  callbacks.current = { onChange, onBlur, onKeyDown, onEnter, onBoundary, onVerticalBoundary, onHorizontalBoundary, onSelectDocument, onSelectEntry, onDeleteEntry, onShift };
  // Selecting an entry's whole text selects the entry on a touch screen, which
  // has no double click to take hold of one with. A pointer has that gesture,
  // and there selecting all of the text is a selection of text.
  const touchScreen = () => window.matchMedia('(pointer: coarse)').matches;
  // The explicit gesture additionally makes Backspace remove the entry itself.
  const entrySelected = useRef(false);
  const entryReported = useRef(false);
  const reportEntrySelection = (selected: boolean) => {
    if (entryReported.current === selected) return;
    entryReported.current = selected;
    callbacks.current.onSelectEntry?.(selected);
  };
  const lastSnapshot = useRef(JSON.stringify([value, entryTags]));
  const storedEntry = (currentEditor: Editor) => {
    const doc = currentEditor.state.doc;
    let tagged = false;
    doc.descendants(node => { if (node.type.name === 'journalTag') tagged = true; });
    // Nothing visible is left to anchor a hidden tag to, so none comes back.
    if (!doc.textContent.trim() && !tagged) return { content: '', tags: [] as string[], document: null };
    // The document the editor holds is the one that gets stored, hidden tags
    // included: the text and the tag names are both read back out of it.
    // The editor keeps a tag being typed as text; what it hands out does not.
    const stored = withTagNodes(doc.toJSON());
    const entry = serializeEntry(stored);
    return { content: entry.content, tags: entry.tags, document: stored };
  };
  const linkOpen = useRef(false);
  const [link, setLink] = useState<{ from: number; to: number; mode: LinkMode } | null>(null);
  const restoreLinkSelection = useRef<{ from: number; to: number } | null>(null);
  const [url, setUrl] = useState('');
  const [linkMode, setLinkMode] = useState<LinkMode>('shortcut');
  const [linkText, setLinkText] = useState('');
  const clipboardRequest = useRef(0);
  const urlEdited = useRef(false);
  const linkTextField = useRef<HTMLInputElement>(null);
  const urlField = useRef<HTMLInputElement>(null);
  const previousSelectAll = useRef(false);
  const linkPrefix = useRef<{ from: number; to: number; mark: Mark; doc: DocumentNode } | null>(null);
  const linkReplacement = useRef<{ to: number; mark: Mark; doc: DocumentNode } | null>(null);
  const publishEditorValue = (currentEditor: Editor) => {
    commitTypedTags(currentEditor, true);
    const visiblyEmpty = !currentEditor.view.dom.textContent?.trim() && !currentEditor.view.dom.querySelector('[data-tag]');
    const entry = visiblyEmpty ? { content: '', tags: [] as string[], document: null } : storedEntry(currentEditor);
    callbacks.current.onChange(entry.content, entry.tags, entry.document);
  };
  // A stored document opens as it is. Rows written before documents were kept
  // are parsed from their markdown instead, tags and all.
  const openedDocument = () => stored || documentWithTags(value, entryTags);
  const editor: Editor | null = useEditor({
    extensions: [...formattingExtensions(), Markdown, TagDecorations],
    content: openedDocument(), injectCSS: false, immediatelyRender: true,
    // Literal punctuation stays literal; formatting comes from shortcuts or rich paste.
    enableInputRules: false, enablePasteRules: false,
    editable: !readOnly,
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'true' },
      handleDOMEvents: {
        beforeinput(view, event) {
          const inputEvent = event as InputEvent;
          if (!view.editable || view.composing || inputEvent.isComposing) return false;
          if (['deleteContentBackward', 'deleteContentForward'].includes(inputEvent.inputType)) {
            const backwards = inputEvent.inputType === 'deleteContentBackward';
            if (view.state.selection.empty && view.state.selection.from === entryEdge(view.state.doc, backwards)) {
              event.preventDefault(); callbacks.current.onBoundary?.(backwards ? 'backspace' : 'delete'); return true;
            }
          }
          if (inputEvent.inputType !== 'insertParagraph') return false;
          const pending = suggestionRef.current;
          if (pending) {
            event.preventDefault();
            chooseTag(pending.names[pending.index]);
            return true;
          }
          // Some virtual keyboards emit insertParagraph without a usable Enter
          // keydown. Treat it as the same semantic action while preserving
          // paragraphs inside code blocks and insertLineBreak for soft returns.
          if (editor?.isActive('codeBlock')) return false;
          event.preventDefault();
          if (editor) publishEditorValue(editor);
          callbacks.current.onEnter();
          return true;
        },
        mousedown(view, event) {
          if (event.button !== 0 || !(event.target instanceof Element)) return false;
          const end = view.coordsAtPos(entryEdge(view.state.doc, false));
          if (event.detail === 2 && event.clientX >= end.left - 3 && event.clientY >= end.top && event.clientY <= end.bottom) {
            event.preventDefault();
            editor?.commands.selectAll();
            entrySelected.current = true;
            reportEntrySelection(true);
            return true;
          }
          entrySelected.current = false;
          reportEntrySelection(false);
          // An entry holding nothing but its tags is written in front of them,
          // so a press in the empty room on that line puts the caret there
          // rather than behind the tag. A press on the tag still takes hold of it.
          if (!view.state.doc.textContent.trim() && view.dom.querySelector('[data-tag]') && !event.target.closest('[data-tag]')) {
            event.preventDefault();
            view.dispatch(view.state.tr.setSelection(Selection.atStart(view.state.doc)));
            view.focus();
            return true;
          }
          const anchor = event.target.closest<HTMLAnchorElement>('a');
          const href = anchor && safeHref(anchor.getAttribute('href') ?? '');
          if (!href) return false;
          event.preventDefault(); event.stopPropagation();
          window.open(href, '_blank', 'noopener,noreferrer');
          return true;
        },
        input(view) {
          // ProseMirror normally reports this through onUpdate. Browser fake
          // clocks can defer its DOM observer, so propagate an explicit clear
          // immediately from the native input event.
          if (!view.dom.textContent?.trim() && !view.dom.querySelector('[data-tag]')) callbacks.current.onChange('', [], null);
          return false;
        },
        contextmenu(view, event) {
          const anchor = (event.target as HTMLElement).closest('a');
          if (!anchor || !view.dom.contains(anchor) || !view.editable) return false;
          event.preventDefault();
          editor?.commands.setTextSelection({
            from: view.posAtDOM(anchor, 0), to: view.posAtDOM(anchor, anchor.childNodes.length),
          });
          openLink('context');
          return true;
        },
      },
      handleTextInput(view, from, to, text) {
        if (view.composing) return false;
        if (from === to) {
          const { state } = view;
          const replacement = linkReplacement.current;
          linkReplacement.current = null;
          // Replacing a selected linked label is one edit, including spaces.
          // Keep its URL until the user moves the caret or leaves the editor.
          if (replacement?.doc === state.doc && replacement.to === from) {
            const tr = state.tr.insertText(text, from, to).addMark(from, from + text.length, replacement.mark);
            tr.setSelection(TextSelection.create(tr.doc, from + text.length));
            linkReplacement.current = { ...replacement, to: from + text.length, doc: tr.doc };
            view.dispatch(tr.scrollIntoView());
            return true;
          }
          const at = state.doc.resolve(from);
          const before = at.nodeBefore, after = at.nodeAfter;
          const left = before?.isText ? before.marks.find(mark => mark.type.name === 'link') : undefined;
          const right = after?.isText ? after.marks.find(mark => mark.type.name === 'link') : undefined;
          const marks = state.storedMarks ?? at.marks();
          const previous = linkPrefix.current;
          linkPrefix.current = null;
          const prefix = previous?.doc === state.doc && previous.to === from && right?.eq(previous.mark) ? previous : null;
          if (marks.some(mark => mark.type.name === 'code') || left && right && left.eq(right) && !prefix) return false;
          if (!left && !right && !marks.some(mark => mark.type.name === 'link')) return false;

          // Link marks are inclusive in Tiptap. At an edge, only the attached
          // word should inherit the URL; a separating space stays plain.
          const tr = state.tr.insertText(text, from, to);
          tr.removeMark(from, from + text.length, state.schema.marks.link);
          if (prefix || right && !/^\s/u.test(after?.text ?? '')) {
            const mark = prefix?.mark ?? right!;
            const spaces = [...text.matchAll(/\s/gu)];
            const split = spaces.length ? from + spaces.at(-1)!.index! + 1 : from;
            const start = prefix?.from ?? from;
            // A prefix initially belongs to the same word. If a space is
            // subsequently typed, detach that prefix from the original link.
            if (spaces.length) tr.removeMark(start, split, state.schema.marks.link);
            if (split < from + text.length) {
              tr.addMark(split, from + text.length, mark);
              linkPrefix.current = { from: spaces.length ? split : start, to: from + text.length, mark, doc: tr.doc };
            }
          } else if (left && !/\s$/u.test(before?.text ?? '')) {
            const space = text.search(/\s/u);
            const end = from + (space < 0 ? text.length : space);
            if (end > from) tr.addMark(from, end, left);
          }
          tr.setSelection(TextSelection.create(tr.doc, from + text.length)).setStoredMarks(null);
          view.dispatch(tr.scrollIntoView());
          return true;
        }
        linkPrefix.current = null;
        linkReplacement.current = null;
        // Replacing a whole linked label (including Select All) keeps its URL
        // and shared formatting, just like editing characters inside the link.
        const commonMarks = sharedMarks(view.state.doc, from, to);
        const link = commonMarks.find(mark => mark.type.name === 'link');
        if (!link) return false;
        const tr = view.state.tr.deleteSelection().ensureMarks(commonMarks).insertText(text);
        // Select All can include the paragraph itself, so use the mapped caret.
        linkReplacement.current = { to: tr.selection.from, mark: link, doc: tr.doc };
        view.dispatch(tr.scrollIntoView());
        return true;
      },
      handleKeyDown(view, event) {
        if (view.composing || event.isComposing || !view.editable) return false;
        // Native selectionchange can arrive after a fast follow-up key. Read
        // the actual caret before deciding whether to join or outdent a row.
        const native = window.getSelection();
        if (view.state.selection instanceof TextSelection && native?.anchorNode && native.focusNode &&
            view.dom.contains(native.anchorNode) && view.dom.contains(native.focusNode)) {
          const anchor = view.posAtDOM(native.anchorNode, native.anchorOffset), head = view.posAtDOM(native.focusNode, native.focusOffset);
          if (anchor !== view.state.selection.anchor || head !== view.state.selection.head) {
            view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.doc.resolve(anchor), view.state.doc.resolve(head))));
          }
        }
        // Nothing of the entry is left to keep, so the entry goes with it. Only
        // a pressed key means that: a delete can also arrive as the clearing
        // half of replacing the text.
        if (editor && entireEntrySelected(editor) && (event.key === 'Backspace' || event.key === 'Delete')) {
          event.preventDefault(); callbacks.current.onDeleteEntry?.(); return true;
        }
        const pending = suggestionRef.current;
        if (pending && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          const index = (pending.index + (event.key === 'ArrowDown' ? 1 : -1) + pending.names.length) % pending.names.length;
          suggest({ ...pending, index }); return true;
        }
        if (pending && (event.key === 'Enter' || event.key === 'Tab')) {
          event.preventDefault(); chooseTag(pending.names[pending.index]); return true;
        }
        if (pending && event.key === 'Escape') { event.preventDefault(); suggest(null); return true; }
        const mod = event.metaKey || event.ctrlKey;
        if (!event.altKey && (event.metaKey && ['ArrowUp', 'ArrowDown'].includes(event.key) || event.ctrlKey && ['Home', 'End'].includes(event.key))) {
          const edge = entryEdge(view.state.doc, event.key === 'ArrowUp' || event.key === 'Home');
          event.preventDefault();
          view.dispatch(view.state.tr.setSelection(TextSelection.between(
            view.state.doc.resolve(event.shiftKey ? view.state.selection.anchor : edge), view.state.doc.resolve(edge))).scrollIntoView());
          return true;
        }
        const historyKey = mod && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase());
        if (historyKey && event.repeat) { event.preventDefault(); return true; }
        const historyDirection = historyShortcutDirection(event);
        if (!mod && !event.altKey && !event.shiftKey && editor && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
            selectTypedTag(editor, event.key === 'ArrowLeft' ? 'left' : 'right')) {
          event.preventDefault(); return true;
        }
        if (!mod && !event.altKey && !event.shiftKey && view.state.selection.empty &&
            (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
          const left = event.key === 'ArrowLeft';
          if (view.state.selection.head === entryEdge(view.state.doc, left) && callbacks.current.onHorizontalBoundary?.(left ? 'left' : 'right')) {
            event.preventDefault(); return true;
          }
        }
        if (!mod && !event.altKey && !event.shiftKey && view.state.selection.empty &&
            (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          const direction: VerticalDirection = event.key === 'ArrowUp' ? 'up' : 'down';
          const { $head } = view.state.selection;
          const outerBlock = direction === 'up'
            ? $head.start() === entryEdge(view.state.doc, true)
            : $head.end() === entryEdge(view.state.doc, false);
          if (outerBlock && view.endOfTextblock(direction)) {
            const x = view.coordsAtPos(view.state.selection.head).left;
            if (callbacks.current.onVerticalBoundary?.(direction, x)) {
              event.preventDefault(); return true;
            }
            const edge = entryEdge(view.state.doc, direction === 'up');
            event.preventDefault(); view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, edge)).scrollIntoView());
            return true;
          }
        }
        if (historyDirection !== null) {
          event.preventDefault();
          const handled = historyDirection ? editor?.commands.redo() : editor?.commands.undo();
          if (!handled) void documentUndo(historyDirection).catch(error => entryError(error));
          return true;
        }
        if (mod && event.key.toLowerCase() === 'a') {
          if (previousSelectAll.current) { previousSelectAll.current = false; event.preventDefault(); callbacks.current.onSelectDocument?.(); return true; }
          previousSelectAll.current = true;
        } else if (!['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) previousSelectAll.current = false;
        if (!mod && !event.altKey && !event.shiftKey && view.state.selection.empty) {
          const { $from, from } = view.state.selection;
          const beforeTag = $from.nodeBefore?.type.name === 'journalTag';
          const afterTag = $from.nodeAfter?.type.name === 'journalTag';
          if ((event.key === 'ArrowLeft' || event.key === 'Backspace') && beforeTag) {
            event.preventDefault(); view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, from - $from.nodeBefore!.nodeSize))); return true;
          }
          if ((event.key === 'ArrowRight' || event.key === 'Delete') && afterTag) {
            event.preventDefault(); view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, from))); return true;
          }
        }
        if (!mod && !event.altKey && !event.shiftKey && view.state.selection.empty) {
          const { from } = view.state.selection;
          const direction = event.key === 'Backspace' && from === entryEdge(view.state.doc, true) ? 'backspace'
            : event.key === 'Delete' && from === entryEdge(view.state.doc, false) ? 'delete' : null;
          if (direction && callbacks.current.onBoundary) { event.preventDefault(); callbacks.current.onBoundary(direction); return true; }
        }
        if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
          event.preventDefault(); editor?.commands.toggleCode(); return true;
        }
        if (mod && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          openLink('shortcut');
          return true;
        }
        if (event.key === 'Enter' && !mod && editor?.isActive('codeBlock')) return false;
        // The parent may save immediately in this same key event. Read the
        // editor document synchronously so a just-cleared entry is deleted
        // even if React has not delivered the last onUpdate render yet.
        if (event.key === 'Enter' && editor) publishEditorValue(editor);
        callbacks.current.onKeyDown(event);
        return event.defaultPrevented;
      },
    },
    onUpdate({ editor }) {
      // Formatting changes the document while leaving its full selection in
      // place. Keep the row highlight until typing or navigation collapses it.
      const whole = entireEntrySelected(editor);
      if (!whole) entrySelected.current = false;
      reportEntrySelection(whole && (touchScreen() || entrySelected.current));
      const entry = storedEntry(editor);
      lastSnapshot.current = JSON.stringify([entry.content, entry.tags]);
      callbacks.current.onChange(entry.content, entry.tags, entry.document);
      updateSuggestion(editor);
      commitTypedTags(editor);
    },
    onSelectionUpdate({ editor }) {
      const whole = entireEntrySelected(editor);
      if (!whole) entrySelected.current = false;
      reportEntrySelection(whole && (touchScreen() || entrySelected.current));
      if (!editor.state.selection.empty || editor.state.selection.from !== linkPrefix.current?.to) linkPrefix.current = null;
      if (!editor.state.selection.empty || editor.state.selection.from !== linkReplacement.current?.to) linkReplacement.current = null;
      updateSuggestion(editor);
      updateMobileFormat(editor);
    },
    onBlur({ event }) { linkPrefix.current = null; linkReplacement.current = null; previousSelectAll.current = false; suggest(null); setMobileFormat(null); if (!linkOpen.current) { if (editor) commitTypedTags(editor, true); callbacks.current.onBlur(event); } },
  });

  const updateMobileFormat = (current: Editor) => {
    if (!window.matchMedia('(pointer: coarse)').matches || current.state.selection.empty) { setMobileFormat(null); return; }
    const from = current.view.coordsAtPos(current.state.selection.from);
    const to = current.view.coordsAtPos(current.state.selection.to);
    const viewport = window.visualViewport;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
    // A whole-entry selection adds indent and outdent, which need more room.
    const entry = entireEntrySelected(current);
    const width = Math.max(0, Math.min(entry ? 288 : 204, viewportWidth - 16));
    const minLeft = viewportLeft + 8;
    const maxLeft = viewportLeft + viewportWidth - width - 8;
    const left = Math.max(minLeft, Math.min((from.left + to.right - width) / 2, maxLeft));
    const above = Math.min(from.top, to.top) - 48;
    const top = above >= viewportTop + 8 ? above : Math.min(Math.max(from.bottom, to.bottom) + 8, viewportBottom - 52);
    setMobileFormat({ left, top, width, entry, bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'), code: current.isActive('code'), link: current.isActive('link') });
  };

  const updateSuggestion = (current: Editor) => {
    const { $from, empty, from } = current.state.selection;
    if (!empty || $from.parent.type.name === 'codeBlock' || $from.marks().some(mark => mark.type.name === 'code' || mark.type.name === 'link')) { suggest(null); return; }
    const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc');
    const match = /(?:^|[^\p{L}\p{N}_/#&])#([\p{L}\p{N}_-]{0,64})$/u.exec(before);
    if (!match) { suggest(null); return; }
    const query = normalizeTag(match[1]);
    if (query.length < 2) { suggest(null); return; }
    const names = tags.map(tag => tag.name).filter(name => name.startsWith(query)).slice(0, 3);
    if (!names.length) { suggest(null); return; }
    const rect = current.view.coordsAtPos(from);
    const start = current.view.coordsAtPos(from - match[1].length - 1);
    const left = Math.max(12, Math.min(start.left - 7, window.innerWidth - 242));
    suggest({ from: from - match[1].length - 1, to: from, query, names, index: 0,
      left, top: rect.top });
  };
  const chooseTag = (name: string) => {
    const pending = suggestionRef.current;
    if (!editor || !pending) return;
    suggest(null);
    const next = editor.state.doc.resolve(pending.to).nodeAfter;
    const needsSpace = !next || next.isText && !/^\s/u.test(next.text ?? '') || next.type.name === 'journalTag';
    editor.chain().insertContentAt({ from: pending.from, to: pending.to }, [
      { type: 'journalTag', attrs: { name } },
      ...(needsSpace ? [{ type: 'text', text: ' ' }] : []),
    ]).run();
    editor.view.dom.focus();
  };
  useEffect(() => {
    if (!editor) return;
    const preserveDocumentSelection = (event: Event) => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return;
      const root = editor.view.dom;
      // ProseMirror only owns selections wholly inside this entry. Its DOM
      // observer would otherwise clamp a native cross-entry selection back
      // into the editor before the outline can handle typing, cut, or delete.
      if (root.contains(selection.anchorNode) && !root.contains(selection.focusNode)) event.stopImmediatePropagation();
    };
    document.addEventListener('selectionchange', preserveDocumentSelection, true);
    return () => document.removeEventListener('selectionchange', preserveDocumentSelection, true);
  }, [editor]);
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('#tag-suggestions')) return;
      if (!suggestionRef.current) return;
      if (editor?.isFocused) {
        const caret = editor.view.coordsAtPos(editor.state.selection.from);
        const viewport = editor.view.dom.closest('[data-testid="log-scroll"]')?.getBoundingClientRect();
        if (caret.bottom >= Math.max(0, viewport?.top ?? 0) && caret.top <= Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight)) {
          updateSuggestion(editor);
          return;
        }
      }
      suggest(null);
    };
    window.addEventListener('scroll', dismiss, true);
    return () => window.removeEventListener('scroll', dismiss, true);
  }, [editor, tags]);
  useEffect(() => {
    if (!editor) return;
    editor.view.dom.setAttribute('aria-autocomplete', 'list');
    if (suggestion) {
      editor.view.dom.setAttribute('aria-controls', 'tag-suggestions');
      editor.view.dom.setAttribute('aria-activedescendant', `tag-option-${suggestion.index}`);
    } else {
      editor.view.dom.removeAttribute('aria-controls'); editor.view.dom.removeAttribute('aria-activedescendant');
    }
  }, [editor, suggestion]);

  useEffect(() => {
    if (suggestion) document.getElementById(`tag-option-${suggestion.index}`)?.scrollIntoView({ block: 'nearest' });
  }, [suggestion?.index, suggestion?.query]);
  useLayoutEffect(() => {
    const completion = suggestion?.names[0]?.slice(suggestion.query.length) ?? '';
    if (!editor) return;
    if (completion) editor.view.dom.style.setProperty('--tag-completion', JSON.stringify(completion));
    else editor.view.dom.style.removeProperty('--tag-completion');
  }, [editor, suggestion]);

  const openLink = (mode: LinkMode) => {
    if (!editor || editor.isDestroyed) return;
    const { from, to } = editor.state.selection;
    const empty = editor.state.selection.empty;
    if (empty && mode === 'context') return;
    const actualMode: LinkMode = empty && mode === 'shortcut' ? 'insert' : mode;
    const selected = empty ? '' : editor.state.doc.textBetween(from, to, '\n');
    if (actualMode !== 'insert' && !selected.trim()) return;
    restoreLinkSelection.current = null;
    const existing = editor.isActive('link');
    setLinkText(selected);
    setUrl(existing ? String(editor.getAttributes('link').href ?? '') : '');
    urlEdited.current = false;
    urlField.current?.setCustomValidity('');
    linkOpen.current = true; setLinkMode(actualMode); setLink({ from, to, mode: actualMode });
    const request = ++clipboardRequest.current;
    if (mode === 'shortcut' || actualMode === 'insert') {
      // Read only for this user gesture. Denial leaves manual URL entry usable.
      void navigator.clipboard?.readText().then(value => {
        if (request !== clipboardRequest.current || !linkOpen.current || urlEdited.current) return;
        const href = clipboardUrl(value);
        if (href) setUrl(href);
      }).catch(() => {});
    }
  };

  useImperativeHandle(ref, () => ({
    selection() {
      if (!editor || editor.isDestroyed) return;
      const positions = textPositions(editor.state.doc);
      const domSelection = window.getSelection();
      if (domSelection?.anchorNode && domSelection.focusNode && editor.view.dom.contains(domSelection.anchorNode) && editor.view.dom.contains(domSelection.focusNode)) {
        const offsetAt = (node: Node, offset: number) => positions.offsetAt(editor.view.posAtDOM(node, offset));
        return { anchor: offsetAt(domSelection.anchorNode, domSelection.anchorOffset), head: offsetAt(domSelection.focusNode, domSelection.focusOffset) };
      }
      const { anchor, head } = editor.state.selection;
      return { anchor: positions.offsetAt(anchor), head: positions.offsetAt(head) };
    },
    focus(options, selection) {
      if (!editor || editor.isDestroyed) return;
      editor.view.dom.focus({ ...options, preventScroll: true });
      // An entry holding nothing but its tags opens in front of them, so the
      // first letter is written before the tag rather than after it.
      if (!selection && !editor.state.doc.textContent.trim()) {
        editor.view.dispatch(editor.state.tr.setSelection(Selection.atStart(editor.state.doc)));
      }
      if (selection) {
        const { positionAt } = textPositions(editor.state.doc);
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.between(
          editor.state.doc.resolve(positionAt(selection.anchor)), editor.state.doc.resolve(positionAt(selection.head)))));
      }
      editor.view.focus();
      if (!options?.preventScroll) editor.view.dispatch(editor.state.tr.scrollIntoView());
    },
    focusAt(x, direction, options) {
      if (!editor || editor.isDestroyed) return;
      const element = editor.view.dom;
      element.focus({ ...options, preventScroll: true });
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const lineHeight = parseFloat(style.lineHeight) || 18;
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      const y = direction === 'up'
        ? rect.bottom - paddingBottom - lineHeight / 2
        : rect.top + paddingTop + lineHeight / 2;
      const point = editor.view.posAtCoords({
        left: Math.max(rect.left + 1, Math.min(x, rect.right - 1)),
        top: Math.max(rect.top + 1, Math.min(y, rect.bottom - 1)),
      });
      const fallback = entryEdge(editor.state.doc, direction !== 'up');
      editor.commands.setTextSelection(point?.pos ?? fallback);
      element.focus({ ...options, preventScroll: true });
      if (!options?.preventScroll) editor.view.dispatch(editor.state.tr.scrollIntoView());
    },
    editLink() { openLink('context'); },
    entireSelected() {
      return !!editor && !editor.isDestroyed && entireEntrySelected(editor);
    },
    selectEntry() {
      if (!editor || editor.isDestroyed) return;
      editor.commands.selectAll();
      entrySelected.current = true;
      reportEntrySelection(true);
    },
    splitAtSelection() {
      if (!editor || editor.isDestroyed) return null;
      commitTypedTags(editor, true);
      const { selection } = editor.state;
      const dom = window.getSelection();
      let from = selection.from, to = selection.to;
      if (dom?.anchorNode && dom.focusNode && editor.view.dom.contains(dom.anchorNode) && editor.view.dom.contains(dom.focusNode)) {
        // Map native caret positions directly, including tags and hard breaks.
        // Counting text characters loses atomic nodes and can split the wrong word.
        const anchor = editor.view.posAtDOM(dom.anchorNode, dom.anchorOffset);
        const head = editor.view.posAtDOM(dom.focusNode, dom.focusOffset);
        from = Math.min(anchor, head); to = Math.max(anchor, head);
      }
      const doc = editor.state.doc;
      const text = (start: number, end: number) => doc.textBetween(start, end, '\n', node =>
        node.type.name === 'journalTag' ? '#' + node.attrs.name : node.type.name === 'hardBreak' ? '\n' : '');
      // Tags are not writing. Nothing written after the caret means there is
      // nothing to carry into a new entry, so the whole of this one stays.
      const written = (start: number, end: number) => doc.textBetween(start, end, '\n', node =>
        node.type.name === 'hardBreak' ? '\n' : '');
      // At the end of a heading, quote, or code block, its empty closing
      // structure is not content to carry into the next entry.
      if (from === to && !written(to, doc.content.size).trim()) return {
        before: serializeEntry(doc.toJSON()), after: { content: '', tags: [] },
      };
      return {
        before: text(0, from) ? serializeEntry(doc.cut(0, from).toJSON()) : { content: '', tags: [] },
        after: text(to, doc.content.size) ? serializeEntry(doc.cut(to, doc.content.size).toJSON()) : { content: '', tags: [] },
      };
    },
  }), [editor]);
  useEffect(() => {
    const snapshot = JSON.stringify([value, entryTags]);
    if (editor && snapshot !== lastSnapshot.current) {
      editor.commands.setContent(stored || documentWithTags(value, entryTags), { emitUpdate: false });
      lastSnapshot.current = snapshot;
    }
  }, [editor, value, entryTags]);
  useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);
  useEffect(() => { editor?.view.dom.setAttribute('aria-label', label); }, [editor, label]);

  const close = (range = link) => {
    linkOpen.current = false; clipboardRequest.current++; setLink(null);
    restoreLinkSelection.current = range;
  };

  const formatSelection = (format: EntryFormat) => {
    if (!editor) return;
    const chain = editor.chain().focus();
    if (format === 'bold') chain.toggleBold().run();
    else if (format === 'italic') chain.toggleItalic().run();
    else if (format === 'underline') chain.toggleUnderline().run();
    else chain.toggleCode().run();
    updateMobileFormat(editor);
  };

  return <Surface><EditorContent editor={editor} />
    {mobileFormat && <MobileFormatBar role="toolbar" aria-label="Formatting" $left={mobileFormat.left} $top={mobileFormat.top} $width={mobileFormat.width}
      onPointerDown={event => event.preventDefault()}>
      <MobileFormatButton type="button" $active={mobileFormat.bold} aria-label="Bold" aria-pressed={mobileFormat.bold} onClick={() => formatSelection('bold')}><strong>B</strong></MobileFormatButton>
      <MobileFormatButton type="button" $active={mobileFormat.italic} aria-label="Italic" aria-pressed={mobileFormat.italic} onClick={() => formatSelection('italic')}><em>I</em></MobileFormatButton>
      <MobileFormatButton type="button" $active={mobileFormat.underline} aria-label="Underline" aria-pressed={mobileFormat.underline} onClick={() => formatSelection('underline')}><u>U</u></MobileFormatButton>
      <MobileFormatButton type="button" $active={mobileFormat.code} aria-label="Code" aria-pressed={mobileFormat.code} onClick={() => formatSelection('code')}><Code2 size={16} aria-hidden="true" /></MobileFormatButton>
      <MobileFormatButton type="button" $active={mobileFormat.link} aria-label="Add or edit link" aria-pressed={mobileFormat.link} onClick={() => openLink('shortcut')}><Link2 size={16} aria-hidden="true" /></MobileFormatButton>
      {mobileFormat.entry && <>
        <MobileFormatButton type="button" $active={false} aria-label="Outdent entry" onClick={() => callbacks.current.onShift?.(true)}><IndentDecrease size={16} aria-hidden="true" /></MobileFormatButton>
        <MobileFormatButton type="button" $active={false} aria-label="Indent entry" onClick={() => callbacks.current.onShift?.(false)}><IndentIncrease size={16} aria-hidden="true" /></MobileFormatButton>
      </>}
    </MobileFormatBar>}
    {suggestion && <TagCompletion id="tag-suggestions" role="listbox" aria-label="Tags" $left={suggestion.left} $top={suggestion.top}>
      <HiddenTagOption id="tag-option-0" role="option" aria-selected={suggestion.index === 0} aria-label={`#${suggestion.names[0]}`}>#{suggestion.names[0]}</HiddenTagOption>
      <TagAlternatives>{suggestion.names.slice(1, 3).map((name, offset) => { const index = offset + 1; return <TagOption $selected={suggestion.index === index} key={name} id={`tag-option-${index}`} role="option" aria-selected={suggestion.index === index}
        onMouseDown={event => event.preventDefault()} onClick={() => chooseTag(name)}>#{name}</TagOption>; })}</TagAlternatives>
    </TagCompletion>}
    <Modal open={link !== null} onClose={() => close()} onAfterClose={() => {
      if (!editor || editor.isDestroyed || linkOpen.current) return;
      if (restoreLinkSelection.current) editor.commands.setTextSelection(restoreLinkSelection.current);
      restoreLinkSelection.current = null;
      editor.view.focus();
    }} title="Link" compact>
      <LinkForm onKeyDown={event => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          if (linkMode === 'insert' && event.target === linkTextField.current) {
            event.preventDefault(); event.stopPropagation(); urlField.current?.focus(); return;
          }
          event.preventDefault(); event.currentTarget.requestSubmit();
        }
      }} onSubmit={event => {
        event.preventDefault(); if (!editor || !link) return;
        const raw = url.trim();
        const href = raw ? linkUrl(raw) : null;
        if (raw && !href) {
          urlField.current?.setCustomValidity('Enter a valid URL.');
          urlField.current?.reportValidity();
          return;
        }
        if (link.mode === 'insert' && !linkText.trim()) {
          linkTextField.current?.setCustomValidity('Enter link text.'); linkTextField.current?.reportValidity(); return;
        }
        if (link.mode === 'insert' && !href) {
          urlField.current?.setCustomValidity('Enter a valid URL.'); urlField.current?.reportValidity(); return;
        }
        const chain = editor.chain().setTextSelection({ from: link.from, to: link.to });
        const selected = editor.state.doc.textBetween(link.from, link.to, '\n');
        if (link.mode === 'insert') {
          const marks = (editor.state.storedMarks ?? editor.state.selection.$from.marks())
            .filter(mark => mark.type.name !== 'link').map(mark => mark.toJSON());
          marks.push({ type: 'link', attrs: { href } });
          chain.insertContent({ type: 'text', text: linkText.trim(), marks });
        } else if (link.mode === 'context' && linkText !== selected) {
          const marks = sharedMarks(editor.state.doc, link.from, link.to)
            .filter(mark => mark.type.name !== 'link').map(mark => mark.toJSON());
          if (href) marks.push({ type: 'link', attrs: { href } });
          if (linkText) chain.insertContent({ type: 'text', text: linkText, marks });
          else chain.deleteSelection();
        } else if (href) chain.setLink({ href });
        else chain.unsetLink();
        chain.run(); callbacks.current.onBlur();
        close({ ...link, from: editor.state.selection.from, to: editor.state.selection.to });
      }}>
        {linkMode !== 'shortcut' && <LinkField ref={linkTextField} aria-label="Link label" placeholder="label" autoFocus value={linkText}
          required={linkMode === 'insert'} onChange={event => { event.target.setCustomValidity(''); setLinkText(event.target.value); }} />}
        <LinkField $url ref={urlField} aria-label="Link URL" placeholder="URL" autoFocus={linkMode === 'shortcut'} inputMode="url"
          autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="done" value={url}
          onChange={event => {
            urlEdited.current = true;
            event.target.setCustomValidity('');
            setUrl(event.target.value);
          }} />
      </LinkForm>
    </Modal>
  </Surface>;
}
