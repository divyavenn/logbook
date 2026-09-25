import { useEffect, useRef, useState, type FormEvent } from 'react';
import styled, { keyframes } from 'styled-components';
import { CircleAlert } from 'lucide-react';
import { addCalendarSubscription, deleteCalendarSubscription, errorMessage, getCalendarSubscriptions } from '../api';
import { Field } from '../styles';
import type { CalendarSubscription } from '../types';
import { Modal } from './Modal';

const Content = styled.div`
  display: grid; gap: 10px; padding: 8px 8px 8px 16px;
  @media(max-width: 500px) { padding: 8px 6px 8px 14px; }
`;
const SubscriptionGroup = styled.div`display: grid;`;
const SubscriptionList = styled.div`display: grid;`;
const SubscriptionRow = styled.div`
  min-height: 40px; display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px;
`;
const CalendarName = styled.span`min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`;
const CalendarIdentity = styled.span`min-width: 0; display: flex; align-items: center; gap: 2px;`;
const AddForm = styled.form`
  display: grid; grid-template-columns: minmax(0, 1fr) 40px; align-items: center;
`;
const BareField = styled(Field)`
  min-height: 40px; padding: 8px 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; font-size: 12px;
  &:focus, &:focus-visible { border: 0; background: transparent; box-shadow: none; }
`;
const SymbolButton = styled.button`
  display: grid; place-items: center; width: 40px; height: 40px; padding: 0; border: 0; background: transparent;
  color: var(--muted); border-radius: 50%;
  span { display: block; font-size: 19px; font-weight: 200; opacity: .5; transition: transform 140ms ease-out, color 140ms ease-out, opacity 140ms ease-out; }
  &:hover span { transform: rotate(90deg); color: var(--ink); opacity: .9; }
`;
const QuestionButton = styled(SymbolButton)`
  color: var(--link);
  span { width: 16px; height: 16px; display: grid; place-items: center; border: 1px solid currentColor; border-radius: 50%; font-size: 10px; font-weight: 500; opacity: .72; }
  &:hover span { transform: none; color: var(--link); opacity: 1; }
`;
const spin = keyframes`to { transform: rotate(360deg); }`;
const LoadingIndicator = styled.span`
  width: 40px; height: 40px; display: grid; place-items: center; flex: 0 0 auto; color: var(--muted);
  &::before { content: ''; width: 12px; height: 12px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: ${spin} 700ms linear infinite; }
  @media(prefers-reduced-motion: reduce) { &::before { animation: none; } }
`;
const ErrorIndicator = styled.button`
  position: relative; width: 24px; height: 40px; display: grid; place-items: center; flex: 0 0 auto; padding: 0; border: 0;
  color: var(--danger); background: transparent; cursor: pointer;
`;
const ExplanationText = styled.p<{ $error?: boolean }>`
  color: ${({ $error }) => $error ? 'var(--danger)' : 'var(--muted)'}; font-size: 12px; line-height: 1.45; padding: 0 2px 4px;
  a { color: var(--link); text-underline-offset: 2px; }
`;

export function CalendarModal({ open, onClose, onChange }: { open: boolean; onClose: () => void; onChange: () => Promise<void> }) {
  const [calendars, setCalendars] = useState<CalendarSubscription[]>([]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selectedErrorId, setSelectedErrorId] = useState<number | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const request = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const atLimit = calendars.length >= 5;
  const selectedCalendar = calendars.find(calendar => calendar.id === selectedErrorId && calendar.status === 'error');
  const selectedError = selectedCalendar ? selectedCalendar.error || 'Could not connect this calendar.' : '';
  useEffect(() => {
    if (!open) return;
    setError(''); setSelectedErrorId(null); setHelpOpen(false);
    void getCalendarSubscriptions().then(setCalendars).catch(value => setError(errorMessage(value)));
  }, [open]);
  useEffect(() => {
    if (!open || !calendars.some(calendar => calendar.status === 'connecting')) return;
    const timeout = setTimeout(() => {
      void getCalendarSubscriptions().then(next => {
        const connected = calendars.some(calendar => calendar.status === 'connecting' && next.some(item => item.id === calendar.id && item.status === 'connected'));
        setCalendars(next);
        if (connected) void onChange().catch(value => setError(errorMessage(value)));
      }).catch(value => setError(errorMessage(value)));
    }, 700);
    return () => clearTimeout(timeout);
  }, [calendars, onChange, open]);
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim() || busy || atLimit) return;
    setBusy(true); setError('');
    const controller = new AbortController();
    const version = ++requestVersion.current;
    request.current = controller;
    try {
      const calendar = await addCalendarSubscription(url, controller.signal);
      if (version !== requestVersion.current) return;
      setCalendars(current => [...current, calendar]); setUrl('');
    } catch (value) {
      if (version === requestVersion.current && !(value instanceof DOMException && value.name === 'AbortError')) setError(errorMessage(value));
    } finally {
      if (version === requestVersion.current) {
        request.current = null;
        setBusy(false);
      }
    }
  };
  const cancel = () => {
    requestVersion.current++;
    request.current?.abort();
    request.current = null;
    setBusy(false);
  };
  const remove = async (calendar: CalendarSubscription) => {
    if (busy) return;
    setBusy(true); setError(''); setSelectedErrorId(null);
    try {
      await deleteCalendarSubscription(calendar.id);
      setCalendars(current => current.filter(item => item.id !== calendar.id));
      void onChange().catch(value => setError(errorMessage(value)));
    } catch (value) { setError(errorMessage(value)); }
    finally { setBusy(false); }
  };
  return <Modal open={open} onClose={() => { cancel(); onClose(); }} title="Calendars" compact>
    <Content>
      <AddForm onSubmit={add}>
        <BareField aria-label="Calendar URL" value={url} onChange={event => setUrl(event.target.value)} inputMode="url" autoComplete="off" spellCheck={false}
          placeholder={atLimit ? 'Five calendars connected' : busy ? 'Connecting…' : 'Paste calendar URL and press Enter'} disabled={busy || atLimit} />
        {busy ? <SymbolButton type="button" onClick={cancel} aria-label="Cancel calendar connection"><span aria-hidden="true">×</span></SymbolButton> :
          <QuestionButton type="button" aria-label="Calendar URL help" aria-expanded={helpOpen} aria-controls="calendar-url-help"
            onClick={() => setHelpOpen(value => !value)}><span aria-hidden="true">?</span></QuestionButton>}
      </AddForm>
      {helpOpen && <ExplanationText id="calendar-url-help">On the desktop Google Calendar website: Settings → choose the calendar’s name → Integrate calendar → Secret address in iCal format. <a href="https://support.google.com/calendar/answer/37648" target="_blank" rel="noopener noreferrer">Google’s instructions</a>.</ExplanationText>}
      {!!calendars.length && <SubscriptionGroup>
        <SubscriptionList aria-label="Connected calendars">
          {calendars.map(calendar => <SubscriptionRow key={calendar.id}>
            {calendar.status === 'error' ? <CalendarIdentity>
                <CalendarName title={`${calendar.name} · ${calendar.host}`}>{calendar.name}</CalendarName>
                <ErrorIndicator type="button" aria-label={`Show error for ${calendar.name}`} aria-expanded={selectedErrorId === calendar.id}
                  onClick={() => setSelectedErrorId(current => current === calendar.id ? null : calendar.id)}><CircleAlert size={15} aria-hidden="true" /></ErrorIndicator>
              </CalendarIdentity> : <CalendarName title={`${calendar.name} · ${calendar.host}`}>{calendar.name}</CalendarName>}
            {calendar.status === 'connecting' ? <LoadingIndicator role="status" aria-label={`Connecting ${calendar.name}`} /> :
              <SymbolButton type="button" disabled={busy} aria-label={`Remove ${calendar.name}`} onClick={() => void remove(calendar)}><span aria-hidden="true">×</span></SymbolButton>}
          </SubscriptionRow>)}
        </SubscriptionList>
        {!error && selectedError && <ExplanationText $error role="status">{selectedError}</ExplanationText>}
      </SubscriptionGroup>}
      {error && <ExplanationText $error role="alert">{error}</ExplanationText>}
    </Content>
  </Modal>;
}
