import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import styled, { css, keyframes } from 'styled-components';
import { CalendarDays, ChartNoAxesColumn, Github, Moon, Sun, Timer as TimerIcon } from 'lucide-react';
import { api, errorMessage, localDate, recoverEarlierDrafts, timerDuration } from './api';
import { FocusSound } from './audio';
import type { Day, JournalData, Session } from './types';
import { Button, Muted, TextButton, press } from './styles';
import { Journal, Todos } from './components/Journal';
import { TagTabs } from './components/TagTabs';
import { JournalContext, flushDrafts } from './JournalContext';
import { Modal } from './components/Modal';
import type { SearchHit } from './components/SearchModal';
import { documentUndo, recordCompletion } from './documentHistory';
import { compactViewport, shortViewport } from './layout';

const JOURNAL_PAGE_SIZE = 14;
const MOBILE_VIEWS = ['todos', 'log', 'tags'] as const;
type MobileView = typeof MOBILE_VIEWS[number];
const mobileViewIndex = (view: MobileView) => MOBILE_VIEWS.indexOf(view);
const REPOSITORY_URL = import.meta.env.VITE_REPOSITORY_URL || 'https://github.com/divyavenn/still';
const SessionsModal = lazy(() => import('./components/SessionsModal').then(module => ({ default: module.SessionsModal })));
const StatsModal = lazy(() => import('./components/StatsModal').then(module => ({ default: module.StatsModal })));
const SearchModal = lazy(() => import('./components/SearchModal').then(module => ({ default: module.SearchModal })));
const CalendarModal = lazy(() => import('./components/CalendarModal').then(module => ({ default: module.CalendarModal })));

const Page = styled.div<{ $focusing: boolean }>`
  --current-page-paper: ${({ $focusing }) => $focusing ? 'var(--page-focus-paper)' : 'var(--page-paper)'};
  --document-width: min(680px, calc(100vw - 64px));
  --left-margin: calc((100vw - var(--document-width)) * .54);
  --right-margin: calc(100vw - var(--document-width) - var(--left-margin));
  --page-top: 48px;
  --todo-heading-height: 44px;
  @media(pointer: coarse) { --todo-heading-height: 48px; }
  height: 100dvh; overflow-x: hidden; overflow-y: auto; display: flex; flex-direction: column;
  background-color: var(--current-page-paper);
  transition: background-color 180ms ease-out;
  [data-focus-chrome] { opacity: ${({ $focusing }) => $focusing ? 'var(--focus-chrome-opacity)' : 'var(--chrome-opacity)'}; transition: opacity 180ms ease-out; }
  ${({ $focusing }) => $focusing && css`
    :root:not([data-theme='night']) & [data-focus-surface] {
      --paper: color-mix(in srgb, #f2f1ed, #000 16%);
      --ink: color-mix(in srgb, #242422, #000 16%);
      --muted: color-mix(in srgb, #626762, #000 16%);
      --line: color-mix(in srgb, #d4d2cb, #000 16%);
      --sage: color-mix(in srgb, #59605d, #000 16%);
      --soft: color-mix(in srgb, #e8e6df, #000 16%);
      --surface: color-mix(in srgb, #faf9f6, #000 16%);
      --field: color-mix(in srgb, #fffefa, #000 16%);
      --date-bg: color-mix(in srgb, #dfe7ed, #000 16%);
      --tag-bg: color-mix(in srgb, #e8e6df, #000 16%);
      --tag-ink: color-mix(in srgb, #525a56, #000 16%);
      --tag-selected: color-mix(in srgb, #1871ba, #000 16%);
      --code-bg: color-mix(in srgb, #e6e7e1, #000 16%);
      --code-ink: color-mix(in srgb, #4d615d, #000 16%);
      --quote: color-mix(in srgb, #5f645f, #000 16%);
      --selection: color-mix(in srgb, #ccdbe7, #000 16%);
      --focus: color-mix(in srgb, #6f7f88, #000 16%);
      --link: color-mix(in srgb, #1871ba, #000 16%);
      --url: color-mix(in srgb, #70588f, #000 16%);
      --checkbox: color-mix(in srgb, #747773, #000 16%);
      --scrollbar: color-mix(in srgb, #c0beb7, #000 16%);
    }
  `}
  @media ${compactViewport} {
    --document-width: min(680px, calc(100vw - max(24px, env(safe-area-inset-left)) - max(16px, env(safe-area-inset-right))));
    --page-top: max(16px, env(safe-area-inset-top)); --todo-heading-height: 36px;
    --left-margin: max(24px, env(safe-area-inset-left), calc((100vw - var(--document-width)) * .54));
    --right-margin: calc(100vw - var(--document-width) - var(--left-margin));
    scrollbar-width: none;
    &::-webkit-scrollbar { display: none; }
  }
`;
const ringPulse = keyframes`
  from { scale: 1; opacity: .65; }
  to { scale: 1.14; opacity: 0; }
`;
const pageControl = css`
  ${press}; position: relative; display: grid; place-items: center;
  width: 28px; height: 36px; padding: 0; border: 0; border-radius: 50%;
  background: transparent; color: var(--muted); text-decoration: none;
  svg, [data-shortcut-icon] { transition: scale 140ms ease-out; }
  &:hover { color: var(--link); }
  &:hover svg, &:hover [data-shortcut-icon] { scale: 1.05; }
  @media(pointer: coarse) { width: 44px; height: 44px; }
`;
const ThemeToggle = styled.button`${pageControl}`;
const RepositoryLink = styled.a`${pageControl}`;
const ShortcutToggle = styled.button`${pageControl}`;
const ShortcutGlyph = styled.span`
  width: 15px; height: 15px; display: block; background: currentColor;
  mask: url('/icons/shortcut-flaticon.png') center / contain no-repeat;
  -webkit-mask: url('/icons/shortcut-flaticon.png') center / contain no-repeat;
`;
const ThemeGlyph = styled.span<{ $shown: boolean }>`
  position: absolute; display: grid; place-items: center; pointer-events: none;
  opacity: ${({ $shown }) => $shown ? 1 : 0}; scale: ${({ $shown }) => $shown ? 1 : .25};
  filter: blur(${({ $shown }) => $shown ? 0 : 4}px);
  transition: opacity 150ms cubic-bezier(.2,0,0,1), scale 150ms cubic-bezier(.2,0,0,1), filter 150ms cubic-bezier(.2,0,0,1);
`;
const StatsToggle = styled.button`${pageControl}`;
const CalendarToggle = styled.button`${pageControl}`;
const SidebarControls = styled.div`display: flex; align-items: center;`;
const TimerChrome = styled.div`
  position: fixed; top: 20px; right: 24px; z-index: 43;
  display: flex; align-items: center; gap: 10px;
  @media ${compactViewport} { top: max(12px, env(safe-area-inset-top)); right: 12px; }
`;
const TimerTime = styled.span`
  color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; letter-spacing: -.01em;
`;
const TimerButton = styled.button<{ $pulse: boolean; $running: boolean }>`
  ${press}; position: relative; width: 44px; height: 44px; display: grid; place-items: center; flex-shrink: 0;
  padding: 0; border: 0; border-radius: 50%; background: var(--timer); color: var(--timer-ink);
  &::before { content: ''; position: absolute; inset: -3px; border: 1px solid var(--timer-ring); border-radius: 50%; pointer-events: none; transition: border-color 160ms ease-out; }
  &::after { content: ''; position: absolute; inset: -3px; border: 1px solid ${({ $running }) => $running ? 'var(--timer-running-ring)' : 'var(--timer-ring)'}; border-radius: 50%; pointer-events: none; opacity: 0;
    ${({ $pulse }) => $pulse && css`animation: ${ringPulse} 360ms ease-out;`} }
  &:hover { background: var(--timer-hover); }
  &[aria-pressed='true'] { background: var(--timer-running); scale: 1.03; }
  &[aria-pressed='true']:hover { background: var(--timer-running-hover); }
  &[aria-pressed='true']::before { border-color: var(--timer-running-ring); }
`;
const ShortHeader = styled.div`
  height: 44px; flex-shrink: 0;
`;
const MobileTabs = styled.div`
  position: fixed; top: max(12px, env(safe-area-inset-top)); left: 12px; z-index: 43;
  height: 44px; display: flex; align-items: center;
`;
const MobileTab = styled.button<{ $active: boolean }>`
  position: relative; width: 44px; height: 44px; padding: 0; border: 0; background: transparent;
  color: ${({ $active }) => $active ? 'var(--link)' : 'var(--muted)'};
  font-size: 0;
  &::before { content: ''; position: absolute; left: 50%; top: 50%; width: ${({ $active }) => $active ? '7px' : '5px'}; height: ${({ $active }) => $active ? '7px' : '5px'};
    border-radius: 50%; background: currentColor; opacity: ${({ $active }) => $active ? 1 : .48}; translate: -50% -50%;
    transition: width 120ms ease-out, height 120ms ease-out, color 120ms ease-out, opacity 120ms ease-out; }
  &:first-child::before { translate: calc(-50% + 16px) -50%; }
  &:last-child::before { translate: calc(-50% - 16px) -50%; }
`;
const MobilePager = styled.div`
  display: flex; flex: 1; min-width: 0; min-height: 0; width: 100%; max-width: 100%; overflow-x: auto; overflow-y: hidden;
  scroll-snap-type: x mandatory; overscroll-behavior-x: none; scrollbar-width: none; -webkit-overflow-scrolling: touch;
  &::-webkit-scrollbar { display: none; }
`;
const MobilePane = styled.section`
  flex: 0 0 100%; width: 100%; max-width: 100%; min-width: 0; min-height: 0; overflow-x: clip; overflow-y: auto;
  display: flex; flex-direction: column; scrollbar-width: none;
  scroll-snap-align: start; scroll-snap-stop: always; contain: inline-size;
  padding: 0;
  &::-webkit-scrollbar { display: none; }
`;
const MobileTags = styled.div`
  padding: 0 2px max(12px, env(safe-area-inset-bottom));
`;
const MobileTagCollection = styled.div`
  display: flex; flex-wrap: wrap; align-content: start; gap: 4px;
`;
const MobileTagPillLabel = styled.span`display: block; translate: 0 -1px;`;
const MobileTagPill = styled.button<{ $selected: boolean }>`
  ${press}; min-height: 38px; max-width: 100%; padding: 5px 10px;
  border: 1px solid ${({ $selected }) => $selected ? 'var(--tag-selected)' : 'var(--line)'}; border-radius: 999px; overflow-wrap: anywhere;
  background: transparent; color: ${({ $selected }) => $selected ? 'var(--tag-selected)' : 'var(--tag-ink)'};
  font-size: 14px; line-height: 20px;
  transition: border-color 140ms ease-out, color 140ms ease-out, scale 150ms ease-out;
`;
const MobileTagControls = styled.div`
  margin-top: 10px;
  button, a { width: 36px; height: 36px; }
`;
const SoundMenu = styled.div`display: grid; gap: 8px; padding: 4px; button { justify-content: center; } input { width: 100%; min-height: 40px; accent-color: var(--link); }`;
const ShortcutPanel = styled.div`
  padding: 4px 12px 8px;
`;
const ShortcutRows = styled.div`
  display: grid; grid-template-columns: minmax(0, 1fr) max-content; column-gap: 20px; row-gap: 2px;
`;
const ShortcutRow = styled.div`
  display: contents;
  > * { min-height: 34px; padding: 8px 0; box-sizing: border-box; }
`;
const Keys = styled.span`color: var(--muted); font-size: 12px; text-align: left; text-transform: lowercase; white-space: nowrap;`;
const Demo = styled.span`
  min-width: 0; line-height: 1.35; font-size: 13px; color: var(--ink); text-align: left;
  strong { font-weight: 700; } em { font-style: italic; } u { text-underline-offset: 2px; }
  a { color: var(--link); text-decoration: none; }
  code { padding: 0; border-radius: 0; background: transparent; color: var(--code-ink); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
`;
const Main = styled.main`
  width: var(--document-width); margin: var(--page-top) var(--right-margin) 0 var(--left-margin);
  flex: 1; display: flex; flex-direction: column; min-height: 0;
  @media ${compactViewport} { max-width: 100%; overflow: hidden; }
`;
const LogFrame = styled.div`
  position: relative; flex: 1; min-height: min(240px, max(64px, calc(100dvh - 160px))); display: flex;
  @media ${compactViewport} { min-height: 0; padding: 0 0 max(12px, env(safe-area-inset-bottom)); overflow-x: clip; }
`;
const LogViewport = styled.div`
  flex: 1; min-height: min(240px, max(64px, calc(100dvh - 160px))); overflow-y: auto; overflow-x: hidden; overscroll-behavior-y: contain;
  padding: 30px 12px 24px 8px; scrollbar-width: thin; scrollbar-color: var(--scrollbar) transparent;
  @media ${compactViewport} {
    min-height: 0; padding: 24px 2px 10px 0; scrollbar-width: none;
    &::-webkit-scrollbar { display: none; }
  }
`;
const LogEdgeWash = styled.div`
  position: absolute; z-index: 7; top: -2px; left: -24px; right: -24px; height: 30px; pointer-events: none;
  opacity: 1;
  background: linear-gradient(to bottom, var(--current-page-paper) 0%, color-mix(in srgb, var(--current-page-paper) 72%, transparent) 34%, transparent 82%);
  &::after {
    content: ''; position: absolute; inset: 0;
    background-image:
      radial-gradient(ellipse 22% 105% at 7% -8%, var(--current-page-paper) 0 48%, transparent 82%),
      radial-gradient(ellipse 30% 92% at 31% -10%, var(--current-page-paper) 0 44%, transparent 80%),
      radial-gradient(ellipse 24% 112% at 56% -18%, var(--current-page-paper) 0 50%, transparent 84%),
      radial-gradient(ellipse 32% 96% at 82% -9%, var(--current-page-paper) 0 42%, transparent 79%),
      radial-gradient(ellipse 18% 108% at 101% -16%, var(--current-page-paper) 0 49%, transparent 83%);
    mask-image: linear-gradient(to bottom, #000 0%, #000d 40%, transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, #000 0%, #000d 40%, transparent 100%);
    opacity: .88;
  }
  @media ${compactViewport} { height: 24px; }
`;
const Toast = styled.div`position: fixed; bottom: max(25px, calc(env(safe-area-inset-bottom) + 12px)); left: 50%; transform: translateX(-50%); z-index: 30; max-width: min(540px, calc(100% - 32px)); display: flex; align-items: center; gap: 12px; padding: 7px 8px 7px 19px; background: var(--surface); border-radius: 12px; box-shadow: 0 0 0 1px #00000007, 0 4px 24px #31392b19; font-size: 12px;`;
const QuietStatus = styled.div`
  position: fixed; right: 24px; bottom: 18px; z-index: 20; pointer-events: none;
  color: var(--muted); font-size: 11px; opacity: 0; transform: translateY(2px);
  transition: opacity 140ms ease-out, transform 140ms ease-out;
  &[data-show='true'] { opacity: .82; transform: translateY(0); }
`;
const ConnectionState = styled.div`padding: 50px 0; display: grid; gap: 16px; justify-items: start; @media ${shortViewport} { display: none; }`;

export default function App({ locked = false, load = !locked, onReady, onLoadError }: {
  locked?: boolean; load?: boolean; onReady?: () => void; onLoadError?: () => void;
}) {
  const [data, setData] = useState<JournalData | null>(null);
  const [night, setNight] = useState(() => localStorage.getItem('still-theme') === 'night');
  useEffect(() => {
    document.documentElement.dataset.theme = night ? 'night' : 'day';
    localStorage.setItem('still-theme', night ? 'night' : 'day');
  }, [night]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const tagRef = useRef<string | null>(null);
  const [completed, setCompleted] = useState(new Set<number>());
  const [reopened, setReopened] = useState(new Set<number>());
  const [undoTask, setUndoTask] = useState<{ id: number; completedAt: string } | null>(null);
  const [target, setTarget] = useState<{ kind: 'notes' | 'tasks'; id: number } | null>(null);
  const completionTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reopenTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onComplete = (ids: number[], taskId?: number, completedAt?: string) => {
    if (completionTimeout.current) clearTimeout(completionTimeout.current);
    setCompleted(new Set(ids));
    if (taskId && completedAt) { recordCompletion(taskId, completedAt); setUndoTask({ id: taskId, completedAt }); }
    completionTimeout.current = setTimeout(() => setCompleted(new Set()), 1000);
  };
  const onReopen = (ids: number[]) => {
    if (reopenTimeout.current) clearTimeout(reopenTimeout.current);
    setReopened(new Set(ids));
    reopenTimeout.current = setTimeout(() => setReopened(new Set()), 1000);
  };
  useEffect(() => () => {
    if (completionTimeout.current) clearTimeout(completionTimeout.current);
    if (reopenTimeout.current) clearTimeout(reopenTimeout.current);
  }, []);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(Date.now());
  const [statsOpen, setStatsOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paged, setPaged] = useState(() => window.matchMedia(compactViewport).matches);
  const viewportWidth = useRef(window.innerWidth);
  const [mobileView, setMobileView] = useState<MobileView>('log');
  const mobileViewRef = useRef<MobileView>('log');
  const mobilePager = useRef<HTMLDivElement>(null);
  const mobileScrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quietStatus = useRef<HTMLDivElement>(null);
  const quietStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sessionsDate, setSessionsDate] = useState<string | null>(null);
  const [timerBusy, setTimerBusy] = useState(false);
  const [timerPulse, setTimerPulse] = useState(false);
  const [audible, setAudible] = useState(false);
  const [volume, setVolume] = useState(() => Math.max(0, Math.min(1, Number(localStorage.getItem('still-volume') ?? '0.22') || 0)));
  const sound = useRef(new FocusSound());
  const timerLock = useRef(false);
  const clockOffset = useRef(0);
  const generation = useRef(0);
  const loadedThrough = useRef<string | null>(null);
  const logViewport = useRef<HTMLDivElement>(null);
  const notify = useCallback((text: string) => setMessage(text), []);
  const commitMobileView = useCallback((next: MobileView) => {
    mobileViewRef.current = next;
    setMobileView(previous => previous === next ? previous : next);
  }, []);
  const selectMobileView = useCallback((next: MobileView) => {
    commitMobileView(next);
    const pager = mobilePager.current;
    if (!pager) return;
    pager.scrollTo({
      left: mobileViewIndex(next) * pager.clientWidth,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, [commitMobileView]);
  const trackMobileScroll = useCallback((pager: HTMLDivElement) => {
    if (mobileScrollTimer.current) clearTimeout(mobileScrollTimer.current);
    mobileScrollTimer.current = setTimeout(() => {
      const index = Math.max(0, Math.min(MOBILE_VIEWS.length - 1, Math.round(pager.scrollLeft / pager.clientWidth)));
      commitMobileView(MOBILE_VIEWS[index]);
    }, 80);
  }, [commitMobileView]);
  useEffect(() => {
    const media = window.matchMedia(compactViewport);
    const coarse = window.matchMedia('(pointer: coarse)');
    const resize = () => {
      const widthChanged = Math.abs(window.innerWidth - viewportWidth.current) > 80;
      viewportWidth.current = window.innerWidth;
      const active = document.activeElement;
      const editing = active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea'));
      setPaged(previous => coarse.matches && editing && !widthChanged && media.matches !== previous ? previous : media.matches);
    };
    media.addEventListener('change', resize);
    window.addEventListener('resize', resize);
    return () => { media.removeEventListener('change', resize); window.removeEventListener('resize', resize); };
  }, []);
  useLayoutEffect(() => {
    if (!paged) return;
    const align = () => {
      const pager = mobilePager.current;
      if (pager) pager.scrollLeft = mobileViewIndex(mobileViewRef.current) * pager.clientWidth;
    };
    align();
    window.addEventListener('resize', align);
    return () => window.removeEventListener('resize', align);
  }, [paged]);
  useEffect(() => () => {
    if (mobileScrollTimer.current) clearTimeout(mobileScrollTimer.current);
  }, []);
  useEffect(() => {
    if (locked) return;
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey) {
        if (['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); void documentUndo(event.shiftKey || event.key.toLowerCase() === 'y').catch(e => notify(errorMessage(e))); }
        if (event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); }
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [locked]);
  useEffect(() => {
    const saveState = (event: Event) => {
      const value = (event as CustomEvent<string>).detail;
      const status = quietStatus.current;
      if (!status) return;
      if (quietStatusTimer.current) clearTimeout(quietStatusTimer.current);
      if (value === 'clear') { status.dataset.show = 'false'; return; }
      status.textContent = value === 'saving' ? 'saving…' : 'saved'; status.dataset.show = 'true';
      if (value === 'saved') quietStatusTimer.current = setTimeout(() => { status.dataset.show = 'false'; }, 900);
    };
    window.addEventListener('still-save-state', saveState);
    return () => {
      window.removeEventListener('still-save-state', saveState);
      if (quietStatusTimer.current) clearTimeout(quietStatusTimer.current);
    };
  }, []);
  const refresh = useCallback(async (includeHistory = true) => {
    const sequence = ++generation.current;
    const tagQuery = tagRef.current ? '&tag=' + encodeURIComponent(tagRef.current) : '';
    let response = await api<JournalData>(`/journal?limit=${JOURNAL_PAGE_SIZE}${tagQuery}`);
    try {
      if (await recoverEarlierDrafts(response.today)) response = await api<JournalData>(`/journal?limit=${JOURNAL_PAGE_SIZE}${tagQuery}`);
    } catch { notify('Could not save an earlier draft. Retrying automatically.'); }
    while (includeHistory && loadedThrough.current && response.next_cursor && response.next_cursor > loadedThrough.current) {
      const more = await api<JournalData>(`/journal?before=${response.next_cursor}&limit=${JOURNAL_PAGE_SIZE}${tagQuery}`);
      response.days.push(...more.days);
      response.next_cursor = more.next_cursor;
    }
    if (sequence !== generation.current) return;
    if (tagRef.current && !response.tags?.some(tag => tag.name === tagRef.current)) {
      tagRef.current = null; loadedThrough.current = null; setActiveTag(null); return;
    }
    clockOffset.current = new Date(response.server_time).getTime() - Date.now();
    setData(previous => {
      if (includeHistory || !previous || previous.tag !== response.tag) return response;
      const oldest = response.days.at(-1)?.date ?? response.today;
      const cachedDays = previous.days.filter(day => day.date < oldest);
      return { ...response, days: [...response.days, ...cachedDays], next_cursor: cachedDays.length ? previous.next_cursor : response.next_cursor };
    });
    setError('');
  }, [notify]);
  useEffect(() => {
    const applied = () => { void refresh().catch(e => notify(errorMessage(e))); };
    const failed = (event: Event) => notify((event as CustomEvent<string>).detail);
    const edited = () => setUndoTask(null);
    window.addEventListener('still-history-applied', applied);
    window.addEventListener('still-history-error', failed);
    window.addEventListener('still-history-available', edited);
    return () => { window.removeEventListener('still-history-applied', applied); window.removeEventListener('still-history-error', failed); window.removeEventListener('still-history-available', edited); };
  }, [refresh, notify]);

  useEffect(() => {
    if (!load) { setData(null); return; }
    void refresh(false).catch(e => { setError(errorMessage(e)); onLoadError?.(); });
  }, [refresh, activeTag, load, onLoadError]);
  useEffect(() => {
    if (locked || !load) return;
    const interval = setInterval(() => { void refresh(false).catch(e => setError(errorMessage(e))); }, 15000);
    const focus = () => { void refresh(false).catch(e => setError(errorMessage(e))); };
    window.addEventListener('focus', focus);
    return () => { clearInterval(interval); window.removeEventListener('focus', focus); };
  }, [refresh, locked, load]);
  useEffect(() => { if (data && load) onReady?.(); }, [data, load, onReady]);
  useEffect(() => {
    if (!data?.active_session) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [data?.active_session?.id]);
  useEffect(() => {
    if (locked) return;
    let day = localDate();
    const interval = setInterval(() => {
      const next = localDate();
      if (next !== day) { day = next; setNow(Date.now()); void refresh(false).catch(e => setError(errorMessage(e))); }
    }, 1000);
    return () => clearInterval(interval);
  }, [refresh, locked]);
  useEffect(() => { if (!message) return; const id = setTimeout(() => setMessage(''), 6500); return () => clearTimeout(id); }, [message]);
  useEffect(() => {
    if (!data?.active_session) { sound.current.stop(); setAudible(false); }
  }, [data?.active_session?.id]);
  useEffect(() => { const currentSound = sound.current; return () => currentSound.dispose(); }, []);

  const active = data?.active_session;
  useEffect(() => {
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.appendChild(icon); }
    const paper = night ? '#011627' : '#d9dcdd';
    const ink = active ? (night ? '#75d1c4' : '#48675e') : (night ? '#8ca0b0' : '#777b7e');
    const inner = active ? `<circle cx="16" cy="16" r="5" fill="${ink}"/>` : '';
    icon.href = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${paper}"/><circle cx="16" cy="16" r="10" fill="none" stroke="${ink}" stroke-width="2"/>${inner}</svg>`)}`;
  }, [active, night]);
  const adjustedNow = now + clockOffset.current;
  const elapsed = active ? Math.max(0, (adjustedNow - new Date(active.started_at).getTime()) / 1000) : 0;
  const toggleTimer = async () => {
    if (timerLock.current) return;
    timerLock.current = true; setTimerBusy(true);
    try {
      if (active) {
        await api<Session>('/timer/stop', 'POST', { session_id: active.id });
        sound.current.stop(); setAudible(false);
        setData(current => current ? { ...current, active_session: null } : current);
      } else {
        if (localStorage.getItem('still-muted') !== 'true') void sound.current.start(volume).then(() => setAudible(true)).catch(() => notify('Audio paused. Open the timer’s sound menu to resume.'));
        const started = await api<Session>('/timer/start', 'POST');
        setData(current => current ? { ...current, active_session: started } : current);
      }
      setTimerPulse(false);
      if (!active) {
        requestAnimationFrame(() => setTimerPulse(true));
        setTimeout(() => setTimerPulse(false), 400);
      }
      await refresh();
    } catch (e) { if (!active) { sound.current.stop(); setAudible(false); } notify(errorMessage(e)); }
    finally { timerLock.current = false; setTimerBusy(false); }
  };
  const toggleSound = async () => {
    if (audible) { sound.current.stop(); setAudible(false); localStorage.setItem('still-muted', 'true'); }
    else { try { await sound.current.start(volume); setAudible(true); localStorage.setItem('still-muted', 'false'); } catch { notify('Your browser couldn’t start audio. The timer is still tracking your focus.'); } }
  };
  const secondsForDay = (day: Day) => {
    if (!active || !data || day.date !== data.today) return day.focused_seconds;
    return day.focused_seconds + Math.max(0, (adjustedNow - new Date(data.server_time).getTime()) / 1000);
  };

  const selectTag = async (tag: string | null) => {
    try {
      await flushDrafts();
      tagRef.current = tag; loadedThrough.current = null; generation.current++;
      setActiveTag(tag);
      if (logViewport.current) logViewport.current.scrollTop = 0;
    } catch (error) { notify(errorMessage(error)); }
  };

  const loadMore = useCallback(async () => {
    const cursor = data?.next_cursor;
    if (!cursor) return;
    const filter = tagRef.current;
    const more = await api<JournalData>(`/journal?before=${cursor}&limit=${JOURNAL_PAGE_SIZE}${filter ? '&tag=' + encodeURIComponent(filter) : ''}`);
    if (filter !== tagRef.current) return;
    loadedThrough.current = more.days.at(-1)?.date ?? loadedThrough.current;
    setData(current => current ? { ...current, days: [...current.days, ...more.days.filter(day => !current.days.some(existing => existing.date === day.date))], next_cursor: more.next_cursor } : current);
  }, [data?.next_cursor]);

  const jumpTo = async (hit: SearchHit) => {
    try {
      await flushDrafts();
      tagRef.current = null; loadedThrough.current = null; setActiveTag(null); setTarget(null);
      await refresh();
      if (hit.date) {
        const result = await api<JournalData>(`/journal?on=${hit.date}`);
        setData(current => current ? { ...current, days: [...current.days.filter(day => day.date !== hit.date), ...result.days].sort((a, b) => b.date.localeCompare(a.date)) } : current);
      }
      setSearchOpen(false);
      setTimeout(() => setTarget({ kind: hit.kind, id: hit.id }), 180);
    } catch (e) { notify(errorMessage(e)); }
  };

  const sidebarControls = <SidebarControls role="group" aria-label="Page controls" data-focus-chrome>
    {REPOSITORY_URL && <RepositoryLink href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label="GitHub repository" title="GitHub"><Github size={15} aria-hidden="true" /></RepositoryLink>}
    <CalendarToggle aria-label="Manage calendars" title="Calendars" onClick={() => setCalendarOpen(true)}><CalendarDays size={15} aria-hidden="true" /></CalendarToggle>
    <StatsToggle aria-label="Open focus statistics" title="Statistics" onClick={() => setStatsOpen(true)}><ChartNoAxesColumn size={15} aria-hidden="true" /></StatsToggle>
    <ShortcutToggle aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}><ShortcutGlyph data-shortcut-icon aria-hidden="true" /></ShortcutToggle>
    <ThemeToggle role="switch" aria-label="Night mode" aria-checked={night}
      title={night ? 'Use day mode' : 'Use night mode'} onClick={() => setNight(value => !value)}>
      <ThemeGlyph $shown={!night} data-icon="sun" aria-hidden="true"><Sun size={15} /></ThemeGlyph>
      <ThemeGlyph $shown={night} data-icon="moon" aria-hidden="true"><Moon size={15} /></ThemeGlyph>
    </ThemeToggle>
  </SidebarControls>;

  return <JournalContext.Provider value={{ tags: data?.tags ?? [], activeTag: data?.tag ?? null, completed, onComplete, reopened, onReopen, target }}><Page $focusing={!!active} data-testid="page" data-focus-running={active ? 'true' : undefined}>
    <TimerChrome>
      <TimerTime data-testid="compact-timer-time" aria-hidden="true">{timerDuration(elapsed)}</TimerTime>
      <TimerButton $pulse={timerPulse} $running={!!active} type="button" disabled={timerBusy || !data}
        aria-label={active ? 'Stop focus timer' : 'Start focus timer'} aria-pressed={!!active}
        title="Click to start/stop · right-click for sound"
        onContextMenu={event => { event.preventDefault(); setSoundOpen(true); }}
        onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); setSoundOpen(true); } }}
        onClick={() => void toggleTimer()}><TimerIcon size={16} aria-hidden="true" /></TimerButton>
    </TimerChrome>
    {!paged && <TagTabs tags={data?.tags ?? []} active={activeTag} onSelect={tag => { void selectTag(tag); }} controls={sidebarControls} />}
    <Main data-focus-surface>
      {paged ? <>
        <ShortHeader>
          <MobileTabs role="tablist" aria-label="Mobile views">
            <MobileTab id="mobile-tab-todos" type="button" role="tab" aria-controls="mobile-panel-todos" aria-selected={mobileView === 'todos'} $active={mobileView === 'todos'} onClick={() => selectMobileView('todos')}>to do</MobileTab>
            <MobileTab id="mobile-tab-log" type="button" role="tab" aria-controls="mobile-panel-log" aria-selected={mobileView === 'log'} $active={mobileView === 'log'} onClick={() => selectMobileView('log')}>log</MobileTab>
            <MobileTab id="mobile-tab-tags" type="button" role="tab" aria-controls="mobile-panel-tags" aria-selected={mobileView === 'tags'} $active={mobileView === 'tags'} onClick={() => selectMobileView('tags')}>tags</MobileTab>
          </MobileTabs>
        </ShortHeader>
        <MobilePager ref={mobilePager} data-testid="mobile-pager" onScroll={event => trackMobileScroll(event.currentTarget)}>
          <MobilePane id="mobile-panel-todos" role="tabpanel" aria-labelledby="mobile-tab-todos" aria-hidden={mobileView !== 'todos'} inert={mobileView !== 'todos'}>{data ? <Todos key={data.tag ?? 'all'} tasks={data.tasks} refresh={refresh} notify={notify} /> : null}</MobilePane>
          <MobilePane id="mobile-panel-log" role="tabpanel" aria-labelledby="mobile-tab-log" aria-hidden={mobileView !== 'log'} inert={mobileView !== 'log'}>{data && <LogFrame><LogViewport ref={logViewport} data-testid="log-scroll">
            <Journal key={data.tag ?? 'all'} scrollRoot={logViewport} days={data.days} today={data.today} refresh={refresh} notify={notify} openSessions={setSessionsDate}
              sessionsEnabled={false} showHistory secondsForDay={secondsForDay} hasMore={!!data.next_cursor} loadMore={loadMore} />
          </LogViewport><LogEdgeWash data-testid="log-top-ink-wash" aria-hidden="true" /></LogFrame>}</MobilePane>
          <MobilePane id="mobile-panel-tags" role="tabpanel" aria-labelledby="mobile-tab-tags" aria-hidden={mobileView !== 'tags'} inert={mobileView !== 'tags'}>
            <MobileTags>
              <MobileTagCollection aria-label="Filter by tag">
                <MobileTagPill type="button" $selected={activeTag === null} aria-pressed={activeTag === null} onClick={() => void selectTag(null)}><MobileTagPillLabel>all</MobileTagPillLabel></MobileTagPill>
                {(data?.tags ?? []).map(tag => <MobileTagPill key={tag.name} type="button" $selected={activeTag === tag.name}
                  aria-pressed={activeTag === tag.name} onClick={() => void selectTag(tag.name)}><MobileTagPillLabel>#{tag.name}</MobileTagPillLabel></MobileTagPill>)}
              </MobileTagCollection>
              <MobileTagControls>{sidebarControls}</MobileTagControls>
            </MobileTags>
          </MobilePane>
        </MobilePager>
      </> : <>
        {!data ? <ConnectionState><Muted>{error || 'Loading…'}</Muted>{error && <Button onClick={() => { setError(''); void refresh().catch(e => setError(errorMessage(e))); }}>Retry</Button>}</ConnectionState> :
          <Todos key={data.tag ?? 'all'} tasks={data.tasks} refresh={refresh} notify={notify} />}
      {data &&
        <LogFrame><LogViewport ref={logViewport} data-testid="log-scroll">
        <Journal key={data.tag ?? 'all'} scrollRoot={logViewport} days={data.days} today={data.today} refresh={refresh} notify={notify} openSessions={setSessionsDate} secondsForDay={secondsForDay} hasMore={!!data.next_cursor} loadMore={loadMore} />
        {error && <TextButton onClick={() => void refresh().catch(e => notify(errorMessage(e)))}>Connection lost · retry</TextButton>}
        </LogViewport><LogEdgeWash data-testid="log-top-ink-wash" aria-hidden="true" /></LogFrame>
      }
      </>}
    </Main>
    <Suspense fallback={null}>
      {sessionsDate && <SessionsModal date={sessionsDate} onClose={() => setSessionsDate(null)} onChange={refresh} />}
      {statsOpen && <StatsModal open onClose={() => setStatsOpen(false)} />}
      {searchOpen && <SearchModal open onClose={() => setSearchOpen(false)} onSelect={jumpTo} />}
      {calendarOpen && <CalendarModal open onClose={() => setCalendarOpen(false)} onChange={refresh} />}
    </Suspense>
    <Modal open={soundOpen} onClose={() => setSoundOpen(false)} title="Focus sound" compact><SoundMenu>
      <TextButton aria-label={audible ? 'Mute focus sound' : 'Play focus sound'} onClick={() => void toggleSound()}>{audible ? 'Mute' : 'Play sound'}</TextButton>
      <input aria-label="Focus sound volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={e => { const value = Number(e.target.value); setVolume(value); localStorage.setItem('still-volume', String(value)); sound.current.setVolume(value); }} />
    </SoundMenu></Modal>
    <Modal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} title="Keyboard shortcuts" compact><ShortcutPanel>
      <ShortcutRows data-testid="shortcut-rows">
        <ShortcutRow><Demo>create the next entry</Demo><Keys>enter</Keys></ShortcutRow>
        <ShortcutRow><Demo>add a line break</Demo><Keys>shift + enter</Keys></ShortcutRow>
        <ShortcutRow><Demo>indent entry</Demo><Keys>tab</Keys></ShortcutRow>
        <ShortcutRow><Demo>outdent entry</Demo><Keys>shift + tab</Keys></ShortcutRow>
        <ShortcutRow><Demo>select all entries</Demo><Keys>⌘ + a twice</Keys></ShortcutRow>
        <ShortcutRow><Demo>make this <strong>bold</strong></Demo><Keys>⌘ + b</Keys></ShortcutRow>
        <ShortcutRow><Demo>make this <em>italic</em></Demo><Keys>⌘ + i</Keys></ShortcutRow>
        <ShortcutRow><Demo>make this <u>underlined</u></Demo><Keys>⌘ + u</Keys></ShortcutRow>
        <ShortcutRow><Demo>add or edit a <a href="#" onClick={event => event.preventDefault()}>link</a></Demo><Keys>⌘ + k</Keys></ShortcutRow>
        <ShortcutRow><Demo>turn text into <code>code</code></Demo><Keys>⌘ + shift + c</Keys></ShortcutRow>
        <ShortcutRow><Demo>search</Demo><Keys>⌘ + f</Keys></ShortcutRow>
        <ShortcutRow><Demo>undo</Demo><Keys>⌘ + z</Keys></ShortcutRow>
        <ShortcutRow><Demo>redo</Demo><Keys>⌘ + shift + z</Keys></ShortcutRow>
      </ShortcutRows>
    </ShortcutPanel></Modal>
    {undoTask && !message && <Toast><TextButton aria-label="Undo task completion" onClick={async () => {
      try { await documentUndo(); setUndoTask(null); }
      catch (e) { notify(errorMessage(e)); }
    }}>Undo</TextButton><TextButton aria-label="Dismiss undo" onClick={() => setUndoTask(null)}>×</TextButton></Toast>}
    {message && <Toast role="status">{message}<TextButton aria-label="Dismiss notification" onClick={() => setMessage('')}>Dismiss</TextButton></Toast>}
    <QuietStatus ref={quietStatus} role="status" aria-live="polite" data-show="false" />
  </Page></JournalContext.Provider>;
}
