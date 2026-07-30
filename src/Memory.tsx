import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Habit } from './types';
import {
  listGistCommits, fetchRevision, isSyncConfigured, type GistCommit,
} from './sync';
import './Memory.css';

interface MemoryProps {
  onClose: () => void;
  onRestore: (sha: string) => Promise<void>;
}

type SortMode = 'newest' | 'oldest';

interface FrameSummary {
  habitCount: number;
  activeCount: number;
  completionDays: number;
  commentCount: number;
  strokes: { color: string; strength: number; name: string }[];
  monthKey: string;
  habitNames: string[];
}

function habitsFromPayload(raw: unknown): Habit[] {
  if (Array.isArray(raw)) return raw.filter(Boolean) as Habit[];
  if (raw && typeof raw === 'object' && Array.isArray((raw as { habits?: unknown }).habits)) {
    return (raw as { habits: Habit[] }).habits.filter(Boolean);
  }
  return [];
}

function summarize(habits: Habit[], committedAt: string): FrameSummary {
  const active = habits.filter(h => !h.archived);
  const list = active.length ? active : habits;
  const completionDays = list.reduce((s, h) => s + (h.completions?.length ?? 0), 0);
  const commentCount = list.reduce((s, h) => s + Object.keys(h.comments ?? {}).length, 0);

  // Recent activity window relative to the commit date
  const commitDay = committedAt.slice(0, 10);
  const strokes = list.slice(0, 14).map(h => {
    const recent = (h.completions ?? []).filter(d => d <= commitDay).slice(-21).length;
    return {
      color: h.color || '#94a3b8',
      strength: Math.min(1, 0.18 + recent / 14),
      name: h.name,
    };
  });

  return {
    habitCount: habits.length,
    activeCount: list.length,
    completionDays,
    commentCount,
    strokes,
    monthKey: committedAt.slice(0, 7),
    habitNames: list.map(h => h.name),
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

export function MemoryGallery({ onClose, onRestore }: MemoryProps) {
  const [commits, setCommits] = useState<GistCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Record<string, FrameSummary | 'loading' | 'error'>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [month, setMonth] = useState<string>('all');
  const [sort, setSort] = useState<SortMode>('newest');
  const [busy, setBusy] = useState(false);

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

  // Prefetch visible frames (all listed commits, lazily)
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
    const q = query.trim().toLowerCase();
    let list = [...commits];
    if (sort === 'oldest') list.reverse();
    return list.filter(c => {
      if (month !== 'all' && c.committed_at.slice(0, 7) !== month) return false;
      if (!q) return true;
      const sum = summaries[c.version];
      if (!sum || sum === 'loading' || sum === 'error') {
        // Keep loading frames visible until we know; hide errors that can't match
        return sum !== 'error';
      }
      return sum.habitNames.some(n => n.toLowerCase().includes(q));
    });
  }, [commits, month, query, sort, summaries]);

  const selectedCommit = commits?.find(c => c.version === selected) ?? null;
  const selectedSum = selected ? summaries[selected] : null;

  const restore = async () => {
    if (!selected) return;
    if (!window.confirm('Replace your current board with this memory? Your current state will be overwritten and synced to the cloud.')) return;
    setBusy(true);
    try {
      await onRestore(selected);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="memory-overlay" onClick={onClose} role="presentation">
      <div className="memory-hall" onClick={e => e.stopPropagation()} role="dialog" aria-label="Memory gallery">
        <header className="memory-header">
          <div className="memory-title-block">
            <p className="memory-eyebrow">Gallery of days</p>
            <h2 className="memory-title">Memory</h2>
            <p className="memory-subtitle">
              Framed snapshots from past cloud syncs — who you were on those days.
            </p>
          </div>
          <button type="button" className="memory-close" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="memory-filters">
          <label className="memory-filter">
            <span>Find habit</span>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="e.g. Duolingo"
              className="memory-input"
            />
          </label>
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
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
        </div>

        {error && <p className="memory-error">{error}</p>}

        {commits === null ? (
          <p className="memory-empty">Dusting the frames…</p>
        ) : frames.length === 0 ? (
          <p className="memory-empty">
            {commits.length === 0
              ? 'No sync history yet. Sync a few times to hang paintings here.'
              : 'No frames match these filters.'}
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
                  style={{ '--tilt': `${((i % 5) - 2) * 0.35}deg` } as CSSProperties}
                >
                  <div className="memory-mat">
                    <div className="memory-painting">
                      {sum === 'loading' || sum == null ? (
                        <div className="memory-painting-loading">Developing…</div>
                      ) : sum === 'error' ? (
                        <div className="memory-painting-loading">Faded</div>
                      ) : (
                        sum.strokes.map((s, j) => (
                          <span
                            key={j}
                            className="memory-stroke"
                            title={s.name}
                            style={{
                              background: s.color,
                              opacity: s.strength,
                              width: `${42 + (j * 7) % 40}%`,
                              marginLeft: `${(j * 11) % 28}%`,
                            }}
                          />
                        ))
                      )}
                    </div>
                  </div>
                  <div className="memory-plaque">
                    <span className="memory-plaque-date">{formatPlaqueDate(c.committed_at)}</span>
                    <span className="memory-plaque-meta">
                      {isHead ? 'Present day' : formatRelative(c.committed_at)}
                      {sum && sum !== 'loading' && sum !== 'error'
                        ? ` · ${sum.activeCount} habits`
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
                      selectedSum.strokes.map((s, j) => (
                        <span
                          key={j}
                          className="memory-stroke memory-stroke-lg"
                          style={{
                            background: s.color,
                            opacity: s.strength,
                            width: `${50 + (j * 9) % 45}%`,
                            marginLeft: `${(j * 13) % 22}%`,
                          }}
                        />
                      ))
                    ) : (
                      <div className="memory-painting-loading">Developing…</div>
                    )}
                  </div>
                </div>
              </div>
              <div className="memory-detail-copy">
                <p className="memory-eyebrow">Exhibition label</p>
                <h3 className="memory-detail-title">{formatPlaqueDate(selectedCommit.committed_at)}</h3>
                <p className="memory-detail-rel">{formatRelative(selectedCommit.committed_at)}</p>
                {selectedSum && selectedSum !== 'loading' && selectedSum !== 'error' && (
                  <>
                    <dl className="memory-stats">
                      <div><dt>Habits</dt><dd>{selectedSum.activeCount}</dd></div>
                      <div><dt>Logged days</dt><dd>{selectedSum.completionDays}</dd></div>
                      <div><dt>Notes</dt><dd>{selectedSum.commentCount}</dd></div>
                    </dl>
                    <ul className="memory-habit-list">
                      {selectedSum.habitNames.slice(0, 18).map(n => (
                        <li key={n}>{n}</li>
                      ))}
                      {selectedSum.habitNames.length > 18 && (
                        <li className="memory-habit-more">
                          +{selectedSum.habitNames.length - 18} more
                        </li>
                      )}
                    </ul>
                  </>
                )}
                <div className="memory-detail-actions">
                  <button type="button" className="memory-btn-ghost" onClick={() => setSelected(null)}>
                    Back to wall
                  </button>
                  <button
                    type="button"
                    className="memory-btn-restore"
                    disabled={busy || commits?.[0]?.version === selected}
                    onClick={() => void restore()}
                    title={commits?.[0]?.version === selected ? 'This is already your current board' : 'Restore this memory'}
                  >
                    {busy ? 'Restoring…' : 'Restore this day'}
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
