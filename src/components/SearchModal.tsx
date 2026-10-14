import { useEffect, useState } from 'react';
import styled from 'styled-components';
import { searchEntries, errorMessage } from '../api';
import { markdownText } from '../markdown';
import type { SearchHit, SearchResults } from '../types';
export type { SearchHit } from '../types';
import { Modal } from './Modal';
import { InlineError, TextButton } from '../styles';

const Input = styled.input`width: 100%; min-height: 44px; padding: 8px 12px; border: 0; background: transparent; color: var(--ink); outline: none; font-size: 16px;`;
const ResultsList = styled.div`max-height: 50dvh; overflow-y: auto;`;
const Result = styled.button<{ $selected: boolean }>`display: block; width: 100%; min-height: 44px; padding: 10px 12px; border: 0; background: ${({ $selected }) => $selected ? 'var(--soft)' : 'transparent'}; border-radius: 6px; text-align: left; font-size: 14px; color: var(--ink); span { display: block; color: var(--muted); font-size: 11px; margin-top: 3px; }`;
const Empty = styled.p`padding: 12px; color: var(--muted); font-size: 13px;`;

export function SearchModal({ open, onClose, onSelect }: { open: boolean; onClose: () => void; onSelect: (hit: SearchHit) => Promise<void> }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResults>({ results: [], next_offset: null });
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(''); setSelected(0); setResult({ results: [], next_offset: null });
    if (!query.trim()) { setLoading(false); return; }
    setLoading(true);
    const timeout = setTimeout(() => {
      void searchEntries(query.trim()).then(data => { if (!cancelled) setResult(data); })
        .catch(e => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    }, 150);
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [query, open]);
  useEffect(() => { if (open) document.getElementById(`search-result-${selected}`)?.scrollIntoView({ block: 'nearest' }); }, [selected, open]);
  return <Modal open={open} onClose={onClose} title="Search journal" compact>
    <Input autoFocus aria-label="Search all notes and tasks" placeholder="Search" value={query} onChange={e => setQuery(e.target.value)}
      onKeyDown={e => {
        if (['ArrowDown', 'ArrowUp'].includes(e.key) && result.results.length) { e.preventDefault(); setSelected(value => (value + (e.key === 'ArrowDown' ? 1 : -1) + result.results.length) % result.results.length); }
        if (e.key === 'Enter' && result.results[selected]) { e.preventDefault(); void onSelect(result.results[selected]); }
      }} />
    <ResultsList>{result.results.map((hit, index) => <Result key={`${hit.kind}-${hit.id}`} id={`search-result-${index}`} $selected={selected === index} onClick={() => void onSelect(hit)}>{markdownText(hit.content).slice(0, 220) || hit.tags?.map(tag => '#' + tag).join(' ')}<span>{hit.date ?? 'tasks'}</span></Result>)}</ResultsList>
    {!loading && query.trim() && !result.results.length && !error && <Empty>No matches</Empty>}
    {error && <InlineError role="alert">{error}</InlineError>}
    {result.next_offset !== null && <TextButton onClick={async () => {
      try { const more = await searchEntries(query.trim(), result.next_offset ?? 0); setResult(current => ({ results: [...current.results, ...more.results], next_offset: more.next_offset })); }
      catch (e) { setError(errorMessage(e)); }
    }}>More</TextButton>}
  </Modal>;
}
