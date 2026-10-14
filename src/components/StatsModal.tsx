import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import styled from 'styled-components';
import { getStats, dateObject, duration, errorMessage, localDate } from '../api';
import type { Stats } from '../types';
import { InlineError, Muted } from '../styles';
import { Modal } from './Modal';

const Header = styled.div`
  display: flex; align-items: center; justify-content: flex-end; gap: 16px; margin-bottom: 26px;
`;
const Tools = styled.div`display: flex; align-items: center; gap: 4px;`;
const Period = styled.div`display: flex; align-items: center; gap: 2px;`;
const Range = styled.button<{ $selected: boolean }>`
  min-height: 40px; padding: 0 7px; border: 0; background: transparent; font-size: 12px;
  color: ${({ $selected }) => $selected ? 'var(--ink)' : 'var(--muted)'};
  transition: color 120ms ease-out;
  &:hover { color: var(--link); }
`;
const DownloadLink = styled.a`
  width: 40px; height: 40px; display: grid; place-items: center; border-radius: 50%; color: var(--muted);
  transition: color 120ms ease-out, scale 120ms ease-out;
  &:hover { color: var(--link); scale: 1.06; }
  &:active { scale: .96; }
`;
const AverageScope = styled.div`
  min-height: 40px; display: flex; align-items: center; flex-wrap: wrap; gap: 4px; margin-bottom: 8px;
  color: var(--muted); font-size: 12px;
`;
const ScopeChoice = styled.button<{ $selected: boolean }>`
  min-height: 40px; padding: 0 4px; border: 0; background: transparent;
  color: ${({ $selected }) => $selected ? 'var(--ink)' : 'var(--muted)'};
  text-decoration: ${({ $selected }) => $selected ? 'underline' : 'none'}; text-underline-offset: 4px;
  &:hover { color: var(--link); }
`;
const Metrics = styled.div`
  display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-bottom: 26px;
  @media(max-width: 440px) { grid-template-columns: 1fr; gap: 12px; }
`;
const Metric = styled.div`padding: 2px 0;`;
const MetricValue = styled.p`
  margin: 0 0 2px; color: var(--ink); font-size: 30px; font-weight: 300; font-variant-numeric: tabular-nums;
`;
const MetricLabel = styled.p`font-size: 12px; color: var(--muted);`;
const Graph = styled.div<{ $count: number }>`
  display: grid; grid-template-columns: repeat(${({ $count }) => $count}, minmax(0, 1fr));
  gap: ${({ $count }) => $count > 7 ? '5px' : '18px'}; height: 128px; align-items: end; padding: 0 6px;
  box-shadow: inset 0 -1px var(--line);
`;
const Bar = styled.div<{ $height: number; $today: boolean }>`
  height: ${({ $height }) => $height}%; width: min(100%, 30px); margin: 0 auto;
  border-radius: 4px 4px 0 0; background: ${({ $today }) => $today ? 'var(--chart-today)' : 'var(--chart)'};
  transition: background-color 120ms ease-out;
  &:hover { background: var(--chart-hover); }
`;
const Axis = styled.div<{ $count: number }>`
  display: grid; grid-template-columns: repeat(${({ $count }) => $count}, minmax(0, 1fr));
  gap: ${({ $count }) => $count > 7 ? '5px' : '18px'}; padding: 8px 6px 0;
  color: var(--muted); font-size: 10px; text-align: center;
`;
const Quiet = styled.div`display: grid; place-items: center; min-height: 260px; color: var(--sage);`;
const Details = styled.div`
  margin-top: 10px; font-size: 12px;
`;
const Disclosure = styled.button<{ $open: boolean }>`
  width: fit-content; min-height: 44px; padding: 0; border: 0; background: transparent;
  display: flex; align-items: center; gap: 9px; color: var(--muted); font-variant-numeric: tabular-nums;
  &::before { content: ''; width: 5px; height: 5px; border-right: 1.25px solid currentColor; border-bottom: 1.25px solid currentColor;
    transform: rotate(${({ $open }) => $open ? '45deg' : '-45deg'}); transition: transform 140ms ease-out; }
`;
const DayBranch = styled.div<{ $open: boolean }>`
  display: grid; min-height: 0; grid-template-rows: ${({ $open }) => $open ? '1fr' : '0fr'};
  opacity: ${({ $open }) => $open ? 1 : 0}; transform: translateY(${({ $open }) => $open ? '0' : '-3px'});
  visibility: ${({ $open }) => $open ? 'visible' : 'hidden'}; pointer-events: ${({ $open }) => $open ? 'auto' : 'none'};
  transition-property: grid-template-rows, opacity, transform, visibility;
  transition-duration: 320ms, 240ms, 320ms, 0s; transition-timing-function: cubic-bezier(.2, 0, 0, 1);
  transition-delay: ${({ $open }) => $open ? '0s' : '0s, 60ms, 0s, 320ms'};
  > div { min-height: 0; overflow: hidden; }
`;
const DayList = styled.ul`list-style: none; padding: 0; margin: 0; font-variant-numeric: tabular-nums;`;
const DayRow = styled.li`
  min-height: 36px; display: grid; grid-template-columns: 88px minmax(0, 1fr) max-content; align-items: center; gap: 12px;
  time, span:last-child { color: var(--muted); }
`;

export function StatsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [range, setRange] = useState(7);
  const [activeOnly, setActiveOnly] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailsPinned, setDetailsPinned] = useState(false);
  const [detailsPreviewed, setDetailsPreviewed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true); setError('');
    const end = new Date(); const start = new Date(); start.setDate(end.getDate() - range + 1);
    getStats(localDate(start), localDate(end)).then(data => { if (!cancelled) setStats(data); })
      .catch(e => { if (!cancelled) setError(errorMessage(e)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, range]);
  const max = Math.max(1, ...(stats?.daily.map(day => day.focused_seconds) ?? []));
  const denominator = activeOnly ? stats?.active_days : stats?.day_count;
  const averageFocus = stats && denominator ? stats.total_focused_seconds / denominator : 0;
  const averageLongest = stats && denominator
    ? stats.daily.reduce((sum, day) => sum + day.longest_session_seconds, 0) / denominator : 0;
  const detailsOpen = detailsPinned || detailsPreviewed;
  return <Modal open={open} onClose={onClose} title="Statistics">
    <Header><Tools>
      <Period aria-label="Statistics period">{[7, 30].map(days => <Range type="button" key={days} $selected={range === days}
        aria-pressed={range === days} onClick={() => setRange(days)}>{days} days</Range>)}</Period>
      <DownloadLink href="/api/backup" download aria-label="Download SQLite backup" title="Download SQLite backup">
        <Download size={14} aria-hidden="true" />
      </DownloadLink>
    </Tools></Header>
    {error ? <InlineError role="alert">{error}</InlineError> : loading || !stats ? <Quiet><Muted>loading…</Muted></Quiet> : <>
      <AverageScope aria-label="Average over"><span>average over</span>
        <ScopeChoice type="button" $selected={!activeOnly} aria-pressed={!activeOnly} onClick={() => setActiveOnly(false)}>all days</ScopeChoice>
        <span>·</span>
        <ScopeChoice type="button" $selected={activeOnly} aria-pressed={activeOnly} onClick={() => setActiveOnly(true)}>focus days</ScopeChoice>
      </AverageScope>
      <Metrics><Metric><MetricValue>{duration(averageFocus)}</MetricValue><MetricLabel>focused per day</MetricLabel></Metric>
        <Metric><MetricValue>{duration(averageLongest)}</MetricValue><MetricLabel>longest stretch per day</MetricLabel></Metric></Metrics>
      <Graph $count={stats.daily.length} role="img" aria-label={`Daily focus over ${range} days. Exact values are available in the breakdown below.`}>
        {stats.daily.map(day => <Bar key={day.date} $height={day.focused_seconds / max * 100} $today={day.date === stats.end}
          title={`${day.date}: ${duration(day.focused_seconds)}`} />)}
      </Graph>
      <Axis $count={stats.daily.length}>{stats.daily.map((day, index) => <span key={day.date}>{range === 7
        ? dateObject(day.date).toLocaleDateString('en-US', { weekday: 'short' })
        : index % 7 === 0 || index === 29 ? dateObject(day.date).getDate() : ''}</span>)}</Axis>
      <Details onPointerLeave={() => setDetailsPreviewed(false)}><Disclosure type="button" $open={detailsOpen} aria-expanded={detailsOpen}
        onPointerEnter={event => { if (event.pointerType !== 'touch' && !detailsPinned) setDetailsPreviewed(true); }}
        onClick={() => { setDetailsPinned(value => !value); setDetailsPreviewed(false); }}>
        {duration(stats.total_focused_seconds)} total · {stats.session_count} {stats.session_count === 1 ? 'session' : 'sessions'}
      </Disclosure><DayBranch $open={detailsOpen} aria-hidden={!detailsOpen}><div><DayList>{stats.daily.map(day => <DayRow key={day.date}
        title={`longest session ${duration(day.longest_session_seconds)}`}>
        <time dateTime={day.date}>{dateObject(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase()}</time>
        <span>{duration(day.focused_seconds)}</span>
        <span>{day.completed_task_count ? `${day.completed_task_count} done` : ''}</span>
      </DayRow>)}</DayList></div></DayBranch></Details>
    </>}
  </Modal>;
}
