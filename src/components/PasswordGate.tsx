import { useEffect, useRef, useState, type FormEvent } from 'react';
import styled from 'styled-components';

const Gate = styled.dialog<{ $revealing: boolean }>`
  position: fixed; inset: 0; width: 100vw; height: 100dvh; max-width: none; max-height: none;
  z-index: 100; display: grid; place-items: center; margin: 0; padding: 24px; border: 0;
  color: var(--ink); background: #00000014;
  opacity: ${({ $revealing }) => $revealing ? 0 : 1};
  transition: opacity 220ms var(--ease-out);
  &::backdrop { background: transparent; }
`;
const Form = styled.form<{ $hidden: boolean }>`
  position: relative; margin: 0; opacity: ${({ $hidden }) => $hidden ? 0 : 1};
  pointer-events: ${({ $hidden }) => $hidden ? 'none' : 'auto'};
  transition: opacity 140ms ease-out;
`;
const PasswordLine = styled.label`
  display: flex; align-items: baseline; gap: 9px; color: var(--ink); font-size: 13px; line-height: 18px;
`;
const Password = styled.input`
  width: min(180px, 48vw); min-width: 0; height: 18px; padding: 0 1px; border: 0; border-bottom: 1px solid currentColor;
  border-radius: 0; outline: 0; background: transparent; color: var(--ink); font-size: 16px; line-height: 18px; letter-spacing: .08em;
  opacity: .72; transition: opacity 120ms ease-out;
  &:focus { opacity: 1; }
  &:disabled { opacity: .55; }
`;
const Error = styled.p`
  position: absolute; top: calc(100% + 7px); right: 0; margin: 0; color: var(--danger);
  font-size: 11px; line-height: 14px; white-space: nowrap;
`;

export function PasswordGate({ authenticate, phase }: {
  authenticate: (password: string) => Promise<boolean>; phase: 'locked' | 'unlocking' | 'revealing';
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const node = dialog.current!;
    if (!node.open) node.showModal();
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      if (node.open) node.close();
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true); setError('');
    try {
      if (!await authenticate(password)) {
        setError('wrong password'); setPassword('');
        requestAnimationFrame(() => input.current?.focus());
      }
    } catch {
      setError('couldn’t connect');
    } finally {
      setBusy(false);
    }
  };

  return <Gate ref={dialog} $revealing={phase === 'revealing'} aria-label="Password required" onCancel={event => event.preventDefault()}>
    <Form $hidden={phase !== 'locked'} onSubmit={submit}>
      <PasswordLine><span>password</span><Password ref={input} aria-label="Password" type="password" autoComplete="current-password"
        enterKeyHint="go" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></PasswordLine>
      <Error role="alert" aria-live="polite">{error}</Error>
    </Form>
  </Gate>;
}
