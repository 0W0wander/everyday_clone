import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Habit } from './types';
import {
  listGistCommits, fetchRevision, isSyncConfigured, type GistCommit,
} from './sync';
import './Memory.css';

interface MemoryProps {
  onClose: () => void;
}

type SortMode = 'newest' | 'oldest';

interface HabitCard {
  id: string;
  name: string;
  color: string;
  /** Extra levels beyond base */
  levelCount: number;
  /** Display name of the active tier (base or a level) */
  displayName: string;
  streak: number;
  longest: number;
  ageDays: number;
  recent: boolean[]; // last 14 days ending on commit day
}

interface FrameSummary {
  habits: HabitCard[];
  monthKey: string;
  leveledCount: number;
  avgStreak: number;
  maxStreak: number;
  newbornCount: number; // age ≤ 14 days at snapshot
}

function habitsFromPayload(raw: unknown): Habit[] {
  if (Array.isArray(raw)) return raw.filter(Boolean) as Habit[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { habits?: unknown }).habits)) {
    return (raw as { habits: Habit[] }).habits.filter(Boolean);
  }
  return [];
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(b + 'T12:00:00').getTime() - new Date(a + 'T12:00:00').getTime();
  return Math.round(ms / 86400000);
}

function addDays(ds: string, n: number): string {
  const d = new Date(ds + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Streak of completions ending on or before `asOf` (skips ignored for memory view). */
function streakAt(completions: string[], asOf: string): number {
  const set = new Set(completions.filter(d => d <= asOf));
  if (!set.size) return 0;
  let n = 0;
  let cur = asOf;
  // If asOf itself isn't done, start from yesterday (grace for "today")
  if (!set.has(cur)) cur = addDays(cur, -1);
  while (set.has(cur)) {
    n++;
    cur = addDays(cur, -1);
  }
  return n;
}

function longestStreak(completions: string[], asOf: string): number {
  const days = [...new Set(completions.filter(d => d <= asOf))].sort();
  if (!days.length) return 0;
  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    if (daysBetween(days[i - 1], days[i]) === 1) {
      run++;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }
  return best;
}

function habitAgeDays(h: Habit, asOf: string): number {
  const dates = [...(h.completions ?? []), ...(h.skips ?? []), ...(h.fails ?? [])]
    .filter(d => d <= asOf)
    .sort();
  if (!dates.length) return 0;
  return Math.max(0, daysBetween(dates[0], asOf));
}

function recentWindow(completions: string[], asOf: string, len = 14): boolean[] {
  const set = new Set(completions);
  const out: boolean[] = [];
  for (let i = len - 1; i >= 0; i--) {
    out.push(set.has(addDays(asOf, -i)));
  }
  return out;
}

function toCard(h: Habit, asOf: string): HabitCard {
  const comps = h.completions ?? [];
  const levels = h.levels ?? [];
  const levelCount = levels.length;
  const idx = Math.min(h.activeLevel ?? 0, levelCount);
  const displayName = idx === 0 ? h.name : (levels[idx - 1]?.name || h.name);
  return {
    id: h.id,
    name: h.name,
    color: h.color || '#94a3b8',
    levelCount,
    displayName,
    streak: streakAt(comps, asOf),
    longest: longestStreak(comps, asOf),
    ageDays: habitAgeDays(h, asOf),
    recent: recentWindow(comps, asOf, 14),
  };
}

function summarize(habits: Habit[], committedAt: string): FrameSummary {
  const asOf = committedAt.slice(0, 10);
  const list = habits.filter(h => !h.archived);
  const cards = (list.length ? list : habits).map(h => toCard(h, asOf));
  const streaks = cards.map(c => c.streak);
  const avgStreak = cards.length
    ? Math.round(streaks.reduce((a, b) => a + b, 0) / cards.length)
    : 0;
  return {
    habits: cards,
    monthKey: committedAt.slice(0, 7),
    leveledCount: cards.filter(c => c.levelCount > 0).length,
    avgStreak,
    maxStreak: streaks.length ? Math.max(...streaks) : 0,
    newbornCount: cards.filter(c => c.ageDays > 0 && c.ageDays <= 14).length,
  };
}

function formatPlaqueDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 45) return `${day}d ago`;
  const mo = Math.round(day / 30);
  return `${mo}mo ago`;
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  if (!y || !m) return key;
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/** Diff against an older snapshot to highlight evolution. */
function evolution(
  current: FrameSummary,
  older: FrameSummary | null,
): { born: HabitCard[]; evolved: HabitCard[]; steady: number } {
  if (!older) return { born: current.habits, evolved: [], steady: 0 };
  const oldMap = new Map(older.habits.map(h => [h.id, h]));
  const born: HabitCard[] = [];
  const evolved: HabitCard[] = [];
  let steady = 0;
  for (const h of current.habits) {
    const prev = oldMap.get(h.id);
    if (!prev) {
      born.push(h);
      continue;
    }
    const nameChanged = prev.name !== h.name || prev.displayName !== h.displayName;
    const grew = h.levelCount > prev.levelCount || h.longest > prev.longest + 5;
    if (nameChanged || grew) evolved.push(h);
    else steady++;
  }
  return { born, evolved, steady };
}

function HabitRoster({
  habits, compact, highlightIds,
}: {
  habits: HabitCard[];
  compact?: boolean;
  highlightIds?: Set<string>;
}) {
  const shown = compact ? habits.slice(0, 8) : habits;
  return (
    <ul className={`memory-roster${compact ? ' is-compact' : ''}`}>
      {shown.map(h => (
        <li
          key={h.id}
          className={`memory-roster-row${highlightIds?.has(h.id) ? ' is-new' : ''}`}
        >
          <span className="memory-roster-swatch" style={{ background: h.color }} />
          <span className="memory-roster-name" title={h.name}>
            {h.displayName}
            {h.levelCount > 0 && !compact && (
              <span className="memory-roster-tier"> · {h.levelCount + 1} tiers</span>
            )}
          </span>
          {!compact && (
            <span className="memory-roster-meta" title="Streak / best">
              {h.streak || '—'}
              <span className="memory-roster-sep">/</span>
              {h.longest || '—'}
            </span>
          )}
          {compact && (
            <span className="memory-roster-dots" aria-hidden>
              {h.recent.slice(-7).map((on, i) => (
                <i
                  key={i}
                  className={on ? 'on' : ''}
                  style={on ? { background: h.color } : undefined}
                />
              ))}
            </span>
          )}
        </li>
      ))}
      {compact && habits.length > shown.length && (
        <li className="memory-roster-more">+{habits.length - shown.length} more</li>
      )}
    </ul>
  );
}

export function MemoryGallery({ onClose }: MemoryProps) {
  const [commits, setCommits] = useState<GistCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, FrameSummary | 'loading' | 'error'>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [month, setMonth] = useState<string>('all');
  const [sort, setSort] = useState<SortMode>('oldest');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selected) setSelected(null);
        else onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, selected]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isSyncConfigured()) {
        setError('Cloud sync is not configured — Memory needs your gist history.');
        setCommits([]);
        return;
      }
      const result = await listGistCommits(30);
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        setCommits([]);
        return;
      }
      setCommits(result.data);
    })();
    return () => { cancelled = true; };
  }, []);

  const loadSummary = useCallback(async (sha: string, committedAt: string) => {
    setSummaries(prev => {
      if (prev[sha] && prev[sha] !== 'error') return prev;
      return { ...prev, [sha]: 'loading' };
    });
    const result = await fetchRevision<unknown>(sha);
    if (!result.ok) {
      setSummaries(prev => ({ ...prev, [sha]: 'error' }));
      return;
    }
    const habits = habitsFromPayload(result.data);
    setSummaries(prev => ({ ...prev, [sha]: summarize(habits, committedAt) }));
  }, []);

  useEffect(() => {
    if (!commits) return;
    let i = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled || i >= commits.length) return;
      const c = commits[i++];
      void loadSummary(c.version, c.committed_at).then(() => {
        if (!cancelled) setTimeout(tick, 80);
      });
    };
    tick();
    return () => { cancelled = true; };
  }, [commits, loadSummary]);

  const months = useMemo(() => {
    if (!commits) return [];
    const keys = [...new Set(commits.map(c => c.committed_at.slice(0, 7)))];
    return keys.sort((a, b) => b.localeCompare(a));
  }, [commits]);

  const frames = useMemo(() => {
    if (!commits) return [];
    let list = [...commits];
    if (sort === 'oldest') list = list.slice().reverse();
    if (month !== 'all') list = list.filter(c => c.committed_at.slice(0, 7) === month);
    return list;
  }, [commits, month, sort]);

  const selectedCommit = commits?.find(c => c.version === selected) ?? null;
  const selectedSum = selected ? summaries[selected] : null;

  // Oldest loaded snapshot before the selected one (for evolution labels)
  const olderSum = useMemo((): FrameSummary | null => {
    if (!commits || !selected || !selectedSum || selectedSum === 'loading' || selectedSum === 'error') {
      return null;
    }
    // commits are newest-first from API
    const idx = commits.findIndex(c => c.version === selected);
    for (let i = idx + 1; i < commits.length; i++) {
      const s = summaries[commits[i].version];
      if (s && s !== 'loading' && s !== 'error') return s;
    }
    return null;
  }, [commits, selected, selectedSum, summaries]);

  const evo = selectedSum && selectedSum !== 'loading' && selectedSum !== 'error'
    ? evolution(selectedSum, olderSum)
    : null;
  const highlightNew = new Set(evo?.born.map(h => h.id) ?? []);

  return createPortal(
    <div className="memory-overlay" onClick={onClose} role="presentation">
      <div className="memory-hall" onClick={e => e.stopPropagation()} role="dialog" aria-label="Memory gallery">
        <header className="memory-header">
          <div className="memory-title-block">
            <p className="memory-eyebrow">Habit evolution</p>
            <h2 className="memory-title">Memory</h2>
            <p className="memory-subtitle">
              Snapshots of your board over time — baby habits growing up, new ones arriving.
            </p>
          </div>
          <button type="button" className="memory-close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="memory-filters">
          <label className="memory-filter">
            <span>Era</span>
            <select className="memory-select" value={month} onChange={e => setMonth(e.target.value)}>
              <option value="all">All months</option>
              {months.map(m => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </select>
          </label>
          <label className="memory-filter">
            <span>Order</span>
            <select className="memory-select" value={sort} onChange={e => setSort(e.target.value as SortMode)}>
              <option value="oldest">Oldest first</option>
              <option value="newest">Newest first</option>
            </select>
          </label>
        </div>

        {error && <p className="memory-error">{error}</p>}

        {commits === null ? (
          <p className="memory-empty">Dusting the frames…</p>
        ) : frames.length === 0 ? (
          <p className="memory-empty">
            {commits.length === 0
              ? 'No sync history yet. Sync a few times to hang snapshots here.'
              : 'No snapshots in this era.'}
          </p>
        ) : (
          <div className="memory-wall">
            {frames.map((c, i) => {
              const sum = summaries[c.version];
              const isHead = commits[0]?.version === c.version;
              return (
                <button
                  key={c.version}
                  type="button"
                  className={`memory-frame${selected === c.version ? ' is-selected' : ''}${isHead ? ' is-head' : ''}`}
                  onClick={() => setSelected(c.version)}
                  style={{ '--tilt': `${((i % 5) - 2) * 0.28}deg` } as CSSProperties}
                >
                  <div className="memory-mat">
                    <div className="memory-painting">
                      {sum === 'loading' || sum == null ? (
                        <div className="memory-painting-loading">Developing…</div>
                      ) : sum === 'error' ? (
                        <div className="memory-painting-loading">Faded</div>
                      ) : (
                        <HabitRoster habits={sum.habits} compact />
                      )}
                    </div>
                  </div>
                  <div className="memory-plaque">
                    <span className="memory-plaque-date">{formatPlaqueDate(c.committed_at)}</span>
                    <span className="memory-plaque-meta">
                      {isHead ? 'Present day' : formatRelative(c.committed_at)}
                      {sum && sum !== 'loading' && sum !== 'error'
                        ? ` · ${sum.habits.length} habits`
                        : ''}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {selected && selectedCommit && (
          <div className="memory-detail-scrim" onClick={() => setSelected(null)} role="presentation">
            <div className="memory-detail" onClick={e => e.stopPropagation()}>
              <div className="memory-detail-frame">
                <div className="memory-mat memory-mat-lg">
                  <div className="memory-painting memory-painting-lg">
                    {selectedSum && selectedSum !== 'loading' && selectedSum !== 'error' ? (
                      <HabitRoster habits={selectedSum.habits} highlightIds={highlightNew} />
                    ) : (
                      <div className="memory-painting-loading">Developing…</div>
                    )}
                  </div>
                </div>
              </div>
              <div className="memory-detail-copy">
                <p className="memory-eyebrow">Snapshot</p>
                <h3 className="memory-detail-title">{formatPlaqueDate(selectedCommit.committed_at)}</h3>
                <p className="memory-detail-rel">{formatRelative(selectedCommit.committed_at)}</p>
                {selectedSum && selectedSum !== 'loading' && selectedSum !== 'error' && evo && (
                  <>
                    <dl className="memory-stats">
                      <div><dt>Habits</dt><dd>{selectedSum.habits.length}</dd></div>
                      <div><dt>With levels</dt><dd>{selectedSum.leveledCount}</dd></div>
                      <div><dt>Best streak</dt><dd>{selectedSum.maxStreak}</dd></div>
                      <div><dt>Avg streak</dt><dd>{selectedSum.avgStreak}</dd></div>
                      <div><dt>Newborns</dt><dd>{selectedSum.newbornCount}</dd></div>
                      <div><dt>New here</dt><dd>{evo.born.length}</dd></div>
                    </dl>

                    {(evo.born.length > 0 || evo.evolved.length > 0) && (
                      <div className="memory-evo">
                        {evo.born.length > 0 && (
                          <div className="memory-evo-block">
                            <p className="memory-evo-label">Arrived</p>
                            <ul className="memory-evo-list">
                              {evo.born.map(h => (
                                <li key={h.id}>
                                  <span className="memory-roster-swatch" style={{ background: h.color }} />
                                  {h.displayName}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {evo.evolved.length > 0 && (
                          <div className="memory-evo-block">
                            <p className="memory-evo-label">Evolved</p>
                            <ul className="memory-evo-list">
                              {evo.evolved.map(h => (
                                <li key={h.id}>
                                  <span className="memory-roster-swatch" style={{ background: h.color }} />
                                  {h.displayName}
                                  {h.levelCount > 0 && (
                                    <span className="memory-roster-tier"> · {h.levelCount + 1} tiers</span>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                    <p className="memory-detail-hint">
                      Streak column is current / best as of this snapshot.
                      {olderSum
                        ? ' Gold rows are habits that didn’t exist in the previous memory.'
                        : ' This is the earliest loaded snapshot.'}
                    </p>
                  </>
                )}
                <div className="memory-detail-actions">
                  <button type="button" className="memory-btn-ghost" onClick={() => setSelected(null)}>
                    Back to wall
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
