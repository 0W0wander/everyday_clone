import {
  useState, useEffect, useCallback, useMemo, useRef, memo,
} from 'react';
import { createPortal } from 'react-dom';
import './App.css';
import type { Habit, HabitColor } from './types';

// ─── Palettes ────────────────────────────────────────────────────────────────

const COLOR_PALETTES: Record<HabitColor, string[]> = {
  green:  ['#d1fae5','#a7f3d0','#6ee7b7','#34d399','#10b981','#059669','#047857','#064e3b'],
  blue:   ['#dbeafe','#bfdbfe','#93c5fd','#60a5fa','#3b82f6','#2563eb','#1d4ed8','#1e3a8a'],
  yellow: ['#fef9c3','#fef08a','#fde047','#facc15','#eab308','#ca8a04','#a16207','#713f12'],
  orange: ['#ffedd5','#fed7aa','#fdba74','#fb923c','#f97316','#ea580c','#c2410c','#7c2d12'],
  red:    ['#fee2e2','#fecaca','#fca5a5','#f87171','#ef4444','#dc2626','#b91c1c','#7f1d1d'],
  purple: ['#f3e8ff','#e9d5ff','#d8b4fe','#c084fc','#a855f7','#9333ea','#7e22ce','#4a1d96'],
  teal:   ['#ccfbf1','#99f6e4','#5eead4','#2dd4bf','#14b8a6','#0d9488','#0f766e','#134e4a'],
};

const COLOR_ACCENT: Record<HabitColor, string> = {
  green:  '#16a34a', blue:   '#2563eb', yellow: '#ca8a04',
  orange: '#ea580c', red:    '#dc2626', purple: '#9333ea', teal:   '#0d9488',
};

const MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS        = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
const HABIT_COLORS: HabitColor[] = ['green','blue','yellow','orange','red','purple','teal'];
const DAYS_BACK   = 13;
const STORAGE_KEY = 'everyday-habits-v2';

const W_NAME  = 162;
const W_DAY   = 46;
const W_TODAY = 90;
const W_STAT  = 52; // narrower — matches real app's compact stats panel

// ─── Analytics helpers ────────────────────────────────────────────────────────

function countInDays(completions: string[], days: number): number {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(12, 0, 0, 0);
  const cutStr = fmt(cutoff);
  return completions.filter(d => d >= cutStr).length;
}

function rateInDays(completions: string[], days: number): number {
  return Math.round((countInDays(completions, days) / days) * 100);
}

function rateColor(rate: number, accent: string): string {
  if (rate >= 50) return accent;
  if (rate >= 25) return '#f59e0b';
  return '#ef4444';
}

const STAT_HEADERS: [string, string, string][] = [
  ['current\nstreak', 'longest\nstreak', 'total\ncount'],
  ['week\ncount',     'month\ncount',    'year\ncount'],
  ['week\ncompl.\nrate', 'month\ncompl.\nrate', 'year\ncompl.\nrate'],
];

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayNoon(): Date {
  const d = new Date(); d.setHours(12, 0, 0, 0); return d;
}
function fmt(d: Date): string { return d.toISOString().split('T')[0]; }

function getVisibleDates(offset: number): Date[] {
  const base = todayNoon();
  return Array.from({ length: DAYS_BACK + 1 }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() - (DAYS_BACK - i) - offset);
    return d;
  });
}

// ─── Streak helpers ───────────────────────────────────────────────────────────

function streakAt(comp: Set<string>, skip: Set<string>, ds: string): number {
  if (!comp.has(ds) && !skip.has(ds)) return 0;
  let n = 1;
  const d = new Date(ds + 'T12:00:00');
  for (;;) {
    d.setDate(d.getDate() - 1);
    const s = fmt(d);
    if (comp.has(s) || skip.has(s)) n++; else break;
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
  const all = [...new Set([...completions, ...skips])].sort();
  if (!all.length) return 0;
  let max = 1, cur = 1;
  for (let i = 1; i < all.length; i++) {
    const diff = Math.round(
      (new Date(all[i] + 'T12:00:00').getTime() -
       new Date(all[i-1] + 'T12:00:00').getTime()) / 86400000
    );
    if (diff === 1) { cur++; max = Math.max(max, cur); } else cur = 1;
  }
  return max;
}

function intensityIdx(s: number): number {
  if (s <= 1) return 0; if (s <= 2) return 1; if (s <= 4) return 2;
  if (s <= 7) return 3; if (s <= 11) return 4; if (s <= 16) return 5;
  if (s <= 22) return 6; return 7;
}
function cellBg(streak: number, color: HabitColor): string {
  return streak === 0 ? '' : COLOR_PALETTES[color][intensityIdx(streak)];
}

// ─── Demo data ────────────────────────────────────────────────────────────────

function generateDemo(): Habit[] {
  return []; // start fresh — no sample data
}

function loadHabits(): Habit[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return (JSON.parse(raw) as Habit[]).map(h => ({ ...h, skips: h.skips ?? [] }));
  } catch { /* noop */ }
  return generateDemo();
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
  const cur  = useMemo(() => calcCurrentStreak(habit.completions, habit.skips),  [habit.completions, habit.skips]);
  const lon  = useMemo(() => calcLongestStreak(habit.completions, habit.skips),  [habit.completions, habit.skips]);
  const best = cur > 0 && cur >= lon;
  const acc  = COLOR_ACCENT[habit.color];

  // Analytics view 1 — counts
  const wkCnt = useMemo(() => countInDays(habit.completions, 7),   [habit.completions]);
  const moCnt = useMemo(() => countInDays(habit.completions, 30),  [habit.completions]);
  const yrCnt = useMemo(() => countInDays(habit.completions, 365), [habit.completions]);
  // Analytics view 2 — completion rates
  const wkRate = useMemo(() => rateInDays(habit.completions, 7),   [habit.completions]);
  const moRate = useMemo(() => rateInDays(habit.completions, 30),  [habit.completions]);
  const yrRate = useMemo(() => rateInDays(habit.completions, 365), [habit.completions]);

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
        const str   = (done || skpd) ? streakAt(comp, skip, ds) : 0;
        const bg    = cellBg(str, habit.color);
        const isTd  = isCurrentDay && i === dates.length - 1;

        return (
          <div
            key={`${habit.id}-${i}`}
            className={`cell habit-cell${isTd ? ' today-col' : ''}`}
            style={done ? { backgroundColor: bg } : undefined}
            onClick={() => onToggle(habit.id, ds)}
            title={`${habit.name} — ${ds}${skpd ? ' (skipped)' : ''}`}
          >
            {skpd && <div className="cell-skip" style={{ background: bg }} />}
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
        <div className="cell stat-cell"><span className="stat-num">{yrCnt}</span></div>
      </>}

      {analyticsView === 2 && <>
        <div className="cell stat-cell">
          <span className="stat-rate" style={{ color: rateColor(wkRate, acc) }}>{wkRate}%</span>
        </div>
        <div className="cell stat-cell">
          <span className="stat-rate" style={{ color: rateColor(moRate, acc) }}>{moRate}%</span>
        </div>
        <div className="cell stat-cell">
          <span className="stat-rate" style={{ color: rateColor(yrRate, acc) }}>{yrRate}%</span>
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
  const addInputRef = useRef<HTMLInputElement>(null);

  const dates        = useMemo(() => getVisibleDates(offset), [offset]);
  const isCurrentDay = offset === 0;

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(habits)); }, [habits]);
  useEffect(() => { if (adding) addInputRef.current?.focus(); }, [adding]);

  const toggle = useCallback((id: string, ds: string) => {
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h;
      if (!h.completions.includes(ds) && !h.skips.includes(ds))
        return { ...h, completions: [...h.completions, ds] };
      if (h.completions.includes(ds))
        return { ...h, completions: h.completions.filter(c => c !== ds), skips: [...h.skips, ds] };
      return { ...h, skips: h.skips.filter(s => s !== ds) };
    }));
  }, []);

  const addHabit = useCallback(() => {
    const name = newName.trim();
    if (!name) return;
    setHabits(prev => [...prev, { id: `h-${Date.now()}`, name, color: newColor, completions: [], skips: [] }]);
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
    setEditAnchorRect(r => r ? new DOMRect(r.x, r.y + dir * 38, r.width, r.height) : r);
  }, [editingId]);

  const cancelEdit = useCallback(() => {
    setEditingId(null); setEditAnchorRect(null);
  }, []);

  const openEdit = useCallback((id: string, rect: DOMRect) => {
    setEditingId(id); setEditAnchorRect(rect);
  }, []);

  const totalScore = useMemo(() => habits.reduce((s, h) => s + h.completions.length, 0), [habits]);
  const dailyCount = useCallback((ds: string) => habits.filter(h => h.completions.includes(ds)).length, [habits]);

  const gridCols = isCurrentDay
    ? `${W_NAME}px repeat(${DAYS_BACK}, ${W_DAY}px) ${W_TODAY}px repeat(3, ${W_STAT}px)`
    : `${W_NAME}px repeat(${DAYS_BACK + 1}, ${W_DAY}px) repeat(3, ${W_STAT}px)`;

  const editingHabit = editingId ? habits.find(h => h.id === editingId) : null;
  const editingIdx   = editingId ? habits.findIndex(h => h.id === editingId) : -1;

  return (
    <div className="app">
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
          <TrophyIcon />
          <span className="score">{totalScore}</span>
          <span className="username">Kevin ▾</span>
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
