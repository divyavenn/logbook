import { Component, lazy, type ComponentType, type ReactNode } from 'react';
import styled from 'styled-components';
import { TextButton } from './styles';

// A deploy renames every piece of the app, and the service worker drops the
// old pieces as soon as the new build takes over. A page still running the
// old build then asks for a piece that is gone. Rather than failing, it
// reloads once into the build that has it; a second failure in the same
// session is a real one, and is left to the boundaries below.
const RELOADED_KEY = 'still-reloaded-for-new-build';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any component's props, as React.lazy takes them
export function lazyPart<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy<T>(async () => {
    try {
      const part = await load();
      sessionStorage.removeItem(RELOADED_KEY);
      return part;
    } catch (error) {
      if (sessionStorage.getItem(RELOADED_KEY)) throw error;
      sessionStorage.setItem(RELOADED_KEY, '1');
      window.location.reload();
      // Nothing renders while the page goes.
      return new Promise<never>(() => {});
    }
  });
}

// A part that fails to render is let go, and the rest of the page stays.
export class PartBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('A part of the page failed:', error); }
  render() { return this.state.failed ? null : this.props.children; }
}

const Fallback = styled.main`
  min-height: 100dvh; display: grid; place-content: center; justify-items: center; gap: 12px; padding: 24px;
  color: var(--ink); background: var(--paper); text-align: center;
  p { margin: 0; color: var(--muted); font-size: 15px; }
`;

// The last line: whatever broke, the reader is offered a way back rather than
// a blank page. Drafts are kept on the device, so a reload loses nothing.
export class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error('The page failed:', error); }
  render() {
    if (!this.state.failed) return this.props.children;
    return <Fallback role="alert">
      <p>Something went wrong. Your writing is saved on this device.</p>
      <TextButton type="button" onClick={() => window.location.reload()}>Reload</TextButton>
    </Fallback>;
  }
}
