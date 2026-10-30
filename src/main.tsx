import React, { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import styled from 'styled-components';
import App from './App';
import { GlobalStyle, applyTheme } from './styles';
import { PasswordGate } from './components/PasswordGate';
import { installTouchHaptics } from './haptics';
import { getAuthStatus, getSharedEntry, login } from './api';
import { storage } from './storage';
import { parseEntryLink } from './entryLinks';
import { LockedEntryPreview } from './components/LockedEntryPreview';
import type { SharedEntry } from './types';

applyTheme(storage.getItem('still-theme') === 'night');

const AppSurface = styled.div<{ $blurred: boolean; $blocked: boolean }>`
  min-height: 100dvh; filter: blur(${({ $blurred }) => $blurred ? '7px' : '0'});
  opacity: ${({ $blurred }) => $blurred ? .72 : 1}; pointer-events: ${({ $blocked }) => $blocked ? 'none' : 'auto'};
  user-select: ${({ $blocked }) => $blocked ? 'none' : 'auto'};
  transition-property: filter, opacity; transition-duration: 260ms; transition-timing-function: var(--ease-out);
`;

// Whether the last answer from the server let us in. With no network there is
// nobody to ask, and every request still has to prove itself once there is.
const UNLOCKED_KEY = 'still-unlocked';

function Root() {
  // Opening is not the moment to wait on an answer we already have. The last
  // one stands until the server corrects it, and every request still proves
  // itself, so a stale yes costs a round trip and shows only what this device
  // had cached anyway.
  const [state, setState] = useState<'checking' | 'locked' | 'previewing' | 'unlocking' | 'revealing' | 'ready'>(
    () => storage.getItem(UNLOCKED_KEY) === 'true' ? 'ready' : 'checking');
  // An entry a link asked for, shown to a reader the journal is closed to.
  const [shared, setShared] = useState<SharedEntry | null>(null);
  useEffect(() => installTouchHaptics(), []);
  useEffect(() => {
    let cancelled = false;
    getAuthStatus().then(status => {
      const locked = status.enabled && !status.authenticated;
      storage.setItem(UNLOCKED_KEY, locked ? 'false' : 'true');
      if (!cancelled) setState(locked ? 'locked' : 'ready');
    }).catch(() => {
      if (!cancelled) setState(storage.getItem(UNLOCKED_KEY) === 'true' ? 'ready' : 'locked');
    });
    const lock = () => { storage.setItem(UNLOCKED_KEY, 'false'); setState('locked'); };
    window.addEventListener('still-auth-required', lock);
    return () => { cancelled = true; window.removeEventListener('still-auth-required', lock); };
  }, []);
  // Locked, with a link in hand: that one entry can be read, and nothing else.
  // Keyed on the state rather than on mounting, because a cached yes opens the
  // journal first and the lock can arrive later, when a request is refused.
  useEffect(() => {
    if (state !== 'locked' || shared) return;
    const link = parseEntryLink(window.location.hash);
    if (!link) return;
    let cancelled = false;
    getSharedEntry(link).then(entry => {
      if (cancelled) return;
      setShared(entry);
      setState(current => current === 'locked' ? 'previewing' : current);
    }).catch(() => {
      // A link that does not answer is simply a locked journal. Nothing says
      // whether the entry is there, so nothing can be learned by trying.
    });
    return () => { cancelled = true; };
  }, [state, shared]);
  const authenticate = useCallback(async (password: string) => {
    if (!await login(password)) return false;
    storage.setItem(UNLOCKED_KEY, 'true');
    setState('unlocking'); return true;
  }, []);
  useEffect(() => {
    if (state !== 'revealing') return;
    const timer = setTimeout(() => setState('ready'), 280);
    return () => clearTimeout(timer);
  }, [state]);
  const contentReady = useCallback(() => setState(current => current === 'unlocking' ? 'revealing' : current), []);
  const loadFailed = useCallback(() => setState(current => current === 'unlocking' ? 'locked' : current), []);
  const blocked = state !== 'ready';
  const blurred = state !== 'revealing' && state !== 'ready';
  const load = state === 'unlocking' || state === 'revealing' || state === 'ready';
  // While an entry is being read from a link the gate stays shut: it opens as
  // a modal dialog, which would make the page behind it unreadable and ask for
  // a password nobody has yet been given a reason to type.
  const gatePhase = state === 'locked' ? 'locked' : state === 'unlocking' ? 'unlocking' : state === 'revealing' ? 'revealing' : null;
  const askForPassword = useCallback(() => setState(current => current === 'previewing' ? 'locked' : current), []);
  return <><AppSurface data-testid="auth-surface" $blurred={blurred} $blocked={blocked} aria-hidden={blocked || undefined} inert={blocked || undefined}>
    <App locked={blocked} load={load} onReady={contentReady} onLoadError={loadFailed} />
  </AppSurface>
    {state === 'previewing' && shared && <LockedEntryPreview shared={shared} onUnlockRequest={askForPassword} />}
    {gatePhase && <PasswordGate authenticate={authenticate} phase={gatePhase} />}</>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><GlobalStyle /><Root /></React.StrictMode>,
);
