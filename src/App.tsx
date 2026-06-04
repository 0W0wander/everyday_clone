import {
  useState, useEffect, useCallback, useMemo, useRef, memo,
} from 'react';
import { createPortal } from 'react-dom';
import './App.css';
import type { Habit, HabitColor } from './types';
import { fetchRemote, pushRemote, isSyncConfigured } from './sync';

// ─── Color utilities ──────────────────────────────────────────────────────────

// Backward-compat: map the 7 legacy named colors → their hex equivalents
const LEGACY_COLOR_HEX: Record<string, string> = {
  green:  '#4ade80', blue:   '#60a5fa', yellow: '#facc15',
  orange: '#fb923c', red:    '#fb7185', purple: '#d946ef', teal:   '#2dd4bf',
};
const DEFAULT_COLOR = '#4ade80';

// #rrggbb (or #rgb) → [H 0-360, S 0-100, L 0-100]
function hexToHsl(hex: string): [number, number, number] {
  const raw = hex.replace('#', '');
  const full = raw.length === 3
    ? raw.split('').map(c => c + c).join('')
    : raw.padEnd(6, '0').slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    case b: h = ((r - g) / d + 4) / 6; break;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}

// Build an 8-step palette: pale tint at index 0, vivid at index 7
function generatePalette(hex: string): string[] {
  const [h, s] = hexToHsl(hex);
  const sat = Math.max(s, 65); // ensure enough chroma for the vivid end
  return [
    `hsl(${h},${Math.round(sat * 0.12)}%,97%)`,
    `hsl(${h},${Math.round(sat * 0.28)}%,92%)`,
    `hsl(${h},${Math.round(sat * 0.50)}%,85%)`,
    `hsl(${h},${Math.round(sat * 0.65)}%,76%)`,
    `hsl(${h},${Math.round(sat * 0.78)}%,65%)`,
    `hsl(${h},${Math.round(sat * 0.90)}%,54%)`,
    `hsl(${h},${sat}%,43%)`,
    `hsl(${h},${Math.min(sat + 8, 100)}%,55%)`,
  ];
}

function generateAccent(hex: string): string {
  const [h, s] = hexToHsl(hex);
  return `hsl(${h},${Math.max(s, 80)}%,38%)`;
}

// Module-level memoisation so we don't re-derive every render
const _palettes = new Map<string, string[]>();
const _accents  = new Map<string, string>();
function getPalette(hex: string): string[] {
  if (!_palettes.has(hex)) _palettes.set(hex, generatePalette(hex));
  return _palettes.get(hex)!;
}
function getAccent(hex: string): string {
  if (!_accents.has(hex)) _accents.set(hex, generateAccent(hex));
  return _accents.get(hex)!;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS        = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
const STORAGE_KEY = 'everyday-habits-v2';

// ─── Responsive layout ────────────────────────────────────────────────────────

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

function startOfWeek(): string {
  const d = new Date(); d.setHours(12, 0, 0, 0);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
  return fmt(d);
}
function startOfMonth(): string {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(1);
  return fmt(d);
}

function countFrom(completions: string[], fromDate: string): number {
  return completions.filter(d => d >= fromDate).length;
}

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
      // skip is transparent — no increment
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
    }
  }
  return Math.max(max, cur);
}

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
function cellBg(streak: number, color: string): string {
  return streak === 0 ? '' : getPalette(color)[intensityIdx(streak)];
}

// ─── Data sanitisation ────────────────────────────────────────────────────────

function sanitize(h: Partial<Habit>): Habit {
  let color = DEFAULT_COLOR;
  if (typeof h.color === 'string') {
    if (h.color in LEGACY_COLOR_HEX) {
      color = LEGACY_COLOR_HEX[h.color];           // migrate old named colors
    } else if (/^#[0-9a-fA-F]{3,8}$/.test(h.color)) {
      color = h.color;                              // valid hex
    }
  }
  return {
    id:          typeof h.id   === 'string' ? h.id   : `h-${Date.now()}-${Math.random()}`,
    name:        typeof h.name === 'string' ? h.name : 'New Habit',
    color,
    completions: Array.isArray(h.completions) ? h.completions.filter(d => typeof d === 'string') : [],
    skips:       Array.isArray(h.skips)       ? h.skips.filter(d => typeof d === 'string')       : [],
    fails:       Array.isArray(h.fails)       ? h.fails.filter(d => typeof d === 'string')       : [],
    isBreak:  !!h.isBreak,
    archived: !!h.archived,
    comments: (h.comments && typeof h.comments === 'object' && !Array.isArray(h.comments))
      ? Object.fromEntries(
          Object.entries(h.comments as Record<string, unknown>)
            .filter(([k, v]) => typeof k === 'string' && typeof v === 'string')
            .map(([k, v]) => [k, v as string])
        )
      : {},
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

// ─── ArchivePanel ─────────────────────────────────────────────────────────────

interface ArchivePanelProps {
  archivedHabits: Habit[];
  onRestore: (id: string) => void;
  onDelete:  (id: string) => void;
  onClose:   () => void;
}

function ArchivePanel({ archivedHabits, onRestore, onDelete, onClose }: ArchivePanelProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return createPortal(
    <div className="archive-overlay" onClick={onClose}>
      <div className="archive-panel" onClick={e => e.stopPropagation()}>
        <div className="archive-panel-header">
          <div className="archive-panel-title-group">
            <BoxArchiveIcon />
            <span className="archive-panel-title">Archived Habits</span>
          </div>
          <button className="archive-close-btn" onClick={onClose}>✕</button>
        </div>
        {archivedHabits.length === 0 ? (
          <p className="archive-empty">No archived habits yet.</p>
        ) : (
          <ul className="archive-list">
            {archivedHabits.map(h => (
              <li key={h.id} className="archive-item">
                <div
                  className="archive-color-dot"
                  style={{ backgroundColor: getPalette(h.color)[5] }}
                />
                <span className="archive-item-name">{h.name}</span>
                <button className="btn-restore" onClick={() => onRestore(h.id)}>
                  Restore
                </button>
                <button
                  className="btn-delete-perm"
                  onClick={() => onDelete(h.id)}
                  title="Delete permanently"
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ─── CommentPopover ───────────────────────────────────────────────────────────

interface CommentPopoverProps {
  habitName: string;
  ds: string;
  existing: string;
  anchorRect: DOMRect;
  onSave:  (text: string) => void;
  onClose: () => void;
}

function CommentPopover({ habitName, ds, existing, anchorRect, onSave, onClose }: CommentPopoverProps) {
  const [text, setText] = useState(existing);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const panelRef    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    if (existing) textareaRef.current?.select();
  }, [existing]);

  // Auto-save on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onSave(text);
      }
    };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 80);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler); };
  }, [text, onSave]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSave(text); }
  };

  // Position below cell, clamped to viewport width
  const top  = anchorRect.bottom + window.scrollY + 6;
  const rawLeft = anchorRect.left + window.scrollX;
  const left = Math.min(rawLeft, window.innerWidth - 272 - 12);

  // Format date nicely for the header
  const [y, m, d] = ds.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const label = `${months[parseInt(m) - 1]} ${parseInt(d)}, ${y}`;

  return createPortal(
    <div ref={panelRef} className="comment-popover" style={{ top, left }}>
      <div className="comment-popover-header">
        <span className="comment-popover-habit">{habitName}</span>
        <span className="comment-popover-date">{label}</span>
      </div>
      <textarea
        ref={textareaRef}
        className="comment-textarea"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="How did it go? Add a note… (Enter to save, Shift+Enter for new line)"
        rows={3}
      />
      <div className="comment-popover-actions">
        <button className="btn-save" onClick={() => onSave(text)}>Save</button>
        <button className="btn-cancel" onClick={onClose}>Cancel</button>
        {text.trim() && (
          <button className="btn-clear-comment" onClick={() => onSave('')} title="Remove note">
            Clear
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ─── EditPanel — rendered via portal so it's never clipped ───────────────────

interface EditPanelProps {
  habit: Habit;
  anchorRect: DOMRect;
  isFirst: boolean;
  isLast: boolean;
  onSave:     (name: string, color: HabitColor) => void;
  onCancel:   () => void;
  onDelete:   () => void;
  onArchive:  () => void;
  onMoveUp:   () => void;
  onMoveDown: () => void;
}

function EditPanel({ habit, anchorRect, isFirst, isLast,
  onSave, onCancel, onDelete, onArchive, onMoveUp, onMoveDown }: EditPanelProps) {

  const [name,  setName]  = useState(habit.name);
  const [color, setColor] = useState<string>(habit.color);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 80);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler); };
  }, [onCancel]);

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
      <div className="color-pick-row">
        <label className="color-picker-label" title="Pick a color">
          <div className="color-picker-disc" style={{ background: color }} />
          <input
            type="color"
            value={color}
            onChange={e => setColor(e.target.value)}
          />
          <span className="color-picker-text">Choose color</span>
          <ColorWheelIcon />
        </label>
        <div className="color-preview-strip">
          {getPalette(color).map((c, i) => (
            <div key={i} className="color-strip-step" style={{ background: c }} />
          ))}
        </div>
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
        <button className="btn-archive" onClick={onArchive} title="Archive habit">
          <ArchiveIcon />
        </button>
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
  onToggle:         (id: string, ds: string) => void;
  onRightClick:     (id: string, ds: string, rect: DOMRect) => void;
  onCommentHover:   (text: string, ds: string, rect: DOMRect) => void;
  onCommentLeave:   () => void;
  editMode: boolean;
  isEditing: boolean;
  onOpenEdit: (rect: DOMRect) => void;
  analyticsView: 0 | 1 | 2;
}

const HabitRow = memo(function HabitRow(
  { habit, dates, isCurrentDay, onToggle, onRightClick, onCommentHover, onCommentLeave,
    editMode, isEditing, onOpenEdit, analyticsView }: RowProps
) {
  const nameRef = useRef<HTMLDivElement>(null);
  const comp = useMemo(() => new Set(habit.completions), [habit.completions]);
  const skip = useMemo(() => new Set(habit.skips),       [habit.skips]);
  const fail = useMemo(() => new Set(habit.fails),       [habit.fails]);
  const cur  = useMemo(() => calcCurrentStreak(habit.completions, habit.skips),  [habit.completions, habit.skips]);
  const lon  = useMemo(() => calcLongestStreak(habit.completions, habit.skips),  [habit.completions, habit.skips]);
  const best = cur > 0 && cur >= lon;
  const acc  = getAccent(habit.color);

  const wkCnt  = useMemo(() => countFrom(habit.completions, startOfWeek()),  [habit.completions]);
  const moCnt  = useMemo(() => countFrom(habit.completions, startOfMonth()), [habit.completions]);
  const allCnt = useMemo(() => habit.completions.length,                     [habit.completions]);
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

        const prevDs = i > 0 ? fmt(dates[i - 1]) : null;
        const nextDs = i < dates.length - 1 ? fmt(dates[i + 1]) : null;
        const leftActive  = skpd && prevDs != null && (comp.has(prevDs) || skip.has(prevDs));
        const rightActive = skpd && nextDs != null && (comp.has(nextDs) || skip.has(nextDs));
        const showLeft  = skpd && leftActive;
        const showRight = skpd && (rightActive || !leftActive);

        const comment = habit.comments?.[ds];
        const hasComment = !!comment;

        return (
          <div
            key={`${habit.id}-${i}`}
            className={`cell habit-cell${isTd ? ' today-col' : ''}${faild ? ' failed-cell' : ''}${hasComment ? ' has-comment' : ''}`}
            style={done ? { backgroundColor: bg } : faild ? { '--fail-color': acc } as React.CSSProperties : undefined}
            onClick={() => onToggle(habit.id, ds)}
            onContextMenu={e => {
              e.preventDefault();
              onRightClick(habit.id, ds, (e.currentTarget as HTMLElement).getBoundingClientRect());
            }}
            onMouseEnter={e => {
              if (hasComment) {
                onCommentHover(comment!, ds, (e.currentTarget as HTMLElement).getBoundingClientRect());
              }
            }}
            onMouseLeave={onCommentLeave}
          >
            {showLeft  && <div className="cell-skip cell-skip-left"  style={{ background: bg }} />}
            {showRight && <div className="cell-skip cell-skip-right" style={{ background: bg }} />}
            {faild && <div className="cell-fail" />}
            {hasComment && (() => {
              const pal = getPalette(habit.color);
              // On colored cells: dot is 1-2 shades deeper than cell bg.
              // On empty/failed: dot is a light-mid tint of the habit color.
              const dotBg   = (done || skpd) ? pal[Math.min(intensityIdx(str) + 2, 7)] : pal[2];
              const dotRing = (done || skpd) ? pal[Math.min(intensityIdx(str) + 1, 7)] : pal[4];
              return (
                <div
                  className="comment-dot"
                  style={{ background: dotBg, boxShadow: `0 0 0 1.5px ${dotRing}` }}
                />
              );
            })()}
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
  const [newColor,       setNewColor]       = useState<string>(DEFAULT_COLOR);
  const [editMode,       setEditMode]       = useState(false);
  const [editingId,      setEditingId]      = useState<string | null>(null);
  const [editAnchorRect, setEditAnchorRect] = useState<DOMRect | null>(null);
  const [analyticsView,  setAnalyticsView]  = useState<0 | 1 | 2>(0);
  const [syncStatus,     setSyncStatus]     = useState<'idle'|'syncing'|'synced'|'error'>('idle');
  const [showArchive,    setShowArchive]    = useState(false);
  const [commentTarget,  setCommentTarget]  = useState<{ id: string; ds: string; rect: DOMRect } | null>(null);
  const [commentTooltip, setCommentTooltip] = useState<{ text: string; ds: string; rect: DOMRect } | null>(null);
  const addInputRef  = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const syncTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstLoad  = useRef(true);
  const habitsRef    = useRef<Habit[]>(habits);

  const vw     = useViewportWidth();
  const layout = useMemo(() => getLayout(vw), [vw]);

  const dates        = useMemo(() => getVisibleDates(offset, layout.daysBack), [offset, layout.daysBack]);
  const isCurrentDay = offset === 0;

  // Split into active (visible) and archived
  const visibleHabits  = useMemo(() => habits.filter(h => !h.archived), [habits]);
  const archivedHabits = useMemo(() => habits.filter(h =>  h.archived), [habits]);

  // Persist locally + debounce cloud push
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(habits));
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

  useEffect(() => { habitsRef.current = habits; }, [habits]);

  useEffect(() => {
    if (!isSyncConfigured()) return;
    setSyncStatus('syncing');
    fetchRemote<unknown>()
      .then(remote => {
        const clean = sanitizeAll(remote);
        if (clean.length > 0) {
          setHabits(clean);
        } else if (remote !== null) {
          pushRemote(habitsRef.current).catch(() => {});
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
        return { ...h, completions: [...h.completions, ds] };
      if (done) {
        if (wouldExceedSkipRun(h.skips, ds, 2))
          return { ...h, completions: h.completions.filter(c => c !== ds), fails: [...h.fails, ds] };
        return { ...h, completions: h.completions.filter(c => c !== ds), skips: [...h.skips, ds] };
      }
      if (skpd)
        return { ...h, skips: h.skips.filter(s => s !== ds), fails: [...h.fails, ds] };
      return { ...h, fails: h.fails.filter(f => f !== ds) };
    }));
  }, []);

  const addHabit = useCallback(() => {
    const name = newName.trim();
    if (!name) return;
    setHabits(prev => [...prev, {
      id: `h-${Date.now()}`, name, color: newColor,
      completions: [], skips: [], fails: [],
    }]);
    setNewName(''); setNewColor(DEFAULT_COLOR); setAdding(false);
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

  const archiveHabit = useCallback(() => {
    setHabits(prev => prev.map(h => h.id === editingId ? { ...h, archived: true } : h));
    setEditingId(null); setEditAnchorRect(null);
  }, [editingId]);

  const restoreHabit = useCallback((id: string) => {
    setHabits(prev => prev.map(h => h.id === id ? { ...h, archived: false } : h));
  }, []);

  const deleteArchivedHabit = useCallback((id: string) => {
    if (!window.confirm('Permanently delete this habit and all its data?')) return;
    setHabits(prev => prev.filter(h => h.id !== id));
  }, []);

  // Move operates within visible (non-archived) habits, but swaps in the full array
  const moveHabit = useCallback((dir: -1 | 1) => {
    setHabits(prev => {
      const visible = prev.filter(h => !h.archived);
      const visIdx = visible.findIndex(h => h.id === editingId);
      if (visIdx < 0) return prev;
      const nextVisIdx = visIdx + dir;
      if (nextVisIdx < 0 || nextVisIdx >= visible.length) return prev;
      const idxA = prev.findIndex(h => h.id === visible[visIdx].id);
      const idxB = prev.findIndex(h => h.id === visible[nextVisIdx].id);
      const arr = [...prev];
      [arr[idxA], arr[idxB]] = [arr[idxB], arr[idxA]];
      return arr;
    });
    setEditAnchorRect(r => r ? new DOMRect(r.x, r.y + dir * layout.rowH, r.width, r.height) : r);
  }, [editingId, layout.rowH]);

  const cancelEdit = useCallback(() => {
    setEditingId(null); setEditAnchorRect(null);
  }, []);

  const openEdit = useCallback((id: string, rect: DOMRect) => {
    setEditingId(id); setEditAnchorRect(rect);
  }, []);

  const openComment = useCallback((id: string, ds: string, rect: DOMRect) => {
    setCommentTooltip(null);        // hide tooltip while editing
    setCommentTarget({ id, ds, rect });
  }, []);

  const saveComment = useCallback((text: string) => {
    if (!commentTarget) return;
    const { id, ds } = commentTarget;
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h;
      const next = { ...(h.comments ?? {}) };
      if (text.trim()) next[ds] = text.trim();
      else delete next[ds];
      return { ...h, comments: next };
    }));
    setCommentTarget(null);
  }, [commentTarget]);

  const closeComment = useCallback(() => setCommentTarget(null), []);

  const showCommentTooltip = useCallback((text: string, ds: string, rect: DOMRect) => {
    setCommentTooltip({ text, ds, rect });
  }, []);
  const hideCommentTooltip = useCallback(() => setCommentTooltip(null), []);

  const totalScore = useMemo(() => habits.reduce((s, h) => s + h.completions.length, 0), [habits]);
  const dailyCount = useCallback((ds: string) =>
    visibleHabits.filter(h => h.completions.includes(ds)).length,
  [visibleHabits]);

  const { wName, wDay, wToday, wStat, daysBack, rowH, isMobile } = layout;
  const gridCols = isCurrentDay
    ? `${wName}px repeat(${daysBack}, ${wDay}px) ${wToday}px repeat(3, ${wStat}px)`
    : `${wName}px repeat(${daysBack + 1}, ${wDay}px) repeat(3, ${wStat}px)`;

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

  const editingHabit = editingId ? visibleHabits.find(h => h.id === editingId) : null;
  const editingIdx   = editingId ? visibleHabits.findIndex(h => h.id === editingId) : -1;

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
              <div className="habits-header-actions">
                {editMode && archivedHabits.length > 0 && (
                  <button
                    className="archive-count-btn"
                    onClick={() => setShowArchive(true)}
                    title="View archived habits"
                  >
                    <BoxArchiveIcon />
                    <span>{archivedHabits.length}</span>
                  </button>
                )}
                <button
                  className={`edit-mode-btn${editMode ? ' active' : ''}`}
                  onClick={() => { setEditMode(m => !m); cancelEdit(); }}
                  title={editMode ? 'Done editing' : 'Edit habits'}
                >
                  <SlidersIcon />
                </button>
              </div>
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

            {/* ─ Habit rows (active only) ─ */}
            {visibleHabits.map(habit => (
              <HabitRow
                key={habit.id}
                habit={habit}
                dates={dates}
                isCurrentDay={isCurrentDay}
                onToggle={toggle}
                onRightClick={openComment}
                onCommentHover={showCommentTooltip}
                onCommentLeave={hideCommentTooltip}
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
                  <div className="color-pick-row">
                    <label className="color-picker-label" title="Pick a color">
                      <div className="color-picker-disc" style={{ background: newColor }} />
                      <input
                        type="color"
                        value={newColor}
                        onChange={e => setNewColor(e.target.value)}
                      />
                      <span className="color-picker-text">Choose color</span>
                      <ColorWheelIcon />
                    </label>
                    <div className="color-preview-strip">
                      {getPalette(newColor).map((c, i) => (
                        <div key={i} className="color-strip-step" style={{ background: c }} />
                      ))}
                    </div>
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
          isLast={editingIdx === visibleHabits.length - 1}
          onSave={saveEdit}
          onCancel={cancelEdit}
          onDelete={deleteHabit}
          onArchive={archiveHabit}
          onMoveUp={() => moveHabit(-1)}
          onMoveDown={() => moveHabit(1)}
        />
      )}

      {/* ── Archive Panel ── */}
      {showArchive && (
        <ArchivePanel
          archivedHabits={archivedHabits}
          onRestore={restoreHabit}
          onDelete={deleteArchivedHabit}
          onClose={() => setShowArchive(false)}
        />
      )}

      {/* ── Comment Popover ── */}
      {commentTarget && (() => {
        const h = habits.find(x => x.id === commentTarget.id);
        return h ? (
          <CommentPopover
            habitName={h.name}
            ds={commentTarget.ds}
            existing={h.comments?.[commentTarget.ds] ?? ''}
            anchorRect={commentTarget.rect}
            onSave={saveComment}
            onClose={closeComment}
          />
        ) : null;
      })()}

      {/* ── Comment Tooltip ── */}
      {commentTooltip && createPortal(
        <div
          className="comment-tooltip"
          style={{
            top:  commentTooltip.rect.top  + window.scrollY,
            left: commentTooltip.rect.left + window.scrollX + commentTooltip.rect.width / 2,
          }}
        >
          <div className="comment-tooltip-date">{commentTooltip.ds}</div>
          <div className="comment-tooltip-text">{commentTooltip.text}</div>
        </div>,
        document.body,
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
function ArchiveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8"/>
      <rect x="1" y="3" width="22" height="5"/>
      <line x1="10" y1="12" x2="14" y2="12"/>
    </svg>
  );
}
function BoxArchiveIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="21 8 21 21 3 21 3 8"/>
      <rect x="1" y="3" width="22" height="5"/>
      <line x1="10" y1="12" x2="14" y2="12"/>
    </svg>
  );
}
function ColorWheelIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 2a10 10 0 0 1 10 10"/>
      <path d="M12 12 L12 2"/>
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
