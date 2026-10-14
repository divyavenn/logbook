import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';
import { dateObject, deleteSession, duration, errorMessage, getSessions, localDate, saveSession, timerDuration } from '../api';
import type { Session } from '../types';
import { InlineError } from '../styles';
import { Modal } from './Modal';

const Title = styled.div`display: flex; align-items: baseline; flex-wrap: wrap; gap: 12px; padding: 8px 12px 18px; font-size: 17px; span { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }`;
const SessionList = styled.div`display: grid; gap: 2px;`;
const SessionRow = styled.form`display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 40px; align-items: center; min-height: 40px; font-size: 14px; font-variant-numeric: tabular-nums;`;
const TimeButton = styled.button`min-height: 40px; padding: 8px 12px; border: 0; background: transparent; text-align: left; border-radius: 6px; &:hover { color: var(--link); }`;
const Input = styled.input`
  width: 100%; min-width: 0; min-height: 40px; padding: 8px 12px; border: 0; border-radius: 0;
  outline: none; box-shadow: none; background: transparent; color: var(--ink); font: inherit;
  &:focus, &:focus-visible { outline: none; box-shadow: none; background: transparent; }
`;
const SymbolButton = styled.button`display: grid; place-items: center; width: 40px; height: 40px; padding: 0; border: 0; background: transparent; color: var(--muted); border-radius: 50%; span { display: block; font-size: 20px; font-weight: 300; transition: transform 140ms ease-out, color 140ms ease-out; } &:hover span { transform: rotate(90deg); color: var(--ink); }`;
const Add = styled(SymbolButton)`margin: 12px 0 0; &:hover span { transform: scale(1.12); }`;

function inputTime(value: string) {
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function parseDuration(value: string) {
  if (/^\d+:\d{1,2}:\d{1,2}$/.test(value.trim())) {
    const [h, m, s] = value.split(':').map(Number);
    if (m < 60 && s < 60) return h * 3600 + m * 60 + s;
  }
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  const match = /^\s*(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+(?:\.\d+)?)s\s*)?$/i.exec(value);
  return match && match.slice(1).some(Boolean) ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : NaN;
}

export function SessionsModal({ date, onClose, onChange }: {
  date: string | null; onClose: () => void; onChange: () => Promise<void>;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [started, setStarted] = useState('');
  const [originalStart, setOriginalStart] = useState<string | null>(null);
  const [length, setLength] = useState('00:25:00');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [loadedAt, setLoadedAt] = useState(Date.now());
  const load = useCallback(async () => {
    if (!date) return;
    const rows = await getSessions(date);
    setSessions(rows); setLoadedAt(Date.now()); setNow(Date.now());
  }, [date]);
  useEffect(() => {
    if (!date) return;
    setSessions([]); setError(''); setEditing(null);
    void load().catch(e => setError(errorMessage(e)));
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [date, load]);
  const runningSeconds = (session: Session) => session.ended_at ? session.duration_seconds : session.duration_seconds + Math.max(0, (now - loadedAt) / 1000);
  const total = sessions.reduce((sum, session) => sum + (session.seconds_on_day ?? session.duration_seconds) +
    (!session.ended_at && date === localDate() ? Math.max(0, (now - loadedAt) / 1000) : 0), 0);
  const save = async () => {
    if (busy || editing === null) return;
    const seconds = parseDuration(length);
    if (!Number.isFinite(seconds) || seconds <= 0) { setError('Enter a duration such as 30s or 00:25:00.'); return; }
    if (!date || !/^\d{2}:\d{2}$/.test(started)) { setError('Enter a start time.'); return; }
    setBusy(true); setError('');
    try {
      await saveSession(editing, {
        started_at: originalStart && started === inputTime(originalStart) ? originalStart : new Date(`${originalStart ? localDate(new Date(originalStart)) : date}T${started}:00`).toISOString(), duration_seconds: seconds,
      });
      setEditing(null); await load(); await onChange();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  };
  const edit = (session: Session) => { setEditing(session.id); setOriginalStart(session.started_at); setStarted(inputTime(session.started_at)); setLength(timerDuration(session.duration_seconds)); setError(''); };
  const editRow = (key: number | string) => <SessionRow key={key} onSubmit={e => { e.preventDefault(); void save(); }}
    onKeyDown={e => {
      if (e.key === 'Enter') { e.preventDefault(); void save(); }
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setEditing(null); setError(''); }
    }}>
    <Input aria-label="Start time" type="time" step="60" required autoFocus value={started} onChange={e => setStarted(e.target.value)} />
    <Input aria-label="Duration" title="Hours:minutes:seconds, or 30s" required value={length} onChange={e => setLength(e.target.value)} />
  </SessionRow>;
  return <Modal open={date !== null} onClose={onClose} title={date ? `Sessions for ${date}` : 'Sessions'} compact>
    <Title>{date && dateObject(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}<span>{duration(total)}</span></Title>
    <SessionList>{sessions.map(session => editing === session.id ? editRow(session.id) : <SessionRow key={session.id}>
      <TimeButton type="button" disabled={!session.ended_at} aria-label={`Edit start of session ${session.id}`} title={new Date(session.started_at).toLocaleString()} onClick={() => edit(session)}>{new Date(session.started_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</TimeButton>
      <TimeButton type="button" disabled={!session.ended_at} aria-label={`Edit duration of session ${session.id}`} onClick={() => edit(session)}>{duration(runningSeconds(session))}</TimeButton>
      <SymbolButton type="button" disabled={!session.ended_at || busy} aria-label={`Delete session ${session.id}`} onClick={async () => {
        setBusy(true); setError('');
        try { await deleteSession(session.id); setSessions(current => current.filter(row => row.id !== session.id)); await onChange(); }
        catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
      }}><span aria-hidden="true">×</span></SymbolButton>
    </SessionRow>)}{editing === 'new' && editRow('new')}</SessionList>
    {error && <InlineError role="alert">{error}</InlineError>}
    <Add type="button" aria-label="Add session" disabled={busy} onClick={() => {
      const initial = new Date(Date.now() - 25 * 60000);
      setOriginalStart(null);
      setStarted(date === localDate(initial) ? inputTime(initial.toISOString()) : '09:00');
      setLength('00:25:00'); setEditing('new'); setError('');
    }}><span aria-hidden="true">+</span></Add>
  </Modal>;
}
