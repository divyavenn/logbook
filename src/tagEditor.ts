import { Extension, Node, type Editor } from '@tiptap/core';
import { NodeSelection, Plugin, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { tagMatches, normalizeTag } from './tagSyntax';

export const TagDecorations = Extension.create({
  name: 'journalTags',
  addProseMirrorPlugins() {
    return [new Plugin({ props: { decorations(state) {
      const decorations: Decoration[] = [];
      const { empty, from, $from } = state.selection;
      const before = empty && $from.parent.type.name !== 'codeBlock' ? $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc') : '';
      const activeMatch = /(?:^|[^\p{L}\p{N}_/#&])#([\p{L}\p{N}_-]{0,64})$/u.exec(before);
      const activeFrom = activeMatch ? from - activeMatch[1].length - 1 : -1;
      state.doc.descendants((node, position) => {
        if (node.type.name === 'codeBlock') return false;
        if (!node.isText || node.marks.some(mark => mark.type.name === 'code' || mark.type.name === 'link')) return;
        for (const tag of tagMatches(node.text ?? '')) {
          const tagFrom = position + tag.from, tagTo = position + tag.to;
          if (tagFrom === activeFrom && tagTo === from) continue;
          decorations.push(Decoration.inline(tagFrom, tagTo, { class: 'journal-tag', 'data-tag': tag.name }));
        }
      });
      if (activeMatch) decorations.push(Decoration.inline(activeFrom, from, { class: 'journal-tag journal-tag-query' }));
      return DecorationSet.create(state.doc, decorations);
    } } })];
  },
});


export const JournalTag = Node.create({
  name: 'journalTag', inline: true, group: 'inline', atom: true, selectable: true,
  addAttributes() { return { name: { default: '', rendered: false } }; },
  parseHTML() { return [{ tag: 'span[data-tag]', getAttrs: element => {
    const name = (element as HTMLElement).getAttribute('data-tag') ?? '';
    return tagMatches('#' + name).some(tag => tag.text === '#' + name) ? { name: normalizeTag(name) } : false;
  } }]; },
  renderHTML({ node }) { return ['span', { 'data-tag': node.attrs.name, class: 'journal-tag', contenteditable: 'false' }, '#' + node.attrs.name]; },
  renderText({ node }) { return '#' + node.attrs.name; },
  renderMarkdown() { return ''; },
  addKeyboardShortcuts() {
    return {
      ArrowLeft: () => {
        const { empty, $from, from } = this.editor.state.selection;
        if (!empty || $from.nodeBefore?.type.name !== this.name) return false;
        return this.editor.commands.setNodeSelection(from - $from.nodeBefore.nodeSize);
      },
      ArrowRight: () => {
        const { empty, $from, from } = this.editor.state.selection;
        if (!empty || $from.nodeAfter?.type.name !== this.name) return false;
        return this.editor.commands.setNodeSelection(from);
      },
      Backspace: () => {
        const { empty, $from, from } = this.editor.state.selection;
        if (!empty || $from.nodeBefore?.type.name !== this.name) return false;
        return this.editor.commands.setNodeSelection(from - $from.nodeBefore.nodeSize);
      },
      Delete: () => {
        const { empty, $from, from } = this.editor.state.selection;
        if (!empty || $from.nodeAfter?.type.name !== this.name) return false;
        return this.editor.commands.setNodeSelection(from);
      },
    };
  },
});

export function selectTypedTag(editor: Editor, direction: 'left' | 'right') {
  const { empty, from: caret } = editor.state.selection;
  if (!empty) return false;
  let target: { from: number; to: number; name: string } | null = null;
  editor.state.doc.descendants((node, position) => {
    if (target || node.type.name === 'codeBlock') return false;
    if (!node.isText || node.marks.some(mark => mark.type.name === 'code' || mark.type.name === 'link')) return;
    for (const match of tagMatches(node.text ?? '')) {
      const from = position + match.from, to = position + match.to;
      const inside = caret > from && caret < to;
      if (inside || direction === 'left' && caret === to || direction === 'right' && caret === from) {
        target = { from, to, name: match.name };
        return false;
      }
    }
  });
  if (!target) return false;
  const { from, to, name } = target;
  const tr = editor.state.tr.replaceWith(from, to, editor.schema.nodes.journalTag.create({ name }));
  tr.setSelection(NodeSelection.create(tr.doc, from));
  editor.view.dispatch(tr);
  return true;
}

export function commitTypedTags(editor: Editor, includeCurrent = false) {
  const { from: caret } = editor.state.selection;
  const matches: { from: number; to: number; name: string }[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'codeBlock') return false;
    if (!node.isText || node.marks.some(mark => mark.type.name === 'code' || mark.type.name === 'link')) return;
    for (const match of tagMatches(node.text ?? '')) {
      const from = position + match.from, to = position + match.to;
      if (includeCurrent || caret < from || caret > to) matches.push({ from, to, name: match.name });
    }
  });
  const tr = editor.state.tr;
  for (const match of matches.reverse()) tr.replaceWith(match.from, match.to, editor.schema.nodes.journalTag.create({ name: match.name }));
  if (tr.docChanged) tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(caret, 1)), 1));
  if (tr.docChanged) editor.view.dispatch(tr);
}
