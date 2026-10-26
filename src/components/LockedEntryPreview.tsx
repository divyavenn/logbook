import { useEffect } from 'react';
import styled from 'styled-components';
import { MarkdownContent, richTextStyles } from '../markdown';
import { dateObject } from '../api';
import type { OutlineItem, SharedEntry } from '../types';

// What a link shows a reader who does not have the password: the entry it
// names, what is written beneath it, and the day it was written on. The rest
// of the page stays behind its blur, and reaching for any of it asks.
const Card = styled.section`
  position: fixed; inset: 0; z-index: 60; display: grid; place-items: center;
  padding: max(24px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom));
  pointer-events: none;
`;
const Sheet = styled.div`
  pointer-events: auto; width: min(560px, 100%); max-height: 100%; overflow-y: auto;
  padding: 24px 26px; border-radius: 10px; background: var(--paper);
  box-shadow: 0 1px 2px rgb(0 0 0 / .06), 0 12px 32px rgb(0 0 0 / .12);
  @starting-style { opacity: 0; transform: translateY(6px); }
  transition-property: opacity, transform; transition-duration: 320ms, 420ms;
  transition-timing-function: ease-out, cubic-bezier(.2, 0, 0, 1);
  @media (prefers-reduced-motion: reduce) { transition: none; }
`;
const Day = styled.p`margin: 0 0 10px; font-size: 13px; color: var(--muted);`;
const Entry = styled.div`${richTextStyles}; color: var(--ink);`;
const Children = styled.ul`
  margin: 6px 0 0; padding-left: 18px; list-style: none;
  li { position: relative; margin-top: 4px; }
  li::before { content: '–'; position: absolute; left: -14px; color: var(--ink); }
`;
const Rest = styled.p`
  margin: 18px 0 0; font-size: 13px; color: var(--muted);
  button { padding: 0; border: 0; background: transparent; color: var(--link); font: inherit; cursor: pointer; }
`;

const readableDate = (value: string) =>
  dateObject(value).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

function Written({ entry }: { entry: OutlineItem }) {
  return <MarkdownContent document={entry.document} content={entry.content} tags={entry.tags} />;
}

export function LockedEntryPreview({ shared, onUnlockRequest }: { shared: SharedEntry; onUnlockRequest: () => void }) {
  // Anything outside this card belongs to the journal, which is not for this
  // reader until they have the password. The first reach for it asks for one.
  useEffect(() => {
    const elsewhere = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-shared-preview]')) return;
      onUnlockRequest();
    };
    window.addEventListener('pointerdown', elsewhere, true);
    window.addEventListener('keydown', elsewhere, true);
    return () => {
      window.removeEventListener('pointerdown', elsewhere, true);
      window.removeEventListener('keydown', elsewhere, true);
    };
  }, [onUnlockRequest]);
  return <Card data-shared-preview data-testid="shared-entry-preview" role="region" aria-label="Shared entry">
    <Sheet>
      {shared.date && <Day>{readableDate(shared.date)}</Day>}
      <Entry><Written entry={shared.entry} />
        {!!shared.children.length && <Children>
          {shared.children.map(child => <li key={child.id}><Written entry={child} /></li>)}
        </Children>}
      </Entry>
      <Rest>The rest of this logbook is private. <button type="button" onClick={onUnlockRequest}>Enter the password</button> to read it.</Rest>
    </Sheet>
  </Card>;
}
