import type { Node as DocumentNode } from '@tiptap/pm/model';

export type TextOffsets = { anchor: number; head: number };

export function domText(root: Node): string {
  let text = '', seenBlock = false;
  const visit = (part: Node) => {
    if (part.nodeType === Node.TEXT_NODE) { text += part.textContent ?? ''; return; }
    if (part instanceof Element) {
      if (part.classList.contains('ProseMirror-trailingBreak')) return;
      if (part.tagName === 'BR') { text += '\n'; return; }
      if (/^(P|H[1-6]|PRE)$/.test(part.tagName)) {
        if (seenBlock) text += '\n';
        seenBlock = true;
      }
    }
    part.childNodes.forEach(visit);
  };
  visit(root);
  return text;
}

// The read view and editor share these offsets: one character per hard break
// or block boundary, and the full visible label for an atomic tag.
export function domTextOffset(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(node, offset);
  return domText(range.cloneContents()).length;
}

export function textPositions(doc: DocumentNode) {
  const spans: { from: number; to: number; start: number; length: number; text: boolean }[] = [];
  let length = 0, previousEnd: number | null = null;
  doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    const from = pos + 1;
    if (previousEnd !== null) {
      spans.push({ from: previousEnd, to: from, start: length++, length: 1, text: false });
    }
    spans.push({ from, to: from, start: length, length: 0, text: false });
    block.forEach((node, offset) => {
      const size = node.isText ? node.nodeSize : node.type.name === 'journalTag' ? String(node.attrs.name).length + 1 : 1;
      spans.push({ from: from + offset, to: from + offset + node.nodeSize, start: length, length: size, text: node.isText });
      length += size;
    });
    previousEnd = from + block.content.size;
    return false;
  });
  return {
    positionAt(offset: number) {
      offset = Math.max(0, offset);
      for (const span of spans) {
        if (offset <= span.start + span.length) {
          return span.from + (span.text ? offset - span.start : offset > span.start ? span.to - span.from : 0);
        }
      }
      return previousEnd ?? 1;
    },
    offsetAt(position: number) {
      for (const span of spans) {
        if (position < span.from) return span.start;
        if (position <= span.to) return span.start + (span.text ? position - span.from : position > span.from ? span.length : 0);
      }
      return length;
    },
  };
}
