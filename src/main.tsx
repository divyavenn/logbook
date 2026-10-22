import React, { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import styled from 'styled-components';
import App from './App';
import { GlobalStyle } from './styles';
import { PasswordGate } from './components/PasswordGate';
import { installTouchHaptics } from './haptics';
import { getAuthStatus, login } from './api';
import { storage } from './storage';

document.documentElement.dataset.theme = storage.getItem('still-theme') === 'night' ? 'night' : 'day';

const AppSurface = styled.div<{ $blurred: boolean; $blocked: boolean }>`
  min-height: 100dvh; filter: blur(${({ $blurred }) => $blurred ? '7px' : '0'});
  opacity: ${({ $blurred }) => $blurred ? .72 : 1}; pointer-events: ${({ $blocked }) => $blocked ? 'none' : 'auto'};
  user-select: ${({ $blocked }) => $blocked ? 'none' : 'auto'};
  transition-property: filter, opacity; transition-duration: 260ms; transition-timing-function: cubic-bezier(.2, 0, 0, 1);
`;

// Whether the last answer from the server let us in. With no network there is
// nobody to ask, and every request still has to prove itself once there is.
const UNLOCKED_KEY = 'still-unlocked';

function Root() {
  // Opening is not the moment to wait on an answer we already have. The last
  // one stands until the server corrects it, and every request still proves
  // itself, so a stale yes costs a round trip and shows only what this device
  // had cached anyway.
  const [state, setState] = useState<'checking' | 'locked' | 'unlocking' | 'revealing' | 'ready'>(
    () => storage.getItem(UNLOCKED_KEY) === 'true' ? 'ready' : 'checking');
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
  const gatePhase = state === 'locked' ? 'locked' : state === 'unlocking' ? 'unlocking' : state === 'revealing' ? 'revealing' : null;
  return <><AppSurface data-testid="auth-surface" $blurred={blurred} $blocked={blocked} aria-hidden={blocked || undefined} inert={blocked || undefined}>
    <App locked={blocked} load={load} onReady={contentReady} onLoadError={loadFailed} />
  </AppSurface>
    {gatePhase && <PasswordGate authenticate={authenticate} phase={gatePhase} />}</>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><GlobalStyle /><Root /></React.StrictMode>,
);
