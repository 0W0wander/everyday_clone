import {
  Fragment,
  useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, memo,
} from 'react';
import { createPortal } from 'react-dom';
import './App.css';
import type { Habit, HabitColor } from './types';
import { fetchRemote, pushRemote, isSyncConfigured } from './sync';
import { getQuote } from './quotes';

// ─── Color utilities ──────────────────────────────────────────────────────────

// Backward-compat: map the 7 legacy named colors → their hex equivalents
const LEGACY_COLOR_HEX: Record<string, string> = {
  green:  '#4ade80', blue:   '#60a5fa', yellow: '#facc15',
  orange: '#fb923c', red:    '#fb7185', purple: '#d946ef', teal:   '#2dd4bf',
};
const DEFAULT_COLOR = '#4ade80';
const DEFAULT_PRICE       = 0.1;  // $ per normal completion
const DEFAULT_BONUS_PRICE = 1;    // $ per middle-click "bonus" completion

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
const SPENT_KEY   = 'everyday-spent-v1';

function loadSpent(): number {
  try {
    const raw = localStorage.getItem(SPENT_KEY);
    const n = raw ? parseFloat(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

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

const STAT_HEADERS: string[][] = [
  ['current\nstreak', 'longest\nstreak'],
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

// Consecutive days (ending today, or yesterday if today isn't finished yet)
// on which EVERY active habit was completed. This is the "perfect day" streak.
function calcDayStreak(habits: Habit[]): number {
  if (habits.length === 0) return 0;
  const sets = habits.map(h => new Set(h.completions));
  const perfect = (ds: string) => sets.every(s => s.has(ds));
  const d = todayNoon();
  if (!perfect(fmt(d))) d.setDate(d.getDate() - 1); // grace: today still in progress
  let streak = 0;
  while (perfect(fmt(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
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
    bonuses:     Array.isArray(h.bonuses)     ? h.bonuses.filter(d => typeof d === 'string')     : [],
    price:       (typeof h.price === 'number'      && isFinite(h.price)      && h.price      >= 0) ? h.price      : undefined,
    bonusPrice:  (typeof h.bonusPrice === 'number' && isFinite(h.bonusPrice) && h.bonusPrice >= 0) ? h.bonusPrice : undefined,
    sectionBefore: typeof h.sectionBefore === 'string' && h.sectionBefore.trim() ? h.sectionBefore.trim() : undefined,
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

// Anchors a portal popover to a live element rect, clamped inside the viewport.
// Recomputes on every render + on scroll/resize, so it stays glued even when
// rows reorder. Returns null until the panel has been measured once.
function useAnchoredPosition(
  getAnchor: () => DOMRect | null,
  panelRef: React.RefObject<HTMLDivElement | null>,
  preferAbove = false,
) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick(t => t + 1);
    window.addEventListener('scroll', on, true);
    window.addEventListener('resize', on);
    return () => { window.removeEventListener('scroll', on, true); window.removeEventListener('resize', on); };
  }, []);
  useLayoutEffect(() => {
    const r = getAnchor();
    const panel = panelRef.current;
    if (!r || !panel) return;
    const pw = panel.offsetWidth || 280;
    const ph = panel.offsetHeight || 0;
    const m = 12;
    let left = Math.min(r.left + window.scrollX, window.innerWidth - pw - m);
    left = Math.max(m, left);
    const below = r.bottom + window.scrollY + 6;
    const above = r.top + window.scrollY - ph - 6;
    const fitsBelow = below + ph <= window.scrollY + window.innerHeight - 8;
    const fitsAbove = above >= window.scrollY + 8;
    const fallback = Math.max(window.scrollY + 8, window.scrollY + window.innerHeight - ph - 8);
    const top = preferAbove
      ? (fitsAbove ? above : fitsBelow ? below : fallback)
      : (fitsBelow ? below : fitsAbove ? above : fallback);
    setPos(p => (p && Math.abs(p.top - top) < 0.5 && Math.abs(p.left - left) < 0.5) ? p : { top, left });
    // Intentionally runs after every render (no deps) so the popover stays glued
    // to its anchor even when rows reorder; setPos is guarded to avoid loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });
  return pos;
}

// ─── EditPanel — rendered via portal so it's never clipped ───────────────────

interface EditPanelProps {
  habit: Habit;
  onSave:     (name: string, color: HabitColor, price: number, bonusPrice: number, sectionBefore: string) => void;
  onCancel:   () => void;
  onDelete:   () => void;
  onArchive:  () => void;
}

function EditPanel({ habit, onSave, onCancel, onDelete, onArchive }: EditPanelProps) {

  const [name,          setName]          = useState(habit.name);
  const [color,         setColor]         = useState<string>(habit.color);
  const [price,         setPrice]         = useState<string>(String(habit.price      ?? DEFAULT_PRICE));
  const [bonusPrice,    setBonusPrice]    = useState<string>(String(habit.bonusPrice ?? DEFAULT_BONUS_PRICE));
  const [sectionBefore, setSectionBefore] = useState(habit.sectionBefore ?? '');
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

  // Stay glued to this habit's row, even after reordering, and clamp to viewport.
  const pos = useAnchoredPosition(
    () => {
      const el = document.querySelector(`[data-hid="${CSS.escape(habit.id)}"]`);
      return el ? (el as HTMLElement).getBoundingClientRect() : null;
    },
    panelRef,
  );

  const handleSave = () => {
    const n = name.trim();
    if (!n) return;
    const p  = parseFloat(price);
    const bp = parseFloat(bonusPrice);
    onSave(
      n,
      color,
      Number.isFinite(p)  && p  >= 0 ? p  : DEFAULT_PRICE,
      Number.isFinite(bp) && bp >= 0 ? bp : DEFAULT_BONUS_PRICE,
      sectionBefore.trim(),
    );
  };

  return createPortal(
    <div
      ref={panelRef}
      className="edit-panel"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
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
      <div className="price-row">
        <label className="price-field">
          <span className="price-label">Per completion</span>
          <span className="price-input-wrap">
            <span className="price-prefix">$</span>
            <input
              type="number" min="0" step="0.05" inputMode="decimal"
              value={price}
              onChange={e => setPrice(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
            />
          </span>
        </label>
        <label className="price-field">
          <span className="price-label">Middle-click bonus</span>
          <span className="price-input-wrap">
            <span className="price-prefix">$</span>
            <input
              type="number" min="0" step="0.25" inputMode="decimal"
              value={bonusPrice}
              onChange={e => setBonusPrice(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
            />
          </span>
        </label>
      </div>
      <div className="section-label-row">
        <span className="section-label-prefix">§</span>
        <input
          className="section-label-input"
          value={sectionBefore}
          onChange={e => setSectionBefore(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
          placeholder="Section above this habit (leave blank for none)…"
        />
        {sectionBefore && (
          <button className="section-label-clear" onClick={() => setSectionBefore('')} title="Remove section">✕</button>
        )}
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

// ─── AddPanel — new-habit popover (portal, never clipped) ────────────────────

function AddPanel({ anchorRef, onAdd, onClose }: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onAdd: (name: string, color: string) => void;
  onClose: () => void;
}) {
  const [name,  setName]  = useState('');
  const [color, setColor] = useState<string>(DEFAULT_COLOR);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current && !panelRef.current.contains(t) && !anchorRef.current?.contains(t)) onClose();
    };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 80);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler); };
  }, [onClose, anchorRef]);

  const pos = useAnchoredPosition(() => anchorRef.current?.getBoundingClientRect() ?? null, panelRef, true);
  const submit = () => { const n = name.trim(); if (n) onAdd(n, color); };

  return createPortal(
    <div
      ref={panelRef}
      className="edit-panel add-panel"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <input
        ref={inputRef}
        className="edit-panel-input"
        placeholder="Habit name…"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
      />
      <div className="color-pick-row">
        <label className="color-picker-label" title="Pick a color">
          <div className="color-picker-disc" style={{ background: color }} />
          <input type="color" value={color} onChange={e => setColor(e.target.value)} />
          <span className="color-picker-text">Choose color</span>
          <ColorWheelIcon />
        </label>
        <div className="color-preview-strip">
          {getPalette(color).map((c, i) => (
            <div key={i} className="color-strip-step" style={{ background: c }} />
          ))}
        </div>
      </div>
      <div className="edit-panel-actions">
        <button className="btn-save" onClick={submit}>Add</button>
        <button className="btn-cancel" onClick={onClose}>Cancel</button>
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
  onMiddleToggle:   (id: string, ds: string) => void;
  onRightClick:     (id: string, ds: string, rect: DOMRect) => void;
  onCommentHover:   (text: string, ds: string, rect: DOMRect) => void;
  onCommentLeave:   () => void;
  editMode: boolean;
  isEditing: boolean;
  onOpenEdit: () => void;
  analyticsView: 0 | 1 | 2;
  isDragging: boolean;
  isDragOver: boolean;
  onDragStartRow: (id: string) => void;
  onDragOverRow:  (id: string) => void;
  onDropRow:      (srcId: string, targetId: string) => void;
  onDragEndRow:   () => void;
}

const HabitRow = memo(function HabitRow(
  { habit, dates, isCurrentDay, onToggle, onMiddleToggle, onRightClick, onCommentHover, onCommentLeave,
    editMode, isEditing, onOpenEdit, analyticsView,
    isDragging, isDragOver, onDragStartRow, onDragOverRow, onDropRow, onDragEndRow }: RowProps
) {
  const nameRef = useRef<HTMLDivElement>(null);
  const comp  = useMemo(() => new Set(habit.completions), [habit.completions]);
  const skip  = useMemo(() => new Set(habit.skips),       [habit.skips]);
  const fail  = useMemo(() => new Set(habit.fails),       [habit.fails]);
  const bonus = useMemo(() => new Set(habit.bonuses ?? []), [habit.bonuses]);
  const cur  = useMemo(() => calcCurrentStreak(habit.completions, habit.skips),  [habit.completions, habit.skips]);
  const lon  = useMemo(() => calcLongestStreak(habit.completions, habit.skips),  [habit.completions, habit.skips]);
  const acc  = getAccent(habit.color);
  const doneToday = comp.has(fmt(todayNoon()));   // completed for today?
  const urgeMax   = lon > 0 && cur >= lon && !doneToday; // at record run but today not done yet

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
        data-hid={habit.id}
        className={`cell habit-name${isEditing ? ' editing' : ''}${editMode ? ' draggable' : ''}${isDragging ? ' dragging' : ''}${isDragOver ? ' drag-over' : ''}`}
        draggable={editMode}
        onDragStart={editMode ? e => {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', habit.id);
          onDragStartRow(habit.id);
        } : undefined}
        onDragEnter={editMode ? e => { e.preventDefault(); onDragOverRow(habit.id); } : undefined}
        onDragOver={editMode ? e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } : undefined}
        onDrop={editMode ? e => {
          e.preventDefault();
          const src = e.dataTransfer.getData('text/plain');
          if (src) onDropRow(src, habit.id);
        } : undefined}
        onDragEnd={editMode ? () => onDragEndRow() : undefined}
      >
        {editMode && <span className="drag-grip" title="Drag to reorder"><GripIcon /></span>}
        <span className="habit-name-text">{habit.name}</span>
        {editMode && (
          <button
            className="edit-icon-btn"
            onClick={() => onOpenEdit()}
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
        const bns   = done && bonus.has(ds);
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
            className={`cell habit-cell${isTd ? ' today-col' : ''}${faild ? ' failed-cell' : ''}${hasComment ? ' has-comment' : ''}${bns ? ' bonus-cell' : ''}`}
            style={bns ? undefined : done ? { backgroundColor: bg } : faild ? { '--fail-color': acc } as React.CSSProperties : undefined}
            onClick={() => onToggle(habit.id, ds)}
            onMouseDown={e => { if (e.button === 1) e.preventDefault(); }}
            onAuxClick={e => {
              if (e.button === 1) { e.preventDefault(); onMiddleToggle(habit.id, ds); }
            }}
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
            {bns && <span className="cell-money">$</span>}
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
          {doneToday ? <span className="streak-badge" style={{ background: acc }}>{cur}</span>
                     : <span className="stat-num">{cur || ''}</span>}
        </div>
        <div className="cell stat-cell">
          <span
            className={`stat-num${urgeMax ? ' streak-urge' : ''}`}
            style={urgeMax ? { color: acc, textDecorationColor: acc } : undefined}
            title={urgeMax ? 'You\u2019re at your record streak \u2014 complete it today to extend it!' : undefined}
          >
            {lon || ''}
          </span>
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

// ─── Daily Progress (gamified) ──────────────────────────────────────────────

interface DayPip { id: string; name: string; color: string; done: boolean; bonus: boolean; price: number; bonusPrice: number; }

const DailyProgress = memo(function DailyProgress(
  { pips, done, total, viewingToday, daySeed, earned, dayStreak }: {
    pips: DayPip[]; done: number; total: number; viewingToday: boolean;
    daySeed: number; earned: number; dayStreak: number;
  }
) {
  const remaining = total - done;
  const percent   = total === 0 ? 0 : Math.round((done / total) * 100);
  const allDone   = total > 0 && remaining === 0;
  const quote     = getQuote(done, total, daySeed);

  // ring geometry
  const R = 30, C = 2 * Math.PI * R;
  const dash = C * (total === 0 ? 0 : done / total);

  return (
    <section className={`daily-progress${allDone ? ' is-complete' : ''}`}>
      <div className="dp-ring" role="img" aria-label={`${percent}% of habits complete`}>
        <svg width="74" height="74" viewBox="0 0 74 74">
          <circle className="dp-ring-track" cx="37" cy="37" r={R} />
          <circle
            className="dp-ring-fill"
            cx="37" cy="37" r={R}
            strokeDasharray={`${dash} ${C}`}
            transform="rotate(-90 37 37)"
          />
        </svg>
        <div className="dp-ring-label">
          {allDone ? <span className="dp-check">{'\u2713'}</span>
                   : <span className="dp-pct">{percent}%</span>}
        </div>
      </div>

      <div className="dp-body">
        <div className="dp-top">
          <span className="dp-title">
            {viewingToday ? 'Today' : 'Today (so far)'}
          </span>
          <span className="dp-counts">
            <strong>{done}</strong> / {total} done
            {remaining > 0 && <span className="dp-left"> {'\u00b7'} {remaining} to go</span>}
          </span>
          <span className="dp-top-right">
            <span
              className={`dp-streak${dayStreak > 0 ? '' : ' zero'}`}
              title="Days in a row with every habit completed"
            >
              <FlameIcon active={dayStreak > 0} />
              {dayStreak > 0
                ? <>{dayStreak} day{dayStreak === 1 ? '' : 's'} streak</>
                : <>No day streak yet</>}
            </span>
            <span className="dp-earned" title="Earned today">${earned.toFixed(2)}</span>
          </span>
        </div>

        <div className="dp-pips" aria-hidden="true">
          {pips.map(p => (
            <span
              key={p.id}
              className={`dp-pip${p.done ? ' filled' : ''}${p.bonus ? ' bonus' : ''}`}
              style={p.done && !p.bonus ? { background: p.color, boxShadow: `0 0 0 1px ${p.color}` } : undefined}
              title={`${p.name}${p.bonus ? ` \u2014 $${p.bonusPrice.toFixed(2)}` : p.done ? ` \u2014 $${p.price.toFixed(2)}` : ` \u2014 $${p.price.toFixed(2)} when done`}`}
            >
              {p.bonus ? '$' : ''}
            </span>
          ))}
          {total === 0 && <span className="dp-pip-empty">No habits yet</span>}
        </div>

        <div className="dp-quote">
          <span className="dp-quote-text">{quote.text}</span>
          <span className="dp-quote-source">{'\u2014 '}{quote.source}</span>
        </div>
      </div>
    </section>
  );
});

// ─── MoneyMenu — top-right balance with a hover "spend" popover ──────────────

const MoneyMenu = memo(function MoneyMenu(
  { earned, spent, onSpend }: { earned: number; spent: number; onSpend: (amt: number) => void; }
) {
  const [open, setOpen] = useState(false);
  const [amt, setAmt]   = useState('');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const balance = earned - spent;

  const openNow  = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true); };
  const closeSoon = () => { closeTimer.current = setTimeout(() => setOpen(false), 220); };

  const submit = () => {
    const v = parseFloat(amt);
    if (Number.isFinite(v) && v > 0) { onSpend(v); setAmt(''); }
  };

  return (
    <div className="money-wrap" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <MoneyIcon />
      <span
        className={`score money-score${balance < 0 ? ' negative' : ''}`}
        title="Hover to spend money"
      >
        ${balance.toFixed(2)}
      </span>

      {open && (
        <div className="money-menu" onMouseEnter={openNow} onMouseLeave={closeSoon}>
          <div className="money-menu-rows">
            <div className="money-menu-row"><span>Earned</span><span className="mm-pos">+${earned.toFixed(2)}</span></div>
            <div className="money-menu-row"><span>Spent</span><span className="mm-neg">-${spent.toFixed(2)}</span></div>
            <div className="money-menu-row money-menu-total"><span>Balance</span><span>${balance.toFixed(2)}</span></div>
          </div>
          <div className="money-spend">
            <span className="money-spend-prefix">$</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={amt}
              onChange={e => setAmt(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            />
            <button className="btn-spend" onClick={submit}>Spend</button>
          </div>
          {spent > 0 && (
            <button className="money-reset" onClick={() => onSpend(-spent)}>Reset spending</button>
          )}
        </div>
      )}
    </div>
  );
});

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [habits,         setHabits]         = useState<Habit[]>(loadHabits);
  const [offset,         setOffset]         = useState(0);
  const [adding,         setAdding]         = useState(false);
  const [spent,          setSpent]          = useState<number>(loadSpent);
  const [editMode,       setEditMode]       = useState(false);
  const [editingId,      setEditingId]      = useState<string | null>(null);
  const [draggingId,     setDraggingId]     = useState<string | null>(null);
  const [dragOverId,     setDragOverId]     = useState<string | null>(null);
  const [analyticsView,  setAnalyticsView]  = useState<0 | 1 | 2>(0);
  const [syncStatus,     setSyncStatus]     = useState<'idle'|'syncing'|'synced'|'error'>('idle');
  const [showArchive,    setShowArchive]    = useState(false);
  const [commentTarget,  setCommentTarget]  = useState<{ id: string; ds: string; rect: DOMRect } | null>(null);
  const [commentTooltip, setCommentTooltip] = useState<{ text: string; ds: string; rect: DOMRect } | null>(null);
  const addBtnRef    = useRef<HTMLButtonElement>(null);
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

  useEffect(() => { localStorage.setItem(SPENT_KEY, String(spent)); }, [spent]);

  const spend = useCallback((amt: number) => {
    setSpent(s => Math.max(0, Math.round((s + amt) * 100) / 100));
  }, []);

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


  // Cycle: empty → done → skip → fail → empty
  const toggle = useCallback((id: string, ds: string) => {
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h;
      const done = h.completions.includes(ds);
      const skpd = h.skips.includes(ds);
      const fail = h.fails.includes(ds);
      const dropBonus = (h.bonuses ?? []).filter(b => b !== ds);
      if (!done && !skpd && !fail)
        return { ...h, completions: [...h.completions, ds] };
      if (done) {
        if (wouldExceedSkipRun(h.skips, ds, 2))
          return { ...h, completions: h.completions.filter(c => c !== ds), fails: [...h.fails, ds], bonuses: dropBonus };
        return { ...h, completions: h.completions.filter(c => c !== ds), skips: [...h.skips, ds], bonuses: dropBonus };
      }
      if (skpd)
        return { ...h, skips: h.skips.filter(s => s !== ds), fails: [...h.fails, ds] };
      return { ...h, fails: h.fails.filter(f => f !== ds) };
    }));
  }, []);

  // Middle-click: toggle a $1 "bonus" completion (done + worth a dollar)
  const toggleBonus = useCallback((id: string, ds: string) => {
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h;
      const bonuses = h.bonuses ?? [];
      if (bonuses.includes(ds))
        // already a $1 day → clear it back to empty
        return { ...h, completions: h.completions.filter(c => c !== ds), bonuses: bonuses.filter(b => b !== ds) };
      // mark as a $1 completion regardless of prior state
      return {
        ...h,
        completions: h.completions.includes(ds) ? h.completions : [...h.completions, ds],
        skips: h.skips.filter(s => s !== ds),
        fails: h.fails.filter(f => f !== ds),
        bonuses: [...bonuses, ds],
      };
    }));
  }, []);

  const addHabit = useCallback((name: string, color: string) => {
    const n = name.trim();
    if (!n) return;
    setHabits(prev => [...prev, {
      id: `h-${Date.now()}`, name: n, color,
      completions: [], skips: [], fails: [], bonuses: [],
    }]);
    setAdding(false);
  }, []);

  const saveEdit = useCallback((name: string, color: HabitColor, price: number, bonusPrice: number, sectionBefore: string) => {
    setHabits(prev => prev.map(h => h.id === editingId
      ? { ...h, name, color, price, bonusPrice, sectionBefore: sectionBefore || undefined }
      : h
    ));
    setEditingId(null);
  }, [editingId]);

  const deleteHabit = useCallback(() => {
    if (!window.confirm('Delete this habit?')) return;
    setHabits(prev => prev.filter(h => h.id !== editingId));
    setEditingId(null);
  }, [editingId]);

  const archiveHabit = useCallback(() => {
    setHabits(prev => prev.map(h => h.id === editingId ? { ...h, archived: true } : h));
    setEditingId(null);
  }, [editingId]);

  const restoreHabit = useCallback((id: string) => {
    setHabits(prev => prev.map(h => h.id === id ? { ...h, archived: false } : h));
  }, []);

  const deleteArchivedHabit = useCallback((id: string) => {
    if (!window.confirm('Permanently delete this habit and all its data?')) return;
    setHabits(prev => prev.filter(h => h.id !== id));
  }, []);

  // Drag-and-drop reordering (active in edit mode)
  const handleDragStart = useCallback((id: string) => setDraggingId(id), []);
  const handleDragOver  = useCallback((id: string) => setDragOverId(id), []);
  const handleDragEnd   = useCallback(() => { setDraggingId(null); setDragOverId(null); }, []);
  const reorderHabit = useCallback((srcId: string, targetId: string) => {
    setDraggingId(null); setDragOverId(null);
    if (srcId === targetId) return;
    setHabits(prev => {
      const from = prev.findIndex(h => h.id === srcId);
      const to   = prev.findIndex(h => h.id === targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      let insertAt = next.findIndex(h => h.id === targetId);
      if (from < to) insertAt += 1;   // dropping below → place after target
      next.splice(insertAt, 0, moved);
      return next;
    });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const openEdit = useCallback((id: string) => {
    setEditingId(id);
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

  // Per-habit pricing: `price` per completion, `bonusPrice` for middle-click "bonus" days
  const totalMoney = useMemo(() => habits.reduce((sum, h) => {
    const b  = new Set(h.bonuses ?? []);
    const pr = h.price      ?? DEFAULT_PRICE;
    const bp = h.bonusPrice ?? DEFAULT_BONUS_PRICE;
    return sum + h.completions.reduce((s, ds) => s + (b.has(ds) ? bp : pr), 0);
  }, 0), [habits]);
  const dailyCount = useCallback((ds: string) =>
    visibleHabits.filter(h => h.completions.includes(ds)).length,
  [visibleHabits]);

  // Today's progress (always real "today", regardless of which day is in view)
  const todayStr = fmt(todayNoon());
  const todayPips = useMemo(
    () => visibleHabits.map(h => ({
      id: h.id, name: h.name, color: h.color,
      done: h.completions.includes(todayStr),
      bonus: (h.bonuses ?? []).includes(todayStr),
      price:      h.price      ?? DEFAULT_PRICE,
      bonusPrice: h.bonusPrice ?? DEFAULT_BONUS_PRICE,
    })),
    [visibleHabits, todayStr],
  );
  const todayDone  = todayPips.filter(p => p.done).length;
  const todayMoney = todayPips.reduce((s, p) => s + (p.done ? (p.bonus ? p.bonusPrice : p.price) : 0), 0);
  const dayStreak  = useMemo(() => calcDayStreak(visibleHabits), [visibleHabits]);
  // Stable per-day seed so "start"/"victory" quotes vary day to day.
  const daySeed = useMemo(() => {
    const d = todayNoon();
    return d.getFullYear() * 1000 + Math.floor(
      (d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86400000,
    );
  }, [todayStr]);

  const { wName, wDay, wToday, wStat, daysBack, rowH, isMobile } = layout;
  const statCount = STAT_HEADERS[analyticsView].length;
  const gridCols = isCurrentDay
    ? `${wName}px repeat(${daysBack}, ${wDay}px) ${wToday}px repeat(${statCount}, ${wStat}px)`
    : `${wName}px repeat(${daysBack + 1}, ${wDay}px) repeat(${statCount}, ${wStat}px)`;

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
          <MoneyMenu earned={totalMoney} spent={spent} onSpend={spend} />
          {!isMobile && <span className="username">Kevin ▾</span>}
        </div>
      </header>

      {/* ── Daily progress ── */}
      <DailyProgress
        pips={todayPips}
        done={todayDone}
        total={todayPips.length}
        viewingToday={isCurrentDay}
        daySeed={daySeed}
        earned={todayMoney}
        dayStreak={dayStreak}
      />

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
              <Fragment key={habit.id}>
                {habit.sectionBefore && (
                  <div className="section-divider">
                    <span className="section-divider-label">{habit.sectionBefore}</span>
                  </div>
                )}
              <HabitRow
                key={habit.id}
                habit={habit}
                dates={dates}
                isCurrentDay={isCurrentDay}
                onToggle={toggle}
                onMiddleToggle={toggleBonus}
                onRightClick={openComment}
                onCommentHover={showCommentTooltip}
                onCommentLeave={hideCommentTooltip}
                editMode={editMode}
                isEditing={editingId === habit.id}
                onOpenEdit={() => openEdit(habit.id)}
                analyticsView={analyticsView}
                isDragging={draggingId === habit.id}
                isDragOver={dragOverId === habit.id && draggingId !== habit.id}
                onDragStartRow={handleDragStart}
                onDragOverRow={handleDragOver}
                onDropRow={reorderHabit}
                onDragEndRow={handleDragEnd}
              />
              </Fragment>
            ))}

            {/* ─ Footer ─ */}
            <div className="cell footer-name">
              <button
                ref={addBtnRef}
                className={`add-btn${adding ? ' active' : ''}`}
                onClick={() => setAdding(a => !a)}
              >
                <span className="add-plus">+</span> New Habit
              </button>
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

            <div className="cell footer-progress" style={{ gridColumn: `span ${statCount}` }}>
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

      {/* ── Add Habit Panel (portal, never clipped by overflow) ── */}
      {adding && (
        <AddPanel anchorRef={addBtnRef} onAdd={addHabit} onClose={() => setAdding(false)} />
      )}

      {/* ── Edit Panel (portal, never clipped by overflow) ── */}
      {editingHabit && (
        <EditPanel
          habit={editingHabit}
          onSave={saveEdit}
          onCancel={cancelEdit}
          onDelete={deleteHabit}
          onArchive={archiveHabit}
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
function MoneyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="#16a34a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="6" width="20" height="12" rx="2"/>
      <circle cx="12" cy="12" r="2.5"/>
      <path d="M6 12h.01M18 12h.01"/>
    </svg>
  );
}
function FlameIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24"
      fill={active ? '#f97316' : 'none'}
      stroke={active ? '#ea580c' : '#94a3b8'} strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 17c1.4 0 2.5-1.1 2.5-2.5 0-1-.5-1.8-1-2.5-.5-.7-1-1.5-1-2.5 0-1.5 1-3 1-3s-3 1-4.5 3.5C7 9.7 6 11 6 13a6 6 0 0 0 12 0c0-2.5-1.5-4.5-2.5-6"/>
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
function GripIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>
      <circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>
      <circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>
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
