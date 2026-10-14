import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Markdown } from '@tiptap/markdown';
import type { Mark, Node as DocumentNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import styled from 'styled-components';
import { formattingExtensions, documentWithTags, serializeBullet, richTextStyles, safeHref } from '../markdown';
import { Field } from '../styles';
import { Modal } from './Modal';
import { useJournalContext } from '../JournalContext';
import { normalizeTag } from '../tagSyntax';
import { TagDecorations, commitTypedTags, selectTypedTag } from '../tagEditor';
import { documentUndo, historyShortcutDirection } from '../documentHistory';
import { entryError } from '../entryFeedback';
import { Code2, Link2 } from 'lucide-react';

const Surface = styled.div`
  flex: 1; min-width: 0;
  .tiptap { ${richTextStyles}; min-height: var(--bullet-row-height, 40px); padding: var(--bullet-padding, 7px 0); outline: none; caret-color: var(--ink); }
  .tiptap:focus-visible { outline: none; }
`;
const LinkForm = styled.form`display: grid; gap: 8px; margin: 0;`;
const LinkField = styled(Field)<{ $url?: boolean }>`
  color: ${({ $url }) => $url ? "var(--url)" : "var(--link)"};
  border: 0; outline: none; box-shadow: none; background: transparent;
  &:focus-visible { outline: none; background: var(--field); }
`;

const TagCompletion = styled.div<{ $left: number; $top: number }>`
  position: fixed; left: ${({ $left }) => $left}px; top: ${({ $top }) => $top}px; z-index: 20;
  width: min(230px, calc(100vw - 24px)); pointer-events: none;
`;
const TagAlternatives = styled.div`
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding-top: 31px;
  max-height: 154px; overflow-y: auto; pointer-events: auto;
`;
const TagOption = styled.button<{ $selected: boolean }>`
  max-width: 100%; min-height: 28px; border: 0; border-radius: 999px; padding: 4px 9px;
  background: var(--tag-bg); color: ${({ $selected }) => $selected ? 'var(--link)' : 'var(--tag-ink)'}; font-size: 13px; line-height: 20px;
  text-align: left; overflow-wrap: anywhere;
  &:hover { color: var(--ink); }
`;
const HiddenTagOption = styled.span`
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
`;
type TagSuggestion = { from: number; to: number; query: string; names: string[]; index: number; left: number; top: number };
type MobileFormatState = { left: number; top: number; width: number; bold: boolean; italic: boolean; underline: boolean; code: boolean; link: boolean };
const MobileFormatBar = styled.div<{ $left: number; $top: number; $width: number }>`
  position: fixed; z-index: 39; left: ${({ $left }) => $left}px; top: ${({ $top }) => $top}px; width: ${({ $width }) => $width}px;
  display: none; align-items: center; padding: 2px; border-radius: 10px;
  color: var(--ink); background: var(--surface); box-shadow: 0 0 0 1px #0000000b, 0 5px 18px #20262024;
  @media(pointer: coarse) { display: flex; }
`;
const MobileFormatButton = styled.button<{ $active: boolean }>`
  flex: 1 1 40px; min-width: 0; height: 40px; padding: 0; border: 0; border-radius: 8px; display: grid; place-items: center;
  background: ${({ $active }) => $active ? 'var(--soft)' : 'transparent'}; color: ${({ $active }) => $active ? 'var(--link)' : 'var(--ink)'};
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
export type TextOffsets = { anchor: number; head: number };
export type RichTextHandle = {
  focus: (options?: FocusOptions, selection?: TextOffsets) => void;
  focusAt: (x: number, direction: VerticalDirection, options?: FocusOptions) => void;
  selection: () => TextOffsets | undefined;
  editLink: () => void;
  selectEntry: () => void;
  splitAtSelection: () => { before: { content: string; tags: string[] }; after: { content: string; tags: string[] } } | null;
};
type Props = {
  ref?: Ref<RichTextHandle>; value: string; tags: string[]; label: string; readOnly: boolean;
  onChange: (markdown: string, tags: string[]) => void; onBlur: (event?: FocusEvent) => void; onKeyDown: (event: KeyboardEvent) => void;
  onEnter: () => void;
  onBoundary?: (direction: 'backspace' | 'delete') => void;
  onVerticalBoundary?: (direction: VerticalDirection, x: number) => boolean;
  onSelectDocument?: () => void;
  onSelectEntry?: (selected: boolean) => void;
  onDeleteEntry?: () => void;
};

export function RichTextEditor({ ref, value, tags: bulletTags, label, readOnly, onChange, onBlur, onKeyDown, onEnter, onBoundary, onVerticalBoundary, onSelectDocument, onSelectEntry, onDeleteEntry }: Props) {
  const { tags } = useJournalContext();
  const [suggestion, setSuggestion] = useState<TagSuggestion | null>(null);
  const [mobileFormat, setMobileFormat] = useState<MobileFormatState | null>(null);
  const suggestionRef = useRef<TagSuggestion | null>(null);
  const suggest = (next: TagSuggestion | null) => { suggestionRef.current = next; setSuggestion(next); };
  const callbacks = useRef({ onChange, onBlur, onKeyDown, onEnter, onBoundary, onVerticalBoundary, onSelectDocument, onSelectEntry, onDeleteEntry });
  callbacks.current = { onChange, onBlur, onKeyDown, onEnter, onBoundary, onVerticalBoundary, onSelectDocument, onSelectEntry, onDeleteEntry };
  const entrySelected = useRef(false);
  const lastSnapshot = useRef(JSON.stringify([value, bulletTags]));
  const linkOpen = useRef(false);
  const [link, setLink] = useState<{ from: number; to: number; mode: LinkMode } | null>(null);
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
    const bullet = visiblyEmpty ? { content: '', tags: [] as string[] } : serializeBullet(currentEditor.getJSON());
    callbacks.current.onChange(bullet.content, bullet.tags);
  };
  const editor: Editor | null = useEditor({
    extensions: [...formattingExtensions(), Markdown, TagDecorations],
    content: documentWithTags(value, bulletTags), injectCSS: false, immediatelyRender: true,
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
            if (entrySelected.current) { event.preventDefault(); callbacks.current.onDeleteEntry?.(); return true; }
            const backwards = inputEvent.inputType === 'deleteContentBackward';
            if (view.state.selection.empty && view.state.selection.from === (backwards ? 1 : view.state.doc.content.size - 1)) {
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
          const end = view.coordsAtPos(view.state.doc.content.size - 1);
          if (event.detail === 2 && event.clientX >= end.left - 3 && event.clientY >= end.top && event.clientY <= end.bottom) {
            event.preventDefault();
            editor?.commands.selectAll();
            entrySelected.current = true;
            callbacks.current.onSelectEntry?.(true);
            return true;
          }
          if (entrySelected.current) { entrySelected.current = false; callbacks.current.onSelectEntry?.(false); }
          const anchor = event.target.closest<HTMLAnchorElement>('a');
          const href = anchor && safeHref(anchor.getAttribute('href') ?? '');
          if (!href) return false;
          event.preventDefault(); event.stopPropagation();
          window.open(href, '_blank', 'noopener,noreferrer');
          return true;
        },
        cut(view, event) {
          if (!entrySelected.current || !event.clipboardData) return false;
          event.preventDefault();
          event.clipboardData.setData('text/plain', view.dom.textContent ?? '');
          event.clipboardData.setData('text/html', view.dom.innerHTML);
          callbacks.current.onDeleteEntry?.();
          return true;
        },
        input(view) {
          // ProseMirror normally reports this through onUpdate. Browser fake
          // clocks can defer its DOM observer, so propagate an explicit clear
          // immediately from the native input event.
          if (!view.dom.textContent?.trim() && !view.dom.querySelector('[data-tag]')) callbacks.current.onChange('', []);
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
        if (entrySelected.current && (event.key === 'Backspace' || event.key === 'Delete')) {
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
          const edge = event.key === 'ArrowUp' || event.key === 'Home' ? 1 : view.state.doc.content.size - 1;
          event.preventDefault();
          view.dispatch(view.state.tr.setSelection(TextSelection.between(
            view.state.doc.resolve(event.shiftKey ? view.state.selection.anchor : edge), view.state.doc.resolve(edge))));
          return true;
        }
        const historyKey = mod && !event.altKey && ['z', 'y'].includes(event.key.toLowerCase());
        if (historyKey && event.repeat) { event.preventDefault(); return true; }
        const historyDirection = historyShortcutDirection(event);
        if (!mod && !event.shiftKey && editor && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
            selectTypedTag(editor, event.key === 'ArrowLeft' ? 'left' : 'right')) {
          event.preventDefault(); return true;
        }
        if (!mod && !event.altKey && !event.shiftKey && view.state.selection.empty &&
            (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          const direction: VerticalDirection = event.key === 'ArrowUp' ? 'up' : 'down';
          if (view.endOfTextblock(direction)) {
            const x = view.coordsAtPos(view.state.selection.head).left;
            if (callbacks.current.onVerticalBoundary?.(direction, x)) {
              event.preventDefault(); return true;
            }
            const edge = direction === 'up' ? 1 : view.state.doc.content.size - 1;
            event.preventDefault(); view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, edge)));
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
        if (view.state.selection.empty) {
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
        if (!mod && !event.shiftKey && view.state.selection.empty) {
          const { from } = view.state.selection;
          const direction = event.key === 'Backspace' && from === 1 ? 'backspace'
            : event.key === 'Delete' && from === view.state.doc.content.size - 1 ? 'delete' : null;
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
      if (entrySelected.current) { entrySelected.current = false; callbacks.current.onSelectEntry?.(false); }
      const bullet = serializeBullet(editor.getJSON());
      lastSnapshot.current = JSON.stringify([bullet.content, bullet.tags]);
      callbacks.current.onChange(bullet.content, bullet.tags);
      updateSuggestion(editor);
      commitTypedTags(editor);
    },
    onSelectionUpdate({ editor }) {
      if (entrySelected.current && (editor.state.selection.from > 1 || editor.state.selection.to < editor.state.doc.content.size - 1)) {
        entrySelected.current = false; callbacks.current.onSelectEntry?.(false);
      }
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
    const width = Math.max(0, Math.min(204, viewportWidth - 16));
    const minLeft = viewportLeft + 8;
    const maxLeft = viewportLeft + viewportWidth - width - 8;
    const left = Math.max(minLeft, Math.min((from.left + to.right - width) / 2, maxLeft));
    const above = Math.min(from.top, to.top) - 48;
    const top = above >= viewportTop + 8 ? above : Math.min(Math.max(from.bottom, to.bottom) + 8, viewportBottom - 52);
    setMobileFormat({ left, top, width, bold: current.isActive('bold'), italic: current.isActive('italic'), underline: current.isActive('underline'), code: current.isActive('code'), link: current.isActive('link') });
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
      const domSelection = window.getSelection();
      if (domSelection?.anchorNode && domSelection.focusNode && editor.view.dom.contains(domSelection.anchorNode) && editor.view.dom.contains(domSelection.focusNode)) {
        const offsetAt = (node: Node, offset: number) => {
          const range = document.createRange(); range.selectNodeContents(editor.view.dom); range.setEnd(node, offset); return range.toString().length;
        };
        return { anchor: offsetAt(domSelection.anchorNode, domSelection.anchorOffset), head: offsetAt(domSelection.focusNode, domSelection.focusOffset) };
      }
      const { anchor, head } = editor.state.selection;
      const offsetAt = (position: number) => editor.state.doc.textBetween(0, position, '\n', '\ufffc').length;
      return { anchor: offsetAt(anchor), head: offsetAt(head) };
    },
    focus(options, selection) {
      if (!editor || editor.isDestroyed) return;
      editor.view.dom.focus({ ...options, preventScroll: true });
      if (selection) {
        // Saved HTML and ProseMirror use different offsets. Count visible text
        // in both so a mouse selection survives entering the editor.
        const positionAt = (offset: number) => {
          let remaining = offset;
          let position = 1;
          let found = false;
          editor.state.doc.descendants((node, pos) => {
            if (found) return false;
            const length = node.isText ? node.nodeSize : node.type.name === 'journalTag' ? String(node.attrs.name).length + 1 : node.type.name === 'hardBreak' ? 1 : 0;
            if (length) {
              position = pos + (node.isText ? Math.min(remaining, length) : remaining > 0 ? node.nodeSize : 0);
              if (remaining <= length) found = true;
              else remaining -= length;
            }
            return !found;
          });
          return position;
        };
        editor.commands.setTextSelection({ from: positionAt(selection.anchor), to: positionAt(selection.head) });
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
      const fallback = direction === 'up' ? editor.state.doc.content.size - 1 : 1;
      editor.commands.setTextSelection(point?.pos ?? fallback);
      element.focus({ ...options, preventScroll: true });
      if (!options?.preventScroll) editor.view.dispatch(editor.state.tr.scrollIntoView());
    },
    editLink() { openLink('context'); },
    selectEntry() {
      if (!editor || editor.isDestroyed) return;
      editor.commands.selectAll();
      entrySelected.current = true;
      callbacks.current.onSelectEntry?.(true);
    },
    splitAtSelection() {
      if (!editor || editor.isDestroyed) return null;
      commitTypedTags(editor, true);
      const { doc, selection } = editor.state;
      const dom = window.getSelection();
      let from = selection.from, to = selection.to;
      if (dom?.anchorNode && dom.focusNode && editor.view.dom.contains(dom.anchorNode) && editor.view.dom.contains(dom.focusNode)) {
        // Map native caret positions directly, including tags and hard breaks.
        // Counting text characters loses atomic nodes and can split the wrong word.
        const anchor = editor.view.posAtDOM(dom.anchorNode, dom.anchorOffset);
        const head = editor.view.posAtDOM(dom.focusNode, dom.focusOffset);
        from = Math.min(anchor, head); to = Math.max(anchor, head);
      }
      const text = (start: number, end: number) => doc.textBetween(start, end, '\n', node =>
        node.type.name === 'journalTag' ? '#' + node.attrs.name : node.type.name === 'hardBreak' ? '\n' : '');
      // At the end of a heading, quote, or code block, its empty closing
      // structure is not content to carry into the next entry.
      if (from === to && !text(to, doc.content.size)) return {
        before: serializeBullet(doc.toJSON()), after: { content: '', tags: [] },
      };
      return {
        before: text(0, from) ? serializeBullet(doc.cut(0, from).toJSON()) : { content: '', tags: [] },
        after: text(to, doc.content.size) ? serializeBullet(doc.cut(to, doc.content.size).toJSON()) : { content: '', tags: [] },
      };
    },
  }), [editor]);
  useEffect(() => {
    const snapshot = JSON.stringify([value, bulletTags]);
    if (editor && snapshot !== lastSnapshot.current) {
      editor.commands.setContent(documentWithTags(value, bulletTags), { emitUpdate: false });
      lastSnapshot.current = snapshot;
    }
  }, [editor, value, bulletTags]);
  useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);
  useEffect(() => { editor?.view.dom.setAttribute('aria-label', label); }, [editor, label]);

  const close = (range = link) => {
    linkOpen.current = false; clipboardRequest.current++; setLink(null);
    // Native dialog closes after its exit transition; restore the original text selection.
    setTimeout(() => {
      if (editor && !editor.isDestroyed) {
        if (range) editor.commands.setTextSelection({ from: range.from, to: range.to });
        editor.view.dom.focus();
      }
    }, 170);
  };

  const formatSelection = (format: 'bold' | 'italic' | 'underline' | 'code') => {
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
    </MobileFormatBar>}
    {suggestion && <TagCompletion id="tag-suggestions" role="listbox" aria-label="Tags" $left={suggestion.left} $top={suggestion.top}>
      <HiddenTagOption id="tag-option-0" role="option" aria-selected={suggestion.index === 0} aria-label={`#${suggestion.names[0]}`}>#{suggestion.names[0]}</HiddenTagOption>
      <TagAlternatives>{suggestion.names.slice(1, 3).map((name, offset) => { const index = offset + 1; return <TagOption $selected={suggestion.index === index} key={name} id={`tag-option-${index}`} role="option" aria-selected={suggestion.index === index}
        onMouseDown={event => event.preventDefault()} onClick={() => chooseTag(name)}>#{name}</TagOption>; })}</TagAlternatives>
    </TagCompletion>}
    <Modal open={link !== null} onClose={() => close()} title="Link" compact>
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
