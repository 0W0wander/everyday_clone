import {
  useState, useEffect, useCallback, useMemo, useRef, memo,
} from 'react';
import { createPortal } from 'react-dom';
import './App.css';
import type { Habit, HabitColor } from './types';
import { fetchRemote, pushRemote, isSyncConfigured } from './sync';

// ─── Palettes ────────────────────────────────────────────────────────────────

// Palettes go light → vivid (peak streak = brightest, not darkest)
const COLOR_PALETTES: Record<HabitColor, string[]> = {
  green:  ['#f0fdf4','#dcfce7','#bbf7d0','#86efac','#4ade80','#22c55e','#00c853','#00e676'],
  blue:   ['#eff6ff','#dbeafe','#bfdbfe','#93c5fd','#60a5fa','#3b82f6','#2979ff','#82b1ff'],
  yellow: ['#fefce8','#fef9c3','#fef08a','#fde047','#facc15','#fbbf24','#ffd740','#ffe57f'],
  orange: ['#fff7ed','#ffedd5','#fed7aa','#fdba74','#fb923c','#f97316','#ff6d00','#ff9100'],
  red:    ['#fff1f2','#ffe4e6','#fecdd3','#fda4af','#fb7185','#f43f5e','#ff1744','#ff5252'],
  purple: ['#fdf4ff','#fae8ff','#f0abfc','#e879f9','#d946ef','#c026d3','#aa00ff','#ea80fc'],
  teal:   ['#f0fdfa','#ccfbf1','#99f6e4','#5eead4','#2dd4bf','#14b8a6','#00bcd4','#1de9b6'],
};

const COLOR_ACCENT: Record<HabitColor, string> = {
  green:  '#00c853', blue:   '#2979ff', yellow: '#ffd740',
  orange: '#ff6d00', red:    '#ff1744', purple: '#aa00ff', teal:   '#00bcd4',
};

const MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS        = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
const HABIT_COLORS: HabitColor[] = ['green','blue','yellow','orange','red','purple','teal'];
const STORAGE_KEY = 'everyday-habits-v2';

// Responsive layout config — recomputed when viewport changes
interface Layout {
  daysBack: number;
  wName:  number;
  wDay:   number;
  wToday: number;
  wStat:  number;
  rowH:   number;
  isMobile: boolean;
}

function getLayout(width: number): Layout {
  if (width < 640) {
    return { daysBack: 5, wName: 100, wDay: 30, wToday: 50, wStat: 38, rowH: 44, isMobile: true };
  }
  if (width < 900) {
    return { daysBack: 9, wName: 130, wDay: 38, wToday: 70, wStat: 46, rowH: 42, isMobile: false };
  }
  return { daysBack: 13, wName: 175, wDay: 46, wToday: 90, wStat: 52, rowH: 42, isMobile: false };
}

// ─── Analytics helpers ────────────────────────────────────────────────────────

// ── Calendar period helpers ───────────────────────────────────────────────────
// Returns YYYY-MM-DD of the Monday of the current week
function startOfWeek(): string {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun … 6=Sat
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return fmt(d);
}
// Returns YYYY-MM-DD of the 1st of the current month
function startOfMonth(): string {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(1);
  return fmt(d);
}

// Count completions from fromDate (inclusive) to today
function countFrom(completions: string[], fromDate: string): number {
  return completions.filter(d => d >= fromDate).length;
}

// Completion rate from fromDate to today, using an adjusted denominator:
// denominator = days elapsed from max(fromDate, habit's first completion) to today
// This avoids penalising habits that started mid-period.
function rateFrom(completions: string[], fromDate: string): number {
  if (!completions.length) return 0;
  const todStr = fmt(todayNoon());
  const firstEntry = [...completions].sort()[0];
  const effectiveFrom = firstEntry > fromDate ? firstEntry : fromDate;
  const days = Math.max(1,
    Math.round(
      (new Date(todStr + 'T12:00:00').getTime() -
       new Date(effectiveFrom + 'T12:00:00').getTime()) / 86400000
    ) + 1
  );
  return Math.round((countFrom(completions, fromDate) / days) * 100);
}

// All-time rate: completions / days since first completion
function allTimeRate(completions: string[]): number {
  if (!completions.length) return 0;
  const todStr = fmt(todayNoon());
  const first = [...completions].sort()[0];
  const days = Math.max(1,
    Math.round(
      (new Date(todStr + 'T12:00:00').getTime() -
       new Date(first + 'T12:00:00').getTime()) / 86400000
    ) + 1
  );
  return Math.round((completions.length / days) * 100);
}

function rateColor(rate: number, accent: string): string {
  if (rate >= 50) return accent;
  if (rate >= 25) return '#f59e0b';
  return '#ef4444';
}

const STAT_HEADERS: [string, string, string][] = [
  ['current\nstreak', 'longest\nstreak', 'total\ncount'],
  ['this\nweek',      'this\nmonth',     'all\ntime'],
  ['week\n%',         'month\n%',        'all-time\n%'],
];

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayNoon(): Date {
  const d = new Date(); d.setHours(12, 0, 0, 0); return d;
}
function fmt(d: Date): string { return d.toISOString().split('T')[0]; }

function getVisibleDates(offset: number, daysBack: number): Date[] {
  const base = todayNoon();
  return Array.from({ length: daysBack + 1 }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() - (daysBack - i) - offset);
    return d;
  });
}

// Track viewport width so layout can be responsive
function useViewportWidth(): number {
  const [w, setW] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 1024);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  return w;
}

// ─── Streak helpers ───────────────────────────────────────────────────────────

function streakAt(comp: Set<string>, skip: Set<string>, ds: string): number {
  if (!comp.has(ds) && !skip.has(ds)) return 0;
  // Skips are transparent: they keep the streak alive but don't add to the count
  let n = comp.has(ds) ? 1 : 0;
  let consecSkips = skip.has(ds) ? 1 : 0;
  const d = new Date(ds + 'T12:00:00');
  for (;;) {
    d.setDate(d.getDate() - 1);
    const s = fmt(d);
    if (comp.has(s)) { n++; consecSkips = 0; }
    else if (skip.has(s)) {
      consecSkips++;
      if (consecSkips > 2) break;
      // don't increment n — skip is transparent
    } else break;
  }
  return n;
}

function calcCurrentStreak(completions: string[], skips: string[]): number {
  const comp = new Set(completions), skip = new Set(skips);
  const t = todayNoon(), ts = fmt(t);
  const y = new Date(t); y.setDate(y.getDate() - 1); const ys = fmt(y);
  if (comp.has(ts) || skip.has(ts)) return streakAt(comp, skip, ts);
  if (comp.has(ys) || skip.has(ys)) return streakAt(comp, skip, ys);
  return 0;
}

function calcLongestStreak(completions: string[], skips: string[]): number {
  const skipSet = new Set(skips);
  const all = [...new Set([...completions, ...skips])].sort();
  if (!all.length) return 0;
  let max = 0, cur = skipSet.has(all[0]) ? 0 : 1;
  let consecSkips = skipSet.has(all[0]) ? 1 : 0;
  for (let i = 1; i < all.length; i++) {
    const diff = Math.round(
      (new Date(all[i] + 'T12:00:00').getTime() -
       new Date(all[i-1] + 'T12:00:00').getTime()) / 86400000
    );
    if (diff !== 1) {
      max = Math.max(max, cur);
      cur = skipSet.has(all[i]) ? 0 : 1;
      consecSkips = skipSet.has(all[i]) ? 1 : 0;
    } else if (!skipSet.has(all[i])) {
      consecSkips = 0;
      cur++;
    } else {
      consecSkips++;
      if (consecSkips > 2) { max = Math.max(max, cur); cur = 0; }
      // skip is transparent — don't increment cur
    }
  }
  return Math.max(max, cur);
}

// Returns true if adding `ds` to the skip set would create a run longer than maxRun
function wouldExceedSkipRun(skips: string[], ds: string, maxRun: number): boolean {
  const skipSet = new Set(skips);
  const base = new Date(ds + 'T12:00:00');
  let run = 1;
  for (let i = 1; i <= maxRun; i++) {
    const d = new Date(base); d.setDate(d.getDate() - i);
    if (skipSet.has(fmt(d))) run++; else break;
  }
  for (let i = 1; i <= maxRun; i++) {
    const d = new Date(base); d.setDate(d.getDate() + i);
    if (skipSet.has(fmt(d))) run++; else break;
  }
  return run > maxRun;
}

function intensityIdx(s: number): number {
  if (s <= 1) return 0; if (s <= 2) return 1; if (s <= 4) return 2;
  if (s <= 7) return 3; if (s <= 11) return 4; if (s <= 16) return 5;
  if (s <= 22) return 6; return 7;
}
function cellBg(streak: number, color: HabitColor): string {
  return streak === 0 ? '' : COLOR_PALETTES[color][intensityIdx(streak)];
}

// ─── Data sanitisation ────────────────────────────────────────────────────────
// Applied to every habit that enters the app — from localStorage, JSONBin,
// or file import — so we never crash on missing / wrong-typed fields.

function sanitize(h: Partial<Habit>): Habit {
  return {
    id:          typeof h.id   === 'string' ? h.id   : `h-${Date.now()}-${Math.random()}`,
    name:        typeof h.name === 'string' ? h.name : 'New Habit',
    color:       (['green','blue','yellow','orange','red','purple','teal'] as HabitColor[])
                   .includes(h.color as HabitColor) ? h.color as HabitColor : 'green',
    completions: Array.isArray(h.completions) ? h.completions.filter(d => typeof d === 'string') : [],
    skips:       Array.isArray(h.skips)       ? h.skips.filter(d => typeof d === 'string')       : [],
    fails:       Array.isArray(h.fails)       ? h.fails.filter(d => typeof d === 'string')       : [],
    isBreak:     !!h.isBreak,
  };
}

function sanitizeAll(raw: unknown): Habit[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(h => sanitize(h as Partial<Habit>));
}

function loadHabits(): Habit[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitizeAll(JSON.parse(raw));
  } catch { /* noop */ }
  return [];
}

// ─── EditPanel — rendered via portal so it's never clipped ───────────────────

interface EditPanelProps {
  habit: Habit;
  anchorRect: DOMRect;
  isFirst: boolean;
  isLast: boolean;
  onSave: (name: string, color: HabitColor) => void;
  onCancel: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function EditPanel({ habit, anchorRect, isFirst, isLast,
  onSave, onCancel, onDelete, onMoveUp, onMoveDown }: EditPanelProps) {

  const [name,  setName]  = useState(habit.name);
  const [color, setColor] = useState<HabitColor>(habit.color);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Close on outside click
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    // Slight delay so the opening click doesn't immediately close it
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 80);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler); };
  }, [onCancel]);

  // Position below the anchor cell, flush with its left edge
  const top  = anchorRect.bottom + window.scrollY + 4;
  const left = anchorRect.left   + window.scrollX;

  const handleSave = () => { const n = name.trim(); if (n) onSave(n, color); };

  return createPortal(
    <div ref={panelRef} className="edit-panel" style={{ top, left }}>
      <input
        ref={inputRef}
        className="edit-panel-input"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
        placeholder="Habit name…"
      />
      <div className="color-row">
        {HABIT_COLORS.map(c => (
          <button
            key={c}
            className={`swatch${color === c ? ' active' : ''}`}
            style={{ backgroundColor: COLOR_PALETTES[c][4] }}
            onClick={() => setColor(c)}
          />
        ))}
      </div>
      <div className="edit-panel-move">
        <button className="move-btn" disabled={isFirst} onClick={onMoveUp} title="Move up">
          <ArrowUpIcon /> Move up
        </button>
        <button className="move-btn" disabled={isLast} onClick={onMoveDown} title="Move down">
          <ArrowDownIcon /> Move down
        </button>
      </div>
      <div className="edit-panel-actions">
        <button className="btn-save" onClick={handleSave}>Save</button>
        <button className="btn-cancel" onClick={onCancel}>Cancel</button>
        <button className="btn-delete" onClick={onDelete} title="Delete habit">
          <TrashIcon />
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ─── HabitRow ─────────────────────────────────────────────────────────────────

interface RowProps {
  habit: Habit;
  dates: Date[];
  isCurrentDay: boolean;
  onToggle: (id: string, ds: string) => void;
  editMode: boolean;
  isEditing: boolean;
  onOpenEdit: (rect: DOMRect) => void;
  analyticsView: 0 | 1 | 2;
}

const HabitRow = memo(function HabitRow(
  { habit, dates, isCurrentDay, onToggle, editMode, isEditing, onOpenEdit, analyticsView }: RowProps
) {
  const nameRef = useRef<HTMLDivElement>(null);
  const comp = useMemo(() => new Set(habit.completions), [habit.completions]);
  const skip = useMemo(() => new Set(habit.skips),       [habit.skips]);
  const fail = useMemo(() => new Set(habit.fails),       [habit.fails]);
  const cur  = useMemo(() => calcCurrentStreak(habit.completions, habit.skips),  [habit.completions, habit.skips]);
  const lon  = useMemo(() => calcLongestStreak(habit.completions, habit.skips),  [habit.completions, habit.skips]);
  const best = cur > 0 && cur >= lon;
  const acc  = COLOR_ACCENT[habit.color];

  // Analytics view 1 — calendar-period counts
  const wkCnt  = useMemo(() => countFrom(habit.completions, startOfWeek()),  [habit.completions]);
  const moCnt  = useMemo(() => countFrom(habit.completions, startOfMonth()), [habit.completions]);
  const allCnt = useMemo(() => habit.completions.length,                     [habit.completions]);
  // Analytics view 2 — completion rates (denominator = days since habit started)
  const wkRate  = useMemo(() => rateFrom(habit.completions, startOfWeek()),  [habit.completions]);
  const moRate  = useMemo(() => rateFrom(habit.completions, startOfMonth()), [habit.completions]);
  const allRate = useMemo(() => allTimeRate(habit.completions),               [habit.completions]);

  return (
    <>
      <div
        ref={nameRef}
        className={`cell habit-name${isEditing ? ' editing' : ''}`}
      >
        <span className="habit-name-text">{habit.name}</span>
        {editMode && (
          <button
            className="edit-icon-btn"
            onClick={() => nameRef.current && onOpenEdit(nameRef.current.getBoundingClientRect())}
            title="Edit habit"
          >
            <PencilIcon />
          </button>
        )}
      </div>

      {dates.map((d, i) => {
        const ds    = fmt(d);
        const done  = comp.has(ds);
        const skpd  = skip.has(ds);
        const faild = fail.has(ds);
        const str   = (done || skpd) ? streakAt(comp, skip, ds) : 0;
        const bg    = cellBg(str, habit.color);
        const isTd  = isCurrentDay && i === dates.length - 1;

        // Determine lean direction for skip triangles
        const prevDs = i > 0 ? fmt(dates[i - 1]) : null;
        const nextDs = i < dates.length - 1 ? fmt(dates[i + 1]) : null;
        const leftActive  = skpd && prevDs != null && (comp.has(prevDs) || skip.has(prevDs));
        const rightActive = skpd && nextDs != null && (comp.has(nextDs) || skip.has(nextDs));
        // Show left arrow if left is active; show right arrow if right is active (or neither → default right)
        const showLeft  = skpd && leftActive;
        const showRight = skpd && (rightActive || !leftActive);

        return (
          <div
            key={`${habit.id}-${i}`}
            className={`cell habit-cell${isTd ? ' today-col' : ''}${faild ? ' failed-cell' : ''}`}
            style={done ? { backgroundColor: bg } : faild ? { '--fail-color': acc } as React.CSSProperties : undefined}
            onClick={() => onToggle(habit.id, ds)}
            title={`${habit.name} — ${ds}${skpd ? ' (skipped)' : faild ? ' (failed)' : ''}`}
          >
            {showLeft  && <div className="cell-skip cell-skip-left"  style={{ background: bg }} />}
            {showRight && <div className="cell-skip cell-skip-right" style={{ background: bg }} />}
            {faild && <div className="cell-fail" />}
          </div>
        );
      })}

      {analyticsView === 0 && <>
        <div className="cell stat-cell">
          {best ? <span className="streak-badge" style={{ background: acc }}>{cur}</span>
                : <span className="stat-num">{cur || ''}</span>}
        </div>
        <div className="cell stat-cell">
          {best ? <span className="streak-badge" style={{ background: acc }}>{lon}</span>
                : <span className="stat-num">{lon || ''}</span>}
        </div>
        <div className="cell stat-cell">
          <span className="stat-num">{habit.completions.length}</span>
        </div>
      </>}

      {analyticsView === 1 && <>
        <div className="cell stat-cell"><span className="stat-num">{wkCnt}</span></div>
        <div className="cell stat-cell"><span className="stat-num">{moCnt}</span></div>
        <div className="cell stat-cell"><span className="stat-num">{allCnt}</span></div>
      </>}

      {analyticsView === 2 && <>
        <div className="cell stat-cell">
          <span className="stat-rate" style={{ color: rateColor(wkRate, acc) }}>{wkRate}%</span>
        </div>
        <div className="cell stat-cell">
          <span className="stat-rate" style={{ color: rateColor(moRate, acc) }}>{moRate}%</span>
        </div>
        <div className="cell stat-cell">
          <span className="stat-rate" style={{ color: rateColor(allRate, acc) }}>{allRate}%</span>
        </div>
      </>}
    </>
  );
});

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [habits,         setHabits]         = useState<Habit[]>(loadHabits);
  const [offset,         setOffset]         = useState(0);
  const [adding,         setAdding]         = useState(false);
  const [newName,        setNewName]        = useState('');
  const [newColor,       setNewColor]       = useState<HabitColor>('green');
  const [editMode,       setEditMode]       = useState(false);
  const [editingId,      setEditingId]      = useState<string | null>(null);
  const [editAnchorRect, setEditAnchorRect] = useState<DOMRect | null>(null);
  const [analyticsView,  setAnalyticsView]  = useState<0 | 1 | 2>(0);
  const [syncStatus,     setSyncStatus]     = useState<'idle'|'syncing'|'synced'|'error'>('idle');
  const addInputRef  = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const syncTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstLoad  = useRef(true);
  // Always holds the latest habits so mount-effect closures can read current value
  const habitsRef    = useRef<Habit[]>(habits);

  const vw     = useViewportWidth();
  const layout = useMemo(() => getLayout(vw), [vw]);

  const dates        = useMemo(() => getVisibleDates(offset, layout.daysBack), [offset, layout.daysBack]);
  const isCurrentDay = offset === 0;

  // Persist locally + debounce cloud push
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(habits));

    // Skip the very first render (initial load) to avoid overwriting remote
    // with stale local data before we've had a chance to fetch remote.
    if (isFirstLoad.current) return;

    if (!isSyncConfigured()) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    setSyncStatus('syncing');
    syncTimer.current = setTimeout(() => {
      pushRemote(habits)
        .then(() => setSyncStatus('synced'))
        .catch(() => setSyncStatus('error'));
    }, 1500);
  }, [habits]);

  // Keep ref in sync so mount effect can read latest habits without stale closure
  useEffect(() => { habitsRef.current = habits; }, [habits]);

  // On mount: pull from cloud and override local if remote has data.
  // If the bin contains unexpected/invalid data (e.g. 1), automatically
  // push the current local habits to initialise it — no manual fix needed.
  useEffect(() => {
    if (!isSyncConfigured()) return;
    setSyncStatus('syncing');
    fetchRemote<unknown>()
      .then(remote => {
        const clean = sanitizeAll(remote);
        if (clean.length > 0) {
          setHabits(clean);
        } else if (remote !== null) {
          // Bin exists but has bad/empty content — push local data to fix it
          pushRemote(habitsRef.current).catch(() => {/* best-effort */});
        }
        setSyncStatus('synced');
      })
      .catch(() => setSyncStatus('error'))
      .finally(() => { isFirstLoad.current = false; });
  }, []);

  useEffect(() => { if (adding) addInputRef.current?.focus(); }, [adding]);

  // Cycle: empty → done → skip → fail → empty
  const toggle = useCallback((id: string, ds: string) => {
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h;
      const done = h.completions.includes(ds);
      const skpd = h.skips.includes(ds);
      const fail = h.fails.includes(ds);
      if (!done && !skpd && !fail)
        // empty → done
        return { ...h, completions: [...h.completions, ds] };
      if (done) {
        // done → skip (unless that would create 3+ consecutive skips → go to fail instead)
        if (wouldExceedSkipRun(h.skips, ds, 2))
          return { ...h, completions: h.completions.filter(c => c !== ds), fails: [...h.fails, ds] };
        return { ...h, completions: h.completions.filter(c => c !== ds), skips: [...h.skips, ds] };
      }
      if (skpd)
        // skip → fail
        return { ...h, skips: h.skips.filter(s => s !== ds), fails: [...h.fails, ds] };
      // fail → empty
      return { ...h, fails: h.fails.filter(f => f !== ds) };
    }));
  }, []);

  const addHabit = useCallback(() => {
    const name = newName.trim();
    if (!name) return;
    setHabits(prev => [...prev, { id: `h-${Date.now()}`, name, color: newColor, completions: [], skips: [], fails: [] }]);
    setNewName(''); setNewColor('green'); setAdding(false);
  }, [newName, newColor]);

  const saveEdit = useCallback((name: string, color: HabitColor) => {
    setHabits(prev => prev.map(h => h.id === editingId ? { ...h, name, color } : h));
    setEditingId(null); setEditAnchorRect(null);
  }, [editingId]);

  const deleteHabit = useCallback(() => {
    if (!window.confirm('Delete this habit?')) return;
    setHabits(prev => prev.filter(h => h.id !== editingId));
    setEditingId(null); setEditAnchorRect(null);
  }, [editingId]);

  const moveHabit = useCallback((dir: -1 | 1) => {
    setHabits(prev => {
      const idx = prev.findIndex(h => h.id === editingId);
      if (idx < 0) return prev;
      const next = idx + dir;
      if (next < 0 || next >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      return arr;
    });
    // Shift the anchor rect by one row height so the panel follows
    setEditAnchorRect(r => r ? new DOMRect(r.x, r.y + dir * layout.rowH, r.width, r.height) : r);
  }, [editingId, layout.rowH]);

  const cancelEdit = useCallback(() => {
    setEditingId(null); setEditAnchorRect(null);
  }, []);

  const openEdit = useCallback((id: string, rect: DOMRect) => {
    setEditingId(id); setEditAnchorRect(rect);
  }, []);

  const totalScore = useMemo(() => habits.reduce((s, h) => s + h.completions.length, 0), [habits]);
  const dailyCount = useCallback((ds: string) => habits.filter(h => h.completions.includes(ds)).length, [habits]);

  const { wName, wDay, wToday, wStat, daysBack, rowH, isMobile } = layout;
  const gridCols = isCurrentDay
    ? `${wName}px repeat(${daysBack}, ${wDay}px) ${wToday}px repeat(3, ${wStat}px)`
    : `${wName}px repeat(${daysBack + 1}, ${wDay}px) repeat(3, ${wStat}px)`;

  // Export / import for cross-device data transfer
  const exportData = useCallback(() => {
    const blob = new Blob([JSON.stringify(habits, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `everyday-${fmt(todayNoon())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [habits]);

  const importData = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const parsed = JSON.parse(e.target?.result as string);
        const clean  = sanitizeAll(parsed);
        if (clean.length === 0) throw new Error('No valid habits found in this file.');
        const ok = window.confirm(`Replace your current data with ${clean.length} habits from this file?`);
        if (ok) setHabits(clean);
      } catch {
        alert('Could not read this file. Make sure it\'s a valid Everyday export.');
      }
    };
    reader.readAsText(file);
  }, []);

  const editingHabit = editingId ? habits.find(h => h.id === editingId) : null;
  const editingIdx   = editingId ? habits.findIndex(h => h.id === editingId) : -1;

  return (
    <div className={`app${isMobile ? ' mobile' : ''}`} style={{ '--row-h': `${rowH}px` } as React.CSSProperties}>
      {/* ── App bar ── */}
      <header className="appbar">
        <div className="logo">
          <LogoMark />
          <span className="logo-text">everyday</span>
        </div>
        <div className="nav-group">
          <button className="nav-btn" onClick={() => setOffset(o => o + 1)}>‹</button>
          <button className="nav-btn" onClick={() => setOffset(o => Math.max(0, o - 1))} disabled={offset === 0}>›</button>
        </div>
        <div className="user-bar">
          <button className="data-btn" onClick={exportData} title="Export your habits">
            <DownloadIcon />
          </button>
          <button className="data-btn" onClick={() => fileInputRef.current?.click()} title="Import habits from file">
            <UploadIcon />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) importData(f);
              e.target.value = '';
            }}
          />
          {isSyncConfigured() && (
            <span className={`sync-dot sync-${syncStatus}`} title={
              syncStatus === 'syncing' ? 'Syncing…' :
              syncStatus === 'synced'  ? 'Saved to cloud' :
              syncStatus === 'error'   ? 'Sync failed' : ''
            } />
          )}
          <TrophyIcon />
          <span className="score">{totalScore}</span>
          {!isMobile && <span className="username">Kevin ▾</span>}
        </div>
      </header>

      {/* ── Board ── */}
      <div className="board-scroll">
        <div className="board-center">
          <div className="board" style={{ gridTemplateColumns: gridCols }}>

            {/* ─ Header ─ */}
            <div className="cell ch habits-header">
              <span className="habits-label">HABITS</span>
              <button
                className={`edit-mode-btn${editMode ? ' active' : ''}`}
                onClick={() => { setEditMode(m => !m); cancelEdit(); }}
                title={editMode ? 'Done editing' : 'Edit habits'}
              >
                <SlidersIcon />
              </button>
            </div>

            {dates.map((d, i) => {
              const isTd = isCurrentDay && i === dates.length - 1;
              return (
                <div key={`dh-${i}`} className={`cell ch date-header${isTd ? ' today-header' : ''}`}>
                  <span className="d-month">{MONTHS[d.getMonth()]}</span>
                  {isTd ? <span className="today-circle">{d.getDate()}</span>
                        : <span className="d-num">{d.getDate()}</span>}
                  <span className="d-day">{DAYS[d.getDay()]}</span>
                </div>
              );
            })}

            {STAT_HEADERS[analyticsView].map((h, i) => (
              <div key={i} className="cell ch stat-header">
                {h.split('\n').map((line, j) => (
                  <span key={j}>{line}{j < h.split('\n').length - 1 && <br />}</span>
                ))}
              </div>
            ))}

            {/* ─ Habit rows ─ */}
            {habits.map(habit => (
              <HabitRow
                key={habit.id}
                habit={habit}
                dates={dates}
                isCurrentDay={isCurrentDay}
                onToggle={toggle}
                editMode={editMode}
                isEditing={editingId === habit.id}
                onOpenEdit={rect => openEdit(habit.id, rect)}
                analyticsView={analyticsView}
              />
            ))}

            {/* ─ Footer ─ */}
            <div className="cell footer-name">
              {adding ? (
                <div className="add-form">
                  <input
                    ref={addInputRef}
                    className="add-input"
                    placeholder="Habit name…"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') addHabit();
                      if (e.key === 'Escape') { setAdding(false); setNewName(''); }
                    }}
                  />
                  <div className="color-row">
                    {HABIT_COLORS.map(c => (
                      <button key={c} className={`swatch${newColor === c ? ' active' : ''}`}
                        style={{ backgroundColor: COLOR_PALETTES[c][4] }}
                        onClick={() => setNewColor(c)} />
                    ))}
                  </div>
                  <div className="add-actions">
                    <button className="btn-save" onClick={addHabit}>Add</button>
                    <button className="btn-cancel" onClick={() => { setAdding(false); setNewName(''); }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button className="add-btn" onClick={() => setAdding(true)}>
                  <span className="add-plus">+</span> New Habit
                </button>
              )}
            </div>

            {dates.map((d, i) => {
              const isTd = isCurrentDay && i === dates.length - 1;
              const count = dailyCount(fmt(d));
              return (
                <div key={`fc-${i}`} className={`cell footer-count${isTd ? ' today-col' : ''}`}>
                  {count > 0 ? count : ''}
                </div>
              );
            })}

            <div className="cell footer-progress" style={{ gridColumn: 'span 3' }}>
              <input
                type="range"
                className="analytics-slider"
                min={0} max={2} step={1}
                value={analyticsView}
                onChange={e => setAnalyticsView(Number(e.target.value) as 0 | 1 | 2)}
                title={['Streaks & totals', 'Period counts', 'Completion rates'][analyticsView]}
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Edit Panel (portal, never clipped by overflow) ── */}
      {editingHabit && editAnchorRect && (
        <EditPanel
          habit={editingHabit}
          anchorRect={editAnchorRect}
          isFirst={editingIdx === 0}
          isLast={editingIdx === habits.length - 1}
          onSave={saveEdit}
          onCancel={cancelEdit}
          onDelete={deleteHabit}
          onMoveUp={() => moveHabit(-1)}
          onMoveDown={() => moveHabit(1)}
        />
      )}
    </div>
  );
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function LogoMark() {
  return (
    <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
      <rect width="30" height="30" rx="7" fill="#4ade80"/>
      <rect x="6" y="6" width="18" height="18" rx="4" fill="#16a34a"/>
      <rect x="11" y="11" width="8" height="8" rx="2" fill="#14532d"/>
    </svg>
  );
}
function TrophyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="#ca8a04" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/>
      <path d="M4 22h16"/>
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/>
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/>
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
      <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
    </svg>
  );
}
function SlidersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
      <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
      <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
      <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>
      <line x1="17" y1="16" x2="23" y2="16"/>
    </svg>
  );
}
function ArrowUpIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5 12l7-7 7 7"/>
    </svg>
  );
}
function ArrowDownIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M19 12l-7 7-7-7"/>
    </svg>
  );
}
function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/>
      <line x1="12" y1="15" x2="12" y2="3"/>
    </svg>
  );
}
function UploadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  );
}
