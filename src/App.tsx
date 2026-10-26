import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styled, { css } from 'styled-components';
import { CalendarDays, ChartNoAxesColumn, Github, Moon, Sun, Timer as TimerIcon } from 'lucide-react';
import { cacheJournal, cachedJournal, getJournal, isAbortError, localDate, startTimer, stopTimer, timerDuration } from './api';
import { recoverEarlierDrafts } from './entryDrafts';
import { storage } from './storage';
import { FocusSound } from './audio';
import type { JournalData, JournalDay } from './types';
import { Muted, TextButton, edgeWash, press } from './styles';
import { Journal, Tasks } from './components/Journal';
import { TagTabs } from './components/TagTabs';
import { JournalContext, flushDrafts } from './JournalContext';
import { Modal } from './components/Modal';
import type { SearchHit } from './components/SearchModal';
import { documentUndo, historyShortcutDirection, recordCompletion } from './documentHistory';
import { compactViewport, narrowViewport, shortViewport } from './layout';
import { usePager } from './usePager';
import { useEntryGestures } from './useEntryGestures';
import { entryError } from './entryFeedback';

const JOURNAL_PAGE_SIZE = 14;
type View = 'tasks' | 'log' | 'tags';
// Space decides what gets a tab of its own: the sidebar when there is no room
// beside the log, the log when there is none above it. A phone has neither, so
// it tabs both. The task list asking for more than this much of the height
// counts as no room above, and gives it back a little lower so it cannot flap.
// The pane last read is the one the logbook opens on.
const PANE_KEY = 'still-pane';
const rememberedPane = (): View => {
  const stored = storage.getItem(PANE_KEY);
  return stored === 'tasks' || stored === 'log' || stored === 'tags' ? stored : 'log';
};
const TASKS_CROWD_HEIGHT = 0.2;
const TASKS_SETTLE_HEIGHT = 0.17;
const REPOSITORY_URL = import.meta.env.VITE_REPOSITORY_URL || 'https://github.com/divyavenn/still';
const SessionsModal = lazy(() => import('./components/SessionsModal').then(module => ({ default: module.SessionsModal })));
const StatsModal = lazy(() => import('./components/StatsModal').then(module => ({ default: module.StatsModal })));
const SearchModal = lazy(() => import('./components/SearchModal').then(module => ({ default: module.SearchModal })));
const CalendarModal = lazy(() => import('./components/CalendarModal').then(module => ({ default: module.CalendarModal })));

const Page = styled.div<{ $focusing: boolean }>`
  --current-page-paper: ${({ $focusing }) => $focusing ? 'var(--page-focus-paper)' : 'var(--page-paper)'};
  --edge-paper: var(--paper);
  --document-width: min(680px, calc(100vw - 64px));
  --left-margin: calc((100vw - var(--document-width)) * .54);
  --right-margin: calc(100vw - var(--document-width) - var(--left-margin));
  --page-top: 48px;
  --task-heading-height: 44px;
  @media(pointer: coarse) { --task-heading-height: 48px; }
  height: 100dvh; overflow-x: hidden; overflow-y: auto; display: flex; flex-direction: column;
  background-color: var(--current-page-paper);
  [data-focus-chrome] { opacity: ${({ $focusing }) => $focusing ? 'var(--focus-chrome-opacity)' : 'var(--chrome-opacity)'}; transition: opacity 180ms ease-out; }
  ${({ $focusing }) => $focusing && css`
    & [data-focus-surface] {
      --edge-paper: color-mix(in srgb, var(--paper), #000 20%);
    }
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
      --edge-paper: var(--paper);
    }
  `}
  @media ${compactViewport} {
    --document-width: min(680px, calc(100vw - max(24px, env(safe-area-inset-left)) - max(16px, env(safe-area-inset-right))));
    --page-top: max(16px, env(safe-area-inset-top)); --task-heading-height: 36px;
    --left-margin: max(24px, env(safe-area-inset-left), calc((100vw - var(--document-width)) * .54));
    --right-margin: calc(100vw - var(--document-width) - var(--left-margin));
    scrollbar-width: none;
    &::-webkit-scrollbar { display: none; }
  }
  /* Browser zoom can make a desktop viewport match the compact breakpoint.
     Keep enough physical-feeling gutter for the hover sidebar on devices that
     still have a precise pointer; touch layouts retain their tighter margins. */
  @media (hover: hover) and (pointer: fine) {
    --document-width: min(680px, calc(100vw - 64px));
    --left-margin: max(48px, calc((100vw - var(--document-width)) * .54));
    --right-margin: calc(100vw - var(--document-width) - var(--left-margin));
  }
  @media (pointer: coarse) {
    height: 100lvh;
    overflow-y: hidden;
  }
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
const TimerButton = styled.button<{ $running: boolean }>`
  ${press}; position: relative; width: 44px; height: 44px; display: grid; place-items: center; flex-shrink: 0;
  padding: 0; border: 0; border-radius: 50%; background: var(--timer); color: var(--timer-ink);
  &::before { content: ''; position: absolute; inset: -3px; border: 1px solid var(--timer-ring); border-radius: 50%; pointer-events: none; transition: border-color 160ms ease-out; }
  &::after { content: ''; position: absolute; inset: -3px; border: 1px solid var(--timer-running-ring); border-radius: 50%; pointer-events: none;
    opacity: ${({ $running }) => $running ? .3 : 0}; transform: scale(${({ $running }) => $running ? 1.14 : 1});
    transition: opacity 240ms ease-out, transform 240ms ease-out; }
  &:hover { background: var(--timer-hover); }
  &[aria-pressed='true'] { background: var(--timer-running); scale: 1.03; }
  &[aria-pressed='true']:hover { background: var(--timer-running-hover); }
  &[aria-pressed='true']::before { border-color: var(--timer-running-ring); }
`;
// The strip above the panes is the plainest place a page turn comes from: it
// is the part of the page that is not entries, and the entries keep the
// up-and-down of their own list. It is deep enough to be found with a thumb,
// and the room it leaves is the top margin of every pane.
const ShortHeader = styled.div`
  height: 68px; flex-shrink: 0; touch-action: pan-x;
`;
const MobileTabs = styled.div<{ $aside: boolean }>`
  /* Centred along the top while the sidebar keeps its own side. Once the tags
     have taken a tab there is no sidebar, so the dots take its place. */
  position: fixed; top: max(12px, env(safe-area-inset-top)); z-index: 43;
  ${({ $aside }) => $aside ? 'left: 12px;' : 'left: 50%; translate: -50% 0;'}
  height: 44px; display: flex; align-items: center;
`;
const MobileTab = styled.button<{ $active: boolean }>`
  /* The dots sit 12px apart whatever their number, so the width is the gap
     itself; the full height keeps each one easy enough to hit. */
  position: relative; width: 12px; height: 44px; padding: 0; border: 0; background: transparent;
  color: ${({ $active }) => $active ? 'var(--link)' : 'var(--muted)'};
  font-size: 0;
  &::before { content: ''; position: absolute; left: 50%; top: 50%; width: 6px; height: 6px;
    border-radius: 50%; background: currentColor; opacity: ${({ $active }) => $active ? 1 : .48}; translate: -50% -50%;
    transition: color 120ms ease-out, opacity 120ms ease-out; }
`;
const MobilePager = styled.div`
  display: flex; flex: 1; min-width: 0; min-height: 0; width: 100%; max-width: 100%; overflow-x: auto; overflow-y: hidden;
  scroll-snap-type: x mandatory; overscroll-behavior-x: none; scrollbar-width: none; -webkit-overflow-scrolling: touch;
  &[data-dragging='true'] { scroll-snap-type: none; scroll-behavior: auto; }
  &::-webkit-scrollbar { display: none; }
`;
const MobilePane = styled.section`
  flex: 0 0 100%; width: 100%; max-width: 100%; min-width: 0; min-height: 0; overflow-x: clip; overflow-y: auto;
  display: flex; flex-direction: column; scrollbar-width: none;
  /* Across is the page turning, down is the pane scrolling, and the turn is
     carried by the drag the pane reads rather than by the browser, so a drag
     that starts anywhere on a pane turns the page the same way. */
  touch-action: pan-y;
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
// The log fades its content out over this much at each edge, and its first
// date rests just clear of it.
const LOG_WASH_HEIGHT = 30;
const LogFrame = styled.div`
  position: relative; flex: 1; min-height: min(240px, max(64px, calc(100dvh - 160px))); display: flex;
  @media ${compactViewport} { min-height: 0; padding: 0 0 max(12px, env(safe-area-inset-bottom)); overflow-x: clip; }
`;
const LogViewport = styled.div`
  flex: 1; min-height: min(240px, max(64px, calc(100dvh - 160px))); overflow-y: auto; overflow-x: hidden; overscroll-behavior-y: contain;
  padding: 30px 12px 24px 8px; scrollbar-width: thin; scrollbar-color: var(--scrollbar) transparent;
  @media ${compactViewport} {
    min-height: 0; padding: 24px 2px 10px 0; scrollbar-width: none;
    /* A touch that starts on the entries scrolls them and never turns the
       page, so neither gesture has to be guessed at. */
    touch-action: pan-y;
    &::-webkit-scrollbar { display: none; }
  }
`;
const LogEdgeWash = styled.div<{ $edge?: 'top' | 'bottom' }>`
  ${({ $edge = 'top' }) => edgeWash($edge)};
  /* Bleeding past the left keeps the fade clear of the frame's edge; on the
     right it stops short of the scrollbar column so the bar's ends are never
     washed over. Compact hides the bar, so there it bleeds both ways. */
  left: -24px; right: 12px;
  @media ${compactViewport} { right: -24px; height: 24px; }
`;
const ConnectionState = styled.div`padding: 50px 0; display: grid; gap: 16px; justify-items: start; @media ${shortViewport} { display: none; }`;

export default function App({ locked = false, load = !locked, onReady, onLoadError }: {
  locked?: boolean; load?: boolean; onReady?: () => void; onLoadError?: () => void;
}) {
  // Paint the page we last saw on the first render, before anything is asked
  // of the network. A refresh replaces it as soon as one answers.
  const [data, setData] = useState<JournalData | null>(() => load ? cachedJournal(null) : null);
  const [night, setNight] = useState(() => storage.getItem('still-theme') === 'night');
  useEffect(() => {
    document.documentElement.dataset.theme = night ? 'night' : 'day';
    storage.setItem('still-theme', night ? 'night' : 'day');
  }, [night]);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  // Only a real view change animates; the first paint is not a switch.
  const [switchedView, setSwitchedView] = useState(false);
  const tagRef = useRef<string | null>(null);
  const [completed, setCompleted] = useState(new Set<number>());
  const [reopened, setReopened] = useState(new Set<number>());
  const [target, setTarget] = useState<{ kind: 'notes' | 'tasks'; id: number } | null>(null);
  const completionTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reopenTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onComplete = (ids: number[], taskId?: number, completedAt?: string) => {
    if (completionTimeout.current) clearTimeout(completionTimeout.current);
    setCompleted(new Set(ids));
    if (taskId && completedAt) recordCompletion(taskId, completedAt);
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
  const [now, setNow] = useState(Date.now());
  const [statsOpen, setStatsOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [soundOpen, setSoundOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [cramped, setCramped] = useState(() => ({
    across: window.matchMedia(narrowViewport).matches,
    down: window.matchMedia(shortViewport).matches,
  }));
  // A task list taller than its share of the screen crowds the log out of the
  // page, which is the same problem a short window has.
  const [crowded, setCrowded] = useState(false);
  const short = cramped.down || crowded;
  const views = useMemo<readonly View[]>(() => [
    ...(short ? (['tasks', 'log'] as const) : (['log'] as const)),
    ...(cramped.across ? (['tags'] as const) : []),
  ], [short, cramped.across]);
  const paged = views.length > 1;
  // The small-screen reading of the journal, as against merely tabbed panes.
  const small = cramped.across || cramped.down;
  const [hasHoverSidebar, setHasHoverSidebar] = useState(() => window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  const viewportWidth = useRef(window.innerWidth);
  const { pagerRef: mobilePager, selectView: selectMobileView, trackScroll: trackMobileScroll, view: mobileView } = usePager(views, rememberedPane(), paged);
  // The panes read a drag of their own, so the room between the entries turns
  // the page as readily as the entries do.
  const {
    startEntryGesture: startPageSwipe, trackEntryGesture: trackPageSwipe,
    finishEntryGesture: finishPageSwipe, cancelEntryGesture: cancelPageSwipe,
    consumeClick: consumePageSwipeClick,
  } = useEntryGestures();
  const [sessionsDate, setSessionsDate] = useState<string | null>(null);
  const [timerBusy, setTimerBusy] = useState(false);
  const [timerIntent, setTimerIntent] = useState<'start' | 'stop' | null>(null);
  const [audible, setAudible] = useState(false);
  const [volume, setVolume] = useState(() => Math.max(0, Math.min(1, Number(storage.getItem('still-volume') ?? '0.22') || 0)));
  const sound = useRef(new FocusSound());
  const openedModals = useRef(new Set<string>());
  if (sessionsDate) openedModals.current.add('sessions');
  if (statsOpen) openedModals.current.add('stats');
  if (searchOpen) openedModals.current.add('search');
  if (calendarOpen) openedModals.current.add('calendar');
  const timerLock = useRef(false);
  const clockOffset = useRef(0);
  const generation = useRef(0);
  const refreshRequest = useRef<AbortController | null>(null);
  const refreshResult = useRef<Promise<void> | null>(null);
  const loadedThrough = useRef<string | null>(null);
  const logViewport = useRef<HTMLDivElement>(null);
  // A drag across the band above the entries turns the page by one, as soon as
  // it has gone far enough to mean it, and once per drag. The dots and the
  // timer live in that band and answer taps, so a drag over them turns the
  // page like anywhere else, and the tap it would have been is dropped.
  const strip = useRef<HTMLDivElement>(null);
  const turning = useRef<{ from: number; turned: boolean } | null>(null);
  const turnPage = (at: number) => {
    const start = turning.current;
    if (!start || start.turned || Math.abs(at - start.from) < 32) return;
    start.turned = true;
    const index = views.indexOf(mobileView) + (at < start.from ? 1 : -1);
    if (index >= 0 && index < views.length) selectMobileView(views[index]);
  };
  useEffect(() => {
    const across = window.matchMedia(narrowViewport);
    const down = window.matchMedia(shortViewport);
    const coarse = window.matchMedia('(pointer: coarse)');
    const resize = () => {
      const widthChanged = Math.abs(window.innerWidth - viewportWidth.current) > 80;
      viewportWidth.current = window.innerWidth;
      const active = document.activeElement;
      const editing = active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea'));
      setCramped(previous => {
        // A soft keyboard shrinks the window under an open editor. That is not
        // the page changing shape, so the layout is left as it stands.
        const settled = { across: across.matches, down: down.matches };
        const typing = coarse.matches && editing && !widthChanged;
        if (typing && (settled.across !== previous.across || settled.down !== previous.down)) return previous;
        return settled.across === previous.across && settled.down === previous.down ? previous : settled;
      });
    };
    across.addEventListener('change', resize);
    down.addEventListener('change', resize);
    window.addEventListener('resize', resize);
    return () => {
      across.removeEventListener('change', resize); down.removeEventListener('change', resize);
      window.removeEventListener('resize', resize);
    };
  }, []);
  // How tall the task list wants to be, measured on its own content so the
  // answer does not depend on the room it has been given.
  useEffect(() => {
    const measure = () => {
      const body = document.querySelector<HTMLElement>('[data-task-body]');
      const rows = body?.querySelectorAll<HTMLElement>('li[data-item-id]');
      const last = rows?.[rows.length - 1];
      // Saved rows only. The composer comes and goes with the focus, and a
      // layout that measured it could be flipped by its own answer.
      if (!body || !last) { setCrowded(false); return; }
      const height = last.getBoundingClientRect().bottom - body.getBoundingClientRect().top;
      const share = height / window.innerHeight;
      setCrowded(previous => share > TASKS_CROWD_HEIGHT ? true : share < TASKS_SETTLE_HEIGHT ? false : previous);
    };
    measure();
    const body = document.querySelector('[data-task-body]');
    const observer = new ResizeObserver(measure);
    if (body) observer.observe(body);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [data?.tasks, paged]);
  // A pane can stop existing when the window changes shape.
  useEffect(() => {
    if (paged && !views.includes(mobileView)) selectMobileView('log');
    else if (paged) storage.setItem(PANE_KEY, mobileView);
  }, [paged, views, mobileView, selectMobileView]);
  useEffect(() => {
    const media = window.matchMedia('(hover: hover) and (pointer: fine)');
    const update = () => setHasHoverSidebar(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (locked) return;
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const historyDirection = historyShortcutDirection(event);
      const editing = event.target instanceof Element && !!event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
      if (historyDirection !== null && !editing) {
        event.preventDefault();
        void documentUndo(historyDirection).catch(e => entryError(e));
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'f') { event.preventDefault(); setSearchOpen(true); }
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [locked]);
  const loadJournal = useCallback(async (includeHistory: boolean) => {
    const sequence = ++generation.current;
    refreshRequest.current?.abort();
    const request = new AbortController();
    refreshRequest.current = request;
    const current = () => sequence === generation.current && !request.signal.aborted;
    const tag = tagRef.current;
    let response: JournalData;
    try {
      response = await getJournal({ limit: JOURNAL_PAGE_SIZE, tag }, request.signal);
      if (!current()) return;
      const recovered = await recoverEarlierDrafts(response.today);
      if (!current()) return;
      if (recovered) response = await getJournal({ limit: JOURNAL_PAGE_SIZE, tag }, request.signal);
      // Keep the first page only: it is what the view opens with next time.
      cacheJournal(tag, { ...response, days: [...response.days] });
      while (current() && includeHistory && loadedThrough.current && response.next_cursor && response.next_cursor > loadedThrough.current) {
        const cursor = response.next_cursor;
        const more = await getJournal({ before: cursor, limit: JOURNAL_PAGE_SIZE, tag }, request.signal);
        if (!current()) return;
        response.days.push(...more.days);
        // Stop if a bad cursor would fetch the same page forever.
        response.next_cursor = more.next_cursor && more.next_cursor < cursor ? more.next_cursor : null;
      }
    } catch (error) {
      if (isAbortError(error) || !current()) return;
      throw error;
    }
    if (!current()) return;
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
  }, []);
  const refresh = useCallback(async (includeHistory = true) => {
    let pending = loadJournal(includeHistory);
    refreshResult.current = pending;
    // Keep local edits on screen until the newest refresh has finished.
    // A cancelled request must not tell the save queue that fresh data arrived.
    for (;;) {
      await pending;
      const latest = refreshResult.current;
      if (latest === null || latest === pending) return;
      pending = latest;
    }
  }, [loadJournal]);
  useEffect(() => () => { refreshRequest.current?.abort(); }, []);
  useEffect(() => {
    const applied = () => { void refresh().catch(e => entryError(e)); };
    const failed = (event: Event) => entryError((event as CustomEvent<string>).detail);
    window.addEventListener('still-history-applied', applied);
    window.addEventListener('still-history-error', failed);
    return () => { window.removeEventListener('still-history-applied', applied); window.removeEventListener('still-history-error', failed); };
  }, [refresh]);

  useEffect(() => {
    if (!load) { setData(null); return; }
    // Open on the last page seen for this view, so a reload with no network
    // still shows the logbook. A successful refresh replaces it.
    setData(current => current && current.tag === tagRef.current ? current : cachedJournal(tagRef.current) ?? current);
    void refresh(false).catch(e => { entryError(e); onLoadError?.(); });
  }, [refresh, activeTag, load, onLoadError]);
  useEffect(() => {
    if (locked || !load) return;
    const interval = setInterval(() => { void refresh(false).catch(e => entryError(e)); }, 15000);
    const focus = () => { void refresh(false).catch(e => entryError(e)); };
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
      if (next !== day) { day = next; setNow(Date.now()); void refresh(false).catch(e => entryError(e)); }
    }, 1000);
    return () => clearInterval(interval);
  }, [refresh, locked]);
  useEffect(() => {
    if (!data?.active_session) { sound.current.stop(); setAudible(false); }
  }, [data?.active_session?.id]);
  useEffect(() => { const currentSound = sound.current; return () => currentSound.dispose(); }, []);

  const active = data?.active_session;
  const timerRunning = timerIntent === 'start' || timerIntent === null && !!active;
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
  const visibleElapsed = timerRunning ? elapsed : 0;
  const toggleTimer = async () => {
    if (timerLock.current) return;
    const stopping = !!active;
    timerLock.current = true; setTimerIntent(stopping ? 'stop' : 'start'); setTimerBusy(true);
    try {
      if (active) {
        await stopTimer(active.id);
        sound.current.stop(); setAudible(false);
        setData(current => current ? { ...current, active_session: null } : current);
      } else {
        if (storage.getItem('still-muted') !== 'true') void sound.current.start(volume).then(() => setAudible(true)).catch(() => setAudible(false));
        const started = await startTimer();
        setData(current => current ? { ...current, active_session: started } : current);
      }
      await refresh();
    } catch (e) { if (!active) { sound.current.stop(); setAudible(false); } entryError(e); }
    finally { timerLock.current = false; setTimerIntent(null); setTimerBusy(false); }
  };
  const toggleSound = async () => {
    if (audible) { sound.current.stop(); setAudible(false); storage.setItem('still-muted', 'true'); }
    else { try { await sound.current.start(volume); setAudible(true); storage.setItem('still-muted', 'false'); } catch { setAudible(false); } }
  };
  const secondsForDay = (day: JournalDay) => {
    if (!active || !data || day.date !== data.today) return day.focused_seconds;
    return day.focused_seconds + Math.max(0, (adjustedNow - new Date(data.server_time).getTime()) / 1000);
  };

  const selectTag = async (tag: string | null) => {
    try {
      await flushDrafts();
      tagRef.current = tag; loadedThrough.current = null; generation.current++;
      setSwitchedView(true); setActiveTag(tag);
      if (logViewport.current) logViewport.current.scrollTop = 0;
      // Choosing a tag was a question about the log, so the page turns back to
      // it and the answer arrives there, rising into place.
      if (paged) selectMobileView('log');
    } catch (error) { entryError(error); }
  };

  const loadMore = useCallback(async () => {
    const cursor = data?.next_cursor;
    if (!cursor) return;
    const filter = tagRef.current;
    const more = await getJournal({ before: cursor, limit: JOURNAL_PAGE_SIZE, tag: filter });
    if (filter !== tagRef.current) return;
    loadedThrough.current = more.days.at(-1)?.date ?? loadedThrough.current;
    setData(current => current ? { ...current, days: [...current.days, ...more.days.filter(day => !current.days.some(existing => existing.date === day.date))], next_cursor: more.next_cursor } : current);
  }, [data?.next_cursor]);

  // Leaving the filter is what makes a day editable again, tags included.
  const jumpToDate = async (date: string) => {
    try {
      await flushDrafts();
      tagRef.current = null; loadedThrough.current = null; setActiveTag(null); setTarget(null);
      setSwitchedView(true);
      await refresh();
      const result = await getJournal({ on: date });
      setData(current => current ? { ...current, days: [...current.days.filter(day => day.date !== date), ...result.days].sort((a, b) => b.date.localeCompare(a.date)) } : current);
      // The date itself leads, resting where the first one does: clear of the
      // wash at the top of the log.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const pane = logViewport.current, day = document.querySelector(`[data-day="${date}"]`);
        if (!pane || !day) return;
        pane.scrollTo({
          top: pane.scrollTop + day.getBoundingClientRect().top - pane.getBoundingClientRect().top - LOG_WASH_HEIGHT,
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        });
      }));
    } catch (e) { entryError(e); }
  };

  const jumpTo = async (hit: SearchHit) => {
    try {
      await flushDrafts();
      tagRef.current = null; loadedThrough.current = null; setActiveTag(null); setTarget(null);
      await refresh();
      if (hit.date) {
        const result = await getJournal({ on: hit.date });
        setData(current => current ? { ...current, days: [...current.days.filter(day => day.date !== hit.date), ...result.days].sort((a, b) => b.date.localeCompare(a.date)) } : current);
      }
      setSearchOpen(false);
      setTarget({ kind: hit.kind, id: hit.id });
    } catch (e) { entryError(e); }
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

  // Stacked above the log it takes the room it needs; in a pane of its own it
  // takes the pane.
  const taskBand = (fills: boolean) => data
    ? <Tasks key={data.tag ?? 'all'} tasks={data.tasks} entering={switchedView} fills={fills} refresh={refresh} /> : null;
  const logBand = data ? <LogFrame><LogViewport ref={logViewport} data-testid="log-scroll">
    <Journal key={data.tag ?? 'all'} scrollRoot={logViewport} days={data.days} today={data.today} entering={switchedView}
      refresh={refresh} openSessions={setSessionsDate} openDate={date => void jumpToDate(date)}
      {...(small ? { sessionsEnabled: false, showHistory: true } : {})}
      secondsForDay={secondsForDay} hasMore={!!data.next_cursor} loadMore={loadMore} />
  </LogViewport><LogEdgeWash data-testid="log-top-ink-wash" aria-hidden="true" /><LogEdgeWash $edge="bottom" data-testid="log-bottom-ink-wash" aria-hidden="true" /></LogFrame> : null;
  // The log keeps the task list above it whenever there is room for both.
  const pane = (view: View) => {
    if (view === 'tasks') return taskBand(true);
    if (view === 'tags') return <MobileTags>
      <MobileTagCollection aria-label="Filter by tag">
        <MobileTagPill type="button" $selected={activeTag === null} aria-pressed={activeTag === null} onClick={() => void selectTag(null)}><MobileTagPillLabel>all</MobileTagPillLabel></MobileTagPill>
        {(data?.tags ?? []).map(tag => <MobileTagPill key={tag.name} type="button" $selected={activeTag === tag.name}
          aria-pressed={activeTag === tag.name} onClick={() => void selectTag(tag.name)}><MobileTagPillLabel>#{tag.name}</MobileTagPillLabel></MobileTagPill>)}
      </MobileTagCollection>
      <MobileTagControls>{sidebarControls}</MobileTagControls>
    </MobileTags>;
    if (short) return logBand;
    return <>{data ? taskBand(false) : <ConnectionState><Muted>Loading…</Muted></ConnectionState>}{logBand}</>;
  };

  return <JournalContext.Provider value={{ tags: data?.tags ?? [], activeTag: data?.tag ?? null, completed, onComplete, reopened, onReopen, target }}><Page $focusing={timerRunning} data-testid="page" data-focus-running={timerRunning ? 'true' : undefined}
    onPointerDownCapture={event => {
      const band = strip.current?.getBoundingClientRect();
      turning.current = band && event.clientY <= band.bottom ? { from: event.clientX, turned: false } : null;
    }}
    onPointerMoveCapture={event => turnPage(event.clientX)}
    onClickCapture={event => {
      // The drag has already answered; the tap it ends with is not meant.
      if (turning.current?.turned || consumePageSwipeClick()) { event.preventDefault(); event.stopPropagation(); }
      turning.current = null;
    }}
    onPointerUpCapture={() => { if (!turning.current?.turned) turning.current = null; }}>
    <TimerChrome>
      <TimerTime data-testid="compact-timer-time" aria-hidden="true">{timerDuration(visibleElapsed)}</TimerTime>
      <TimerButton $running={timerRunning} type="button" disabled={!data} data-haptic="impact"
        aria-label={timerRunning ? 'Stop focus timer' : 'Start focus timer'} aria-pressed={timerRunning} aria-disabled={timerBusy || undefined} aria-busy={timerBusy || undefined}
        title="Click to start/stop · right-click for sound"
        onContextMenu={event => { event.preventDefault(); setSoundOpen(true); }}
        onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); setSoundOpen(true); } }}
        onClick={() => void toggleTimer()}><TimerIcon size={16} aria-hidden="true" /></TimerButton>
    </TimerChrome>
    {!cramped.across && <TagTabs tags={data?.tags ?? []} active={activeTag} onSelect={tag => { void selectTag(tag); }} controls={sidebarControls} compactHover={hasHoverSidebar} />}
    <Main data-focus-surface>
      {paged ? <>
        <ShortHeader ref={strip} data-page-turn>
          <MobileTabs role="tablist" aria-label="Mobile views" $aside={views.includes('tags')}>
            {views.map(view => <MobileTab key={view} id={`mobile-tab-${view}`} type="button" role="tab"
              aria-controls={`mobile-panel-${view}`} aria-selected={mobileView === view} $active={mobileView === view}
              onClick={() => selectMobileView(view)}>{view}</MobileTab>)}
          </MobileTabs>
        </ShortHeader>
        <MobilePager ref={mobilePager} data-testid="mobile-pager" data-mobile-pager onScroll={event => trackMobileScroll(event.currentTarget)}
          onPointerDown={event => {
            // A drag anywhere on a pane turns the page. An entry carries the
            // same gesture itself, so a drag that starts on one is left to it.
            if (event.target instanceof Element && event.target.closest('[data-entry-gesture-key]')) return;
            startPageSwipe(event, event.currentTarget);
          }}
          onPointerMove={trackPageSwipe} onPointerUp={finishPageSwipe} onPointerCancel={cancelPageSwipe}>
          {views.map(view => <MobilePane key={view} id={`mobile-panel-${view}`} role="tabpanel"
            aria-labelledby={`mobile-tab-${view}`} aria-hidden={mobileView !== view} inert={mobileView !== view}>{pane(view)}</MobilePane>)}
        </MobilePager>
      </> : pane('log')}
    </Main>
    <Suspense fallback={null}>
      {openedModals.current.has('sessions') && <SessionsModal date={sessionsDate} onClose={() => setSessionsDate(null)} onChange={refresh} />}
      {openedModals.current.has('stats') && <StatsModal open={statsOpen} onClose={() => setStatsOpen(false)} />}
      {openedModals.current.has('search') && <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} onSelect={jumpTo} />}
      {openedModals.current.has('calendar') && <CalendarModal open={calendarOpen} onClose={() => setCalendarOpen(false)} onChange={refresh} />}
    </Suspense>
    <Modal open={soundOpen} onClose={() => setSoundOpen(false)} title="Focus sound" compact><SoundMenu>
      <TextButton aria-label={audible ? 'Mute focus sound' : 'Play focus sound'} onClick={() => void toggleSound()}>{audible ? 'Mute' : 'Play sound'}</TextButton>
      <input aria-label="Focus sound volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={e => { const value = Number(e.target.value); setVolume(value); storage.setItem('still-volume', String(value)); sound.current.setVolume(value); }} />
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
  </Page></JournalContext.Provider>;
}
