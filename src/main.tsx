import React, { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import styled from 'styled-components';
import App from './App';
import { GlobalStyle } from './styles';
import { PasswordGate } from './components/PasswordGate';
import { installTouchHaptics } from './haptics';

document.documentElement.dataset.theme = localStorage.getItem('still-theme') === 'night' ? 'night' : 'day';

const AppSurface = styled.div<{ $blurred: boolean; $blocked: boolean }>`
  min-height: 100dvh; filter: blur(${({ $blurred }) => $blurred ? '7px' : '0'});
  opacity: ${({ $blurred }) => $blurred ? .72 : 1}; pointer-events: ${({ $blocked }) => $blocked ? 'none' : 'auto'};
  user-select: ${({ $blocked }) => $blocked ? 'none' : 'auto'};
  transition-property: filter, opacity; transition-duration: 260ms; transition-timing-function: cubic-bezier(.2, 0, 0, 1);
`;

function Root() {
  const [state, setState] = useState<'checking' | 'locked' | 'unlocking' | 'revealing' | 'ready'>('checking');
  useEffect(() => installTouchHaptics(), []);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/status').then(async response => {
      if (!response.ok) throw new Error();
      const status = await response.json() as { enabled: boolean; authenticated: boolean };
      if (!cancelled) setState(status.enabled && !status.authenticated ? 'locked' : 'ready');
    }).catch(() => { if (!cancelled) setState('locked'); });
    const lock = () => setState('locked');
    window.addEventListener('still-auth-required', lock);
    return () => { cancelled = true; window.removeEventListener('still-auth-required', lock); };
  }, []);
  const authenticate = useCallback(async (password: string) => {
    const response = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
    });
    if (response.status === 401) return false;
    if (!response.ok) throw new Error();
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
