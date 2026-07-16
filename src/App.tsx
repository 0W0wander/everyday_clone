import {
  Fragment,
  useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, memo,
} from 'react';
import { createPortal } from 'react-dom';
import './App.css';
import type { Habit, HabitColor, HabitLevel, HabitSchedule, HabitSnapshot } from './types';
import {
  fetchRemote, pushRemote, isSyncConfigured,
  listGistCommits, fetchRevision, type GistCommit,
} from './sync';
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
const STORAGE_KEY    = 'everyday-habits-v2';
const SPENT_KEY      = 'everyday-spent-v1';
const LAST_SPEND_KEY = 'everyday-last-spend-v1';
const SNAPSHOTS_KEY  = 'everyday-snapshots-v1';

function loadSpent(): number {
  try {
    const raw = localStorage.getItem(SPENT_KEY);
    const n = raw ? parseFloat(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function loadLastSpend(): number {
  try {
    const raw = localStorage.getItem(LAST_SPEND_KEY);
    const n = raw ? parseFloat(raw) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}

function loadSnapshots(): HabitSnapshot[] {
  try {
    const raw = localStorage.getItem(SNAPSHOTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is HabitSnapshot =>
      !!s && typeof s === 'object'
      && typeof s.id === 'string'
      && typeof s.habitId === 'string'
      && typeof s.at === 'string'
      && typeof s.name === 'string'
      && typeof s.color === 'string',
    );
  } catch { return []; }
}

/** Cloud / local sync blob shape (legacy payloads may omit newer fields). */
interface SyncPayload {
  habits: Habit[];
  spent: number;
  lastSpend?: number;
  snapshots?: HabitSnapshot[];
}

function parseRemotePayload(raw: unknown): {
  habits: Habit[] | null;
  spent: number | null;
  lastSpend: number | null;
  snapshots: HabitSnapshot[] | null;
} {
  if (Array.isArray(raw)) {
    return { habits: sanitizeAll(raw), spent: null, lastSpend: null, snapshots: null };
  }
  if (!raw || typeof raw !== 'object') {
    return { habits: null, spent: null, lastSpend: null, snapshots: null };
  }
  const obj = raw as {
    habits?: unknown;
    spent?: unknown;
    lastSpend?: unknown;
    snapshots?: unknown;
  };
  const habits = Array.isArray(obj.habits) ? sanitizeAll(obj.habits) : null;
  const spent = typeof obj.spent === 'number' && Number.isFinite(obj.spent) ? Math.max(0, obj.spent) : null;
  const lastSpend = typeof obj.lastSpend === 'number' && Number.isFinite(obj.lastSpend)
    ? Math.max(0, obj.lastSpend) : null;
  let snapshots: HabitSnapshot[] | null = null;
  if (Array.isArray(obj.snapshots)) {
    snapshots = obj.snapshots.filter((s): s is HabitSnapshot =>
      !!s && typeof s === 'object'
      && typeof (s as HabitSnapshot).id === 'string'
      && typeof (s as HabitSnapshot).habitId === 'string'
      && typeof (s as HabitSnapshot).at === 'string'
      && typeof (s as HabitSnapshot).name === 'string'
      && typeof (s as HabitSnapshot).color === 'string',
    );
  }
  return { habits, spent, lastSpend, snapshots };
}

function snapshotFromHabit(h: Habit): HabitSnapshot {
  return {
    id: `snap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    habitId: h.id,
    at: new Date().toISOString(),
    name: h.name,
    color: h.color,
    price: h.price,
    bonusPrice: h.bonusPrice,
    levels: h.levels ? h.levels.map(l => ({ ...l })) : undefined,
    schedule: h.schedule ? structuredClone(h.schedule) : undefined,
    sectionBefore: h.sectionBefore,
  };
}

function defChanged(
  h: Habit,
  next: {
    name: string; color: HabitColor; price: number; bonusPrice: number;
    sectionBefore: string; levels: HabitLevel[]; schedule: HabitSchedule | undefined;
  },
): boolean {
  if (h.name !== next.name) return true;
  if (h.color !== next.color) return true;
  if ((h.price ?? DEFAULT_PRICE) !== next.price) return true;
  if ((h.bonusPrice ?? DEFAULT_BONUS_PRICE) !== next.bonusPrice) return true;
  if ((h.sectionBefore ?? '') !== next.sectionBefore) return true;
  if (JSON.stringify(h.levels ?? []) !== JSON.stringify(next.levels)) return true;
  if (JSON.stringify(h.schedule ?? null) !== JSON.stringify(next.schedule ?? null)) return true;
  return false;
}

function formatRelativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatSnapshotWhen(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
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

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(to + 'T12:00:00').getTime() - new Date(from + 'T12:00:00').getTime()) / 86400000
  );
}

function lastCompletionOnOrBefore(h: Habit, ds: string): string | null {
  let last: string | null = null;
  for (const c of h.completions) {
    if (c <= ds && (last === null || c > last)) last = c;
  }
  return last;
}

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
// Completions count; skips and off-schedule days are transparent (don't break,
// don't count). A due day that was failed or left empty breaks the chain.

function streakEarliest(h: Habit): string | null {
  let earliest: string | null = null;
  for (const ds of [...h.completions, ...h.skips]) {
    if (earliest === null || ds < earliest) earliest = ds;
  }
  return earliest;
}

/** Streak of completions ending on `ds` (must be a completed or skipped day). */
function streakAt(h: Habit, ds: string): number {
  const comp = new Set(h.completions);
  const skip = new Set(h.skips);
  const fail = new Set(h.fails);
  if (!comp.has(ds) && !skip.has(ds)) return 0;

  const earliest = streakEarliest(h) ?? ds;
  let n = 0;
  const d = new Date(ds + 'T12:00:00');
  while (fmt(d) >= earliest) {
    const s = fmt(d);
    if (comp.has(s)) {
      n++;
    } else if (skip.has(s)) {
      // transparent
    } else if (fail.has(s)) {
      break;
    } else if (!isScheduledOn(h, s)) {
      // off-day (rest / not due) — transparent
    } else {
      break; // due but empty
    }
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function calcCurrentStreak(h: Habit): number {
  const comp = new Set(h.completions);
  const skip = new Set(h.skips);
  const fail = new Set(h.fails);
  const earliest = streakEarliest(h);
  if (earliest === null) return 0;

  const today = fmt(todayNoon());
  const d = todayNoon();
  let n = 0;

  while (fmt(d) >= earliest) {
    const s = fmt(d);
    if (comp.has(s)) {
      n++;
    } else if (skip.has(s)) {
      // transparent
    } else if (fail.has(s)) {
      break;
    } else if (!isScheduledOn(h, s)) {
      // off-day — transparent
    } else if (s === today) {
      // grace: today is still in progress
    } else {
      break; // missed a due day
    }
    d.setDate(d.getDate() - 1);
  }
  return n;
}

function calcLongestStreak(h: Habit): number {
  const comp = new Set(h.completions);
  const skip = new Set(h.skips);
  const fail = new Set(h.fails);
  const earliest = streakEarliest(h);
  if (earliest === null) return 0;

  const today = fmt(todayNoon());
  let max = 0;
  let cur = 0;
  const d = new Date(earliest + 'T12:00:00');

  while (fmt(d) <= today) {
    const s = fmt(d);
    if (comp.has(s)) {
      cur++;
      if (cur > max) max = cur;
    } else if (skip.has(s)) {
      // transparent
    } else if (fail.has(s)) {
      cur = 0;
    } else if (!isScheduledOn(h, s)) {
      // off-day — transparent
    } else if (s === today) {
      // today still open — don't wipe the run
    } else {
      cur = 0;
    }
    d.setDate(d.getDate() + 1);
  }
  return max;
}

// Consecutive days (ending today, or yesterday if today isn't finished yet) on
// which every habit DUE that day was completed or skipped. Skips don't break it,
// and days where nothing is scheduled are neutral (don't break, don't count).
function calcDayStreak(habits: Habit[]): number {
  if (habits.length === 0) return 0;
  const comp = new Map<string, Set<string>>();
  const skip = new Map<string, Set<string>>();
  let earliest: string | null = null;
  for (const h of habits) {
    comp.set(h.id, new Set(h.completions));
    skip.set(h.id, new Set(h.skips));
    for (const ds of [...h.completions, ...h.skips]) {
      if (earliest === null || ds < earliest) earliest = ds;
    }
  }
  if (earliest === null) return 0;

  // 'ok' = all due done/skipped, 'fail' = something due missed, 'none' = nothing due
  const dayState = (ds: string): 'ok' | 'fail' | 'none' => {
    const due = habits.filter(h => isScheduledOn(h, ds));
    if (due.length === 0) return 'none';
    return due.every(h => comp.get(h.id)!.has(ds) || skip.get(h.id)!.has(ds)) ? 'ok' : 'fail';
  };

  const d = todayNoon();
  if (dayState(fmt(d)) === 'fail') d.setDate(d.getDate() - 1); // grace: today in progress

  let streak = 0;
  while (fmt(d) >= earliest) {
    const st = dayState(fmt(d));
    if (st === 'fail') break;
    if (st === 'ok') streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
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

// Whether a habit has user-defined extra levels (beyond its implicit base level)
function habitHasLevels(h: Habit): boolean {
  return (h.levels?.length ?? 0) > 0;
}

// Is the habit "due" on the given date string (YYYY-MM-DD)?
function isScheduledOn(h: Habit, ds: string): boolean {
  const s = h.schedule;
  if (!s || s.type === 'daily') return true;
  if (s.type === 'weekly') {
    if (!s.weekdays.length) return true; // no days picked → treat as daily
    return s.weekdays.includes(new Date(ds + 'T12:00:00').getDay());
  }
  if (s.type === 'interval') {
    const every = Math.max(1, Math.floor(s.every));
    const lastComp = lastCompletionOnOrBefore(h, ds);
    if (!lastComp) return true; // never completed → always due
    if (lastComp === ds) return true; // stay visible on the day you complete it
    return daysBetween(lastComp, ds) >= every;
  }
  return true;
}

// Full selectable level list: the habit itself (base) + any extra levels.
// Index 0 = base (habit name + per-completion price), 1.. = extra levels.
function effectiveLevels(h: Habit): HabitLevel[] {
  return [{ name: h.name, price: h.price ?? DEFAULT_PRICE }, ...(h.levels ?? [])];
}

// Money earned for a single completed day, honoring levels → bonus → flat price
function priceForDay(h: Habit, ds: string): number {
  if (habitHasLevels(h)) {
    const eff = effectiveLevels(h);
    const idx = Math.min(h.dayLevels?.[ds] ?? 0, eff.length - 1);
    return eff[idx].price;
  }
  if ((h.bonuses ?? []).includes(ds)) return h.bonusPrice ?? DEFAULT_BONUS_PRICE;
  return h.price ?? DEFAULT_PRICE;
}

function sanitizeLevels(raw: unknown): HabitLevel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter(l => l && typeof l === 'object')
    .map(l => {
      const o = l as Partial<HabitLevel>;
      return {
        name:  typeof o.name === 'string' && o.name.trim() ? o.name.trim() : 'Level',
        price: (typeof o.price === 'number' && isFinite(o.price) && o.price >= 0) ? o.price : DEFAULT_PRICE,
      };
    });
  return out.length ? out : undefined;
}

function sanitizeSchedule(raw: unknown): HabitSchedule | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Partial<HabitSchedule> & { type?: string };
  if (s.type === 'weekly') {
    const wd = Array.isArray((s as { weekdays?: unknown }).weekdays)
      ? ((s as { weekdays: unknown[] }).weekdays).filter(n => typeof n === 'number' && n >= 0 && n <= 6) as number[]
      : [];
    return wd.length ? { type: 'weekly', weekdays: [...new Set(wd)] } : undefined;
  }
  if (s.type === 'interval') {
    const every = (s as { every?: unknown }).every;
    if (typeof every === 'number' && every >= 1) {
      return { type: 'interval', every: Math.floor(every) };
    }
    return undefined;
  }
  return undefined; // 'daily' or unknown → store nothing (= every day)
}

function sanitizeDayLevels(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === 'string' && typeof v === 'number' && isFinite(v) && v >= 0) {
      out[k] = Math.floor(v);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

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
    levels:      sanitizeLevels(h.levels),
    dayLevels:   sanitizeDayLevels(h.dayLevels),
    activeLevel: (typeof h.activeLevel === 'number' && isFinite(h.activeLevel) && h.activeLevel >= 0) ? Math.floor(h.activeLevel) : undefined,
    sectionBefore: typeof h.sectionBefore === 'string' && h.sectionBefore.trim() ? h.sectionBefore.trim() : undefined,
    schedule:    sanitizeSchedule(h.schedule),
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

// ─── SyncHistoryPanel — restore one of the previous 3 cloud commits ───────────

interface SyncHistoryPanelProps {
  onRestore: (sha: string) => Promise<void>;
  onClose: () => void;
}

function SyncHistoryPanel({ onRestore, onClose }: SyncHistoryPanelProps) {
  const [commits, setCommits] = useState<GistCommit[] | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [busy, setBusy]       = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await listGistCommits(4);
      if (cancelled) return;
      if (!result.ok) {
        setError(result.error);
        setCommits([]);
        return;
      }
      // Skip index 0 (current HEAD); offer the previous three.
      setCommits(result.data.slice(1, 4));
    })();
    return () => { cancelled = true; };
  }, []);

  const restore = async (sha: string) => {
    if (!window.confirm('Replace your current data with this earlier cloud version? Your current state will be overwritten and synced.')) return;
    setBusy(sha);
    try {
      await onRestore(sha);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div className="archive-overlay" onClick={onClose}>
      <div className="archive-panel" onClick={e => e.stopPropagation()}>
        <div className="archive-panel-header">
          <div className="archive-panel-title-group">
            <HistoryIcon />
            <span className="archive-panel-title">Cloud history</span>
          </div>
          <button className="archive-close-btn" onClick={onClose}>✕</button>
        </div>
        <p className="history-hint">
          Go back up to three previous syncs — useful if another computer overwrote your data.
        </p>
        {error && <p className="history-error">{error}</p>}
        {commits === null ? (
          <p className="archive-empty">Loading revisions…</p>
        ) : commits.length === 0 ? (
          <p className="archive-empty">No earlier versions yet. Sync a few times first.</p>
        ) : (
          <ul className="archive-list">
            {commits.map((c, i) => (
              <li key={c.version} className="archive-item history-item">
                <div className="history-item-meta">
                  <span className="history-item-label">
                    {i === 0 ? 'Previous sync' : i === 1 ? '2 syncs ago' : '3 syncs ago'}
                  </span>
                  <span className="history-item-time">{formatRelativeTime(c.committed_at)}</span>
                </div>
                <button
                  className="btn-restore"
                  disabled={busy !== null}
                  onClick={() => restore(c.version)}
                >
                  {busy === c.version ? 'Restoring…' : 'Restore'}
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

// ─── HabitHistoryPanel — browse definition snapshots for one habit ────────────

interface HabitHistoryPanelProps {
  habitName: string;
  snapshots: HabitSnapshot[];
  onRestore: (snap: HabitSnapshot) => void;
  onClose: () => void;
}

function HabitHistoryPanel({ habitName, snapshots, onRestore, onClose }: HabitHistoryPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const sorted = useMemo(
    () => [...snapshots].sort((a, b) => b.at.localeCompare(a.at)),
    [snapshots],
  );

  return createPortal(
    <div className="archive-overlay" onClick={onClose}>
      <div className="archive-panel habit-history-panel" onClick={e => e.stopPropagation()}>
        <div className="archive-panel-header">
          <div className="archive-panel-title-group">
            <HistoryIcon />
            <span className="archive-panel-title">History — {habitName}</span>
          </div>
          <button className="archive-close-btn" onClick={onClose}>✕</button>
        </div>
        <p className="history-hint">
          Snapshots are saved whenever you edit this habit’s name, levels, price, or schedule.
        </p>
        {sorted.length === 0 ? (
          <p className="archive-empty">No snapshots yet. Edit and save this habit to start a timeline.</p>
        ) : (
          <ul className="archive-list">
            {sorted.map(s => {
              const open = expanded === s.id;
              const levelNames = [
                s.name,
                ...(s.levels ?? []).map(l => l.name),
              ].filter(Boolean);
              return (
                <li key={s.id} className="habit-snap-item">
                  <button
                    className="habit-snap-header"
                    onClick={() => setExpanded(open ? null : s.id)}
                  >
                    <div
                      className="archive-color-dot"
                      style={{ backgroundColor: getPalette(s.color)[5] }}
                    />
                    <div className="habit-snap-summary">
                      <span className="habit-snap-name">{s.name}</span>
                      <span className="habit-snap-when">{formatSnapshotWhen(s.at)}</span>
                    </div>
                    <span className="habit-snap-chevron">{open ? '▾' : '▸'}</span>
                  </button>
                  {open && (
                    <div className="habit-snap-body">
                      <div className="habit-snap-row">
                        <span>Price</span>
                        <span>${(s.price ?? DEFAULT_PRICE).toFixed(2)}</span>
                      </div>
                      {(s.bonusPrice != null || !(s.levels?.length)) && (
                        <div className="habit-snap-row">
                          <span>Bonus</span>
                          <span>${(s.bonusPrice ?? DEFAULT_BONUS_PRICE).toFixed(2)}</span>
                        </div>
                      )}
                      {levelNames.length > 1 && (
                        <div className="habit-snap-levels">
                          <span className="habit-snap-levels-label">Levels</span>
                          <ol>
                            {levelNames.map((n, i) => {
                              const price = i === 0
                                ? (s.price ?? DEFAULT_PRICE)
                                : (s.levels?.[i - 1]?.price ?? DEFAULT_PRICE);
                              return (
                                <li key={i}>{n} · ${price.toFixed(2)}</li>
                              );
                            })}
                          </ol>
                        </div>
                      )}
                      {s.schedule && (
                        <div className="habit-snap-row">
                          <span>Schedule</span>
                          <span>
                            {s.schedule.type === 'daily' && 'Every day'}
                            {s.schedule.type === 'weekly' && `Weekdays: ${s.schedule.weekdays.join(',')}`}
                            {s.schedule.type === 'interval' && `Every ${s.schedule.every}d cooldown`}
                          </span>
                        </div>
                      )}
                      {s.sectionBefore && (
                        <div className="habit-snap-row">
                          <span>Section</span>
                          <span>{s.sectionBefore}</span>
                        </div>
                      )}
                      <button
                        className="btn-restore habit-snap-restore"
                        onClick={() => {
                          if (!window.confirm('Restore this habit’s name, levels, and settings from this snapshot? Completions stay as they are.')) return;
                          onRestore(s);
                          onClose();
                        }}
                      >
                        Restore this version
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
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
  snapshotCount: number;
  onSave:     (name: string, color: HabitColor, price: number, bonusPrice: number, sectionBefore: string, levels: HabitLevel[], schedule: HabitSchedule | undefined) => void;
  onCancel:   () => void;
  onDelete:   () => void;
  onArchive:  () => void;
  onHistory:  () => void;
}

// Draft level row in the editor — price kept as string for free typing
interface LevelDraft { name: string; price: string; }

function EditPanel({ habit, snapshotCount, onSave, onCancel, onDelete, onArchive, onHistory }: EditPanelProps) {

  const [name,          setName]          = useState(habit.name);
  const [color,         setColor]         = useState<string>(habit.color);
  const [price,         setPrice]         = useState<string>(String(habit.price      ?? DEFAULT_PRICE));
  const [bonusPrice,    setBonusPrice]    = useState<string>(String(habit.bonusPrice ?? DEFAULT_BONUS_PRICE));
  const [sectionBefore, setSectionBefore] = useState(habit.sectionBefore ?? '');
  const [levels,        setLevels]        = useState<LevelDraft[]>(
    (habit.levels ?? []).map(l => ({ name: l.name, price: String(l.price) }))
  );
  const [schedType,  setSchedType]  = useState<'daily'|'weekly'|'interval'>(habit.schedule?.type ?? 'daily');
  const [weekdays,   setWeekdays]   = useState<number[]>(
    habit.schedule?.type === 'weekly' ? habit.schedule.weekdays : [1, 2, 3, 4, 5]
  );
  const [intervalEvery, setIntervalEvery] = useState<string>(
    habit.schedule?.type === 'interval' ? String(habit.schedule.every) : '2'
  );
  const toggleWeekday = (d: number) =>
    setWeekdays(ws => ws.includes(d) ? ws.filter(x => x !== d) : [...ws, d]);
  const inputRef = useRef<HTMLInputElement>(null);

  const addLevel    = () => setLevels(ls => [...ls, { name: '', price: String(DEFAULT_PRICE) }]);
  const removeLevel = (idx: number) => setLevels(ls => ls.filter((_, i) => i !== idx));
  const updateLevel = (idx: number, patch: Partial<LevelDraft>) =>
    setLevels(ls => ls.map((l, i) => i === idx ? { ...l, ...patch } : l));
  const moveLevel   = (idx: number, dir: -1 | 1) => setLevels(ls => {
    const j = idx + dir;
    if (j < 0 || j >= ls.length) return ls;
    const next = [...ls];
    [next[idx], next[j]] = [next[j], next[idx]];
    return next;
  });

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
    // Keep only levels with a name; coerce price to a valid number
    const cleanLevels: HabitLevel[] = levels
      .filter(l => l.name.trim())
      .map(l => {
        const lp = parseFloat(l.price);
        return { name: l.name.trim(), price: Number.isFinite(lp) && lp >= 0 ? lp : DEFAULT_PRICE };
      });
    // Build schedule (undefined = every day)
    let schedule: HabitSchedule | undefined;
    if (schedType === 'weekly' && weekdays.length > 0) {
      schedule = { type: 'weekly', weekdays: [...new Set(weekdays)].sort((a, b) => a - b) };
    } else if (schedType === 'interval') {
      const every = Math.max(1, Math.floor(parseFloat(intervalEvery) || 1));
      schedule = { type: 'interval', every };
    }
    onSave(
      n,
      color,
      Number.isFinite(p)  && p  >= 0 ? p  : DEFAULT_PRICE,
      Number.isFinite(bp) && bp >= 0 ? bp : DEFAULT_BONUS_PRICE,
      sectionBefore.trim(),
      cleanLevels,
      schedule,
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
      <div className="levels-editor">
        <div className="levels-editor-head">
          <span className="levels-editor-title">Levels</span>
          <span className="levels-editor-hint">the habit name + “per completion” price is your base level; add bigger versions below</span>
        </div>
        {levels.map((lvl, i) => (
          <div className="level-row" key={i}>
            <div className="level-move">
              <button className="level-move-btn" onClick={() => moveLevel(i, -1)} disabled={i === 0} title="Move up">▲</button>
              <button className="level-move-btn" onClick={() => moveLevel(i, 1)} disabled={i === levels.length - 1} title="Move down">▼</button>
            </div>
            <input
              className="level-name-input"
              value={lvl.name}
              onChange={e => updateLevel(i, { name: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
              placeholder={`Level ${i + 1} name…`}
            />
            <span className="level-price-wrap">
              <span className="price-prefix">$</span>
              <input
                type="number" min="0" step="0.05" inputMode="decimal"
                className="level-price-input"
                value={lvl.price}
                onChange={e => updateLevel(i, { price: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
              />
            </span>
            <button className="level-remove" onClick={() => removeLevel(i)} title="Remove level">✕</button>
          </div>
        ))}
        <button className="level-add" onClick={addLevel}>+ Add level</button>
      </div>
      <div className="sched-editor">
        <div className="sched-seg">
          <button
            className={`sched-seg-btn${schedType === 'daily' ? ' active' : ''}`}
            onClick={() => setSchedType('daily')}
          >Every day</button>
          <button
            className={`sched-seg-btn${schedType === 'weekly' ? ' active' : ''}`}
            onClick={() => setSchedType('weekly')}
          >Days of week</button>
          <button
            className={`sched-seg-btn${schedType === 'interval' ? ' active' : ''}`}
            onClick={() => setSchedType('interval')}
          >Cooldown</button>
        </div>
        {schedType === 'weekly' && (
          <div className="sched-weekdays">
            {['S','M','T','W','T','F','S'].map((lbl, d) => (
              <button
                key={d}
                className={`sched-day${weekdays.includes(d) ? ' on' : ''}`}
                onClick={() => toggleWeekday(d)}
                title={['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d]}
              >{lbl}</button>
            ))}
          </div>
        )}
        {schedType === 'interval' && (
          <div className="sched-interval">
            <span>Hide for</span>
            <input
              type="number" min="1" step="1" inputMode="numeric"
              className="sched-interval-input"
              value={intervalEvery}
              onChange={e => setIntervalEvery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') onCancel(); }}
            />
            <span>days after completing</span>
          </div>
        )}
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
        <button
          className="btn-history"
          onClick={onHistory}
          title={snapshotCount > 0 ? `View ${snapshotCount} snapshot${snapshotCount === 1 ? '' : 's'}` : 'View habit history'}
        >
          <HistoryIcon />
          {snapshotCount > 0 && <span className="btn-history-count">{snapshotCount}</span>}
        </button>
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

// ─── LevelPicker — choose the active level for a habit (portal popover) ───────

interface LevelPickerProps {
  habit: Habit;
  onPick:  (level: number) => void;
  onClose: () => void;
}

function LevelPicker({ habit, onPick, onClose }: LevelPickerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const levels = effectiveLevels(habit); // base + extras
  const active = Math.min(habit.activeLevel ?? 0, Math.max(0, levels.length - 1));

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 80);
    document.addEventListener('keydown', key);
    return () => { clearTimeout(id); document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', key); };
  }, [onClose]);

  const pos = useAnchoredPosition(
    () => {
      const el = document.querySelector(`[data-hid="${CSS.escape(habit.id)}"]`);
      return el ? (el as HTMLElement).getBoundingClientRect() : null;
    },
    panelRef,
  );

  return createPortal(
    <div
      ref={panelRef}
      className="level-picker"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <div className="level-picker-head">Active level for <strong>{habit.name}</strong></div>
      <div className="level-picker-sub">New completions use this level. Middle-click a day for the top level.</div>
      {levels.map((lvl, i) => (
        <button
          key={i}
          className={`level-picker-item${i === active ? ' active' : ''}`}
          onClick={() => { onPick(i); onClose(); }}
        >
          <span className="level-picker-dot" style={{ background: getPalette(habit.color)[Math.min(2 + i, 7)] }} />
          <span className="level-picker-name">{lvl.name}</span>
          <span className="level-picker-price">${lvl.price.toFixed(2)}</span>
        </button>
      ))}
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
  onOpenLevelPicker: (id: string) => void;
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
    editMode, isEditing, onOpenEdit, onOpenLevelPicker, analyticsView,
    isDragging, isDragOver, onDragStartRow, onDragOverRow, onDropRow, onDragEndRow }: RowProps
) {
  const nameRef = useRef<HTMLDivElement>(null);
  const comp  = useMemo(() => new Set(habit.completions), [habit.completions]);
  const skip  = useMemo(() => new Set(habit.skips),       [habit.skips]);
  const fail  = useMemo(() => new Set(habit.fails),       [habit.fails]);
  const bonus = useMemo(() => new Set(habit.bonuses ?? []), [habit.bonuses]);
  const cur  = useMemo(() => calcCurrentStreak(habit), [habit]);
  const lon  = useMemo(() => calcLongestStreak(habit), [habit]);
  const acc  = getAccent(habit.color);
  const doneToday = comp.has(fmt(todayNoon()));   // completed for today?
  const urgeMax   = lon > 0 && cur >= lon && !doneToday; // at record run but today not done yet

  const hasLevels   = habitHasLevels(habit);
  const levels      = useMemo(() => effectiveLevels(habit), [habit]); // base + extras
  const dayLevels   = habit.dayLevels ?? {};
  // Sidebar name is clickable (to pick level) only in non-edit mode with levels defined
  const nameClickable = hasLevels && !editMode;
  const activeLevelIdx = Math.min(habit.activeLevel ?? 0, Math.max(0, levels.length - 1));
  const displayName = hasLevels ? levels[activeLevelIdx].name : habit.name;

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
        {nameClickable ? (
          <button
            className="habit-name-btn"
            onClick={() => onOpenLevelPicker(habit.id)}
            title={`${displayName} — click to change level`}
          >
            <span className="habit-name-text">{displayName}</span>
          </button>
        ) : (
          <span className="habit-name-text">{displayName}</span>
        )}
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
        const str   = (done || skpd) ? streakAt(habit, ds) : 0;
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

        // Level indicator: subtle bar only for completions ABOVE the base level,
        // so base-level days look like normal completions (no mark).
        const dayLvl = (done && hasLevels) ? Math.min(dayLevels[ds] ?? 0, levels.length - 1) : 0;
        const showLevelBar = done && hasLevels && dayLvl >= 1;
        const levelFrac = showLevelBar ? (dayLvl + 1) / levels.length : 0;

        // Off-day: this habit isn't scheduled on this date and nothing's logged.
        const offDay = !done && !skpd && !faild && !isScheduledOn(habit, ds);

        return (
          <div
            key={`${habit.id}-${i}`}
            className={`cell habit-cell${isTd ? ' today-col' : ''}${faild ? ' failed-cell' : ''}${hasComment ? ' has-comment' : ''}${bns ? ' bonus-cell' : ''}${offDay ? ' off-day' : ''}`}
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
            {showLevelBar && (
              <div
                className="cell-level-bar"
                style={{
                  width: `${levelFrac * 78}%`,
                  background: getPalette(habit.color)[Math.min(intensityIdx(str) + 3, 7)],
                }}
                title={`${levels[dayLvl].name} · $${levels[dayLvl].price.toFixed(2)}`}
              />
            )}
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

interface DayPip { id: string; name: string; color: string; done: boolean; bonus: boolean; earned: number; }

const DailyProgress = memo(function DailyProgress(
  { pips, done, total, viewingToday, daySeed, earned, dayStreak, tools }: {
    pips: DayPip[]; done: number; total: number; viewingToday: boolean;
    daySeed: number; earned: number; dayStreak: number; tools?: React.ReactNode;
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
              title={`${p.name}${p.done ? ` \u2014 $${p.earned.toFixed(2)}` : ''}`}
            >
              {p.bonus ? '$' : ''}
            </span>
          ))}
          {total === 0 && <span className="dp-pip-empty">No habits yet</span>}
        </div>

        <div className="dp-bottom">
          <div className="dp-quote">
            <span className="dp-quote-text">{quote.text}</span>
            <span className="dp-quote-source">{'\u2014 '}{quote.source}</span>
          </div>
          {tools}
        </div>
      </div>
    </section>
  );
});

// ─── MoneyMenu — top-right balance with a hover "spend" popover ──────────────

const MoneyMenu = memo(function MoneyMenu(
  { earned, spent, lastSpend, onSpend }: {
    earned: number; spent: number; lastSpend: number; onSpend: (amt: number) => void;
  }
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
            <div className="money-menu-row">
              <span>Last spent</span>
              <span className="mm-neg">
                {lastSpend > 0 ? `-$${lastSpend.toFixed(2)}` : '$0.00'}
              </span>
            </div>
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
  const [lastSpend,      setLastSpend]      = useState<number>(loadLastSpend);
  const [snapshots,      setSnapshots]      = useState<HabitSnapshot[]>(loadSnapshots);
  const [editMode,       setEditMode]       = useState(false);
  const [showAllHabits,  setShowAllHabits]  = useState(false);
  const [editingId,      setEditingId]      = useState<string | null>(null);
  const [levelPickerId,  setLevelPickerId]  = useState<string | null>(null);
  const [draggingId,     setDraggingId]     = useState<string | null>(null);
  const [dragOverId,     setDragOverId]     = useState<string | null>(null);
  const [analyticsView,  setAnalyticsView]  = useState<0 | 1 | 2>(0);
  const [syncStatus,  setSyncStatus]  = useState<'idle'|'syncing'|'synced'|'error'>('idle');
  const [syncToast,   setSyncToast]   = useState<{ type: 'success'|'error'; msg: string } | null>(null);
  const [showSyncHistory, setShowSyncHistory] = useState(false);
  const [historyHabitId,  setHistoryHabitId]  = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((type: 'success'|'error', msg: string) => {
    setSyncToast({ type, msg });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setSyncToast(null), 5000);
  }, []);
  const [showArchive,    setShowArchive]    = useState(false);
  const [commentTarget,  setCommentTarget]  = useState<{ id: string; ds: string; rect: DOMRect } | null>(null);
  const [commentTooltip, setCommentTooltip] = useState<{ text: string; ds: string; rect: DOMRect } | null>(null);
  const addBtnRef    = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const syncTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstLoad  = useRef(true);
  const habitsRef    = useRef<Habit[]>(habits);
  const spentRef     = useRef<number>(spent);
  const lastSpendRef = useRef<number>(lastSpend);
  const snapshotsRef = useRef<HabitSnapshot[]>(snapshots);

  const vw     = useViewportWidth();
  const layout = useMemo(() => getLayout(vw), [vw]);

  const dates        = useMemo(() => getVisibleDates(offset, layout.daysBack), [offset, layout.daysBack]);
  const isCurrentDay = offset === 0;

  // Split into active (visible) and archived
  const visibleHabits  = useMemo(() => habits.filter(h => !h.archived), [habits]);
  const archivedHabits = useMemo(() => habits.filter(h =>  h.archived), [habits]);

  useEffect(() => { localStorage.setItem(SPENT_KEY, String(spent)); spentRef.current = spent; }, [spent]);
  useEffect(() => {
    localStorage.setItem(LAST_SPEND_KEY, String(lastSpend));
    lastSpendRef.current = lastSpend;
  }, [lastSpend]);
  useEffect(() => {
    localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(snapshots));
    snapshotsRef.current = snapshots;
  }, [snapshots]);

  const buildPayload = useCallback((): SyncPayload => ({
    habits: habitsRef.current,
    spent: spentRef.current,
    lastSpend: lastSpendRef.current,
    snapshots: snapshotsRef.current,
  }), []);

  const spend = useCallback((amt: number) => {
    setSpent(s => Math.max(0, Math.round((s + amt) * 100) / 100));
    if (amt > 0) setLastSpend(Math.round(amt * 100) / 100);
    else setLastSpend(0);
  }, []);

  // Persist locally + debounce cloud push (silent background — errors shown via dot only)
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(habits));
    if (isFirstLoad.current) return;
    if (!isSyncConfigured()) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    setSyncStatus('syncing');
    syncTimer.current = setTimeout(() => {
      pushRemote(buildPayload()).then(result => {
        setSyncStatus(result.ok ? 'synced' : 'error');
      });
    }, 1500);
  }, [habits, buildPayload]);

  // Also push when spent / lastSpend / snapshots change (debounced separately)
  const spentSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isFirstLoad.current) return;
    if (!isSyncConfigured()) return;
    if (spentSyncTimer.current) clearTimeout(spentSyncTimer.current);
    spentSyncTimer.current = setTimeout(() => {
      pushRemote(buildPayload()).then(result => {
        setSyncStatus(result.ok ? 'synced' : 'error');
      });
    }, 1500);
  }, [spent, lastSpend, snapshots, buildPayload]);

  useEffect(() => {
    habitsRef.current = habits;
    spentRef.current = spent;
    lastSpendRef.current = lastSpend;
    snapshotsRef.current = snapshots;
  }, [habits, spent, lastSpend, snapshots]);

  useEffect(() => {
    if (!isSyncConfigured()) return;
    setSyncStatus('syncing');
    fetchRemote<unknown>()
      .then(result => {
        if (!result.ok) { setSyncStatus('error'); return; }
        const parsed = parseRemotePayload(result.data);

        if (parsed.habits && parsed.habits.length > 0) {
          setHabits(parsed.habits);
          if (parsed.spent !== null) setSpent(parsed.spent);
          if (parsed.lastSpend !== null) setLastSpend(parsed.lastSpend);
          if (parsed.snapshots !== null) setSnapshots(parsed.snapshots);
        } else {
          // Nothing valid on remote — push local state to initialise
          pushRemote(buildPayload());
        }
        setSyncStatus('synced');
      })
      .finally(() => { isFirstLoad.current = false; });
  }, [buildPayload]);


  // Remove a date key from a dayLevels map (returns undefined if it empties out)
  const dropDayLevel = (dayLevels: Record<string, number> | undefined, ds: string) => {
    if (!dayLevels || !(ds in dayLevels)) return dayLevels;
    const { [ds]: _drop, ...rest } = dayLevels;
    return Object.keys(rest).length ? rest : undefined;
  };

  // Cycle: empty → done → skip → fail → empty
  const toggle = useCallback((id: string, ds: string) => {
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h;
      const done = h.completions.includes(ds);
      const skpd = h.skips.includes(ds);
      const fail = h.fails.includes(ds);
      const dropBonus = (h.bonuses ?? []).filter(b => b !== ds);
      const hasLevels = habitHasLevels(h);
      if (!done && !skpd && !fail) {
        // empty → done: record at the habit's active level (index into effective levels)
        const dayLevels = hasLevels
          ? { ...(h.dayLevels ?? {}), [ds]: Math.min(h.activeLevel ?? 0, effectiveLevels(h).length - 1) }
          : h.dayLevels;
        return { ...h, completions: [...h.completions, ds], dayLevels };
      }
      if (done)
        return { ...h, completions: h.completions.filter(c => c !== ds), skips: [...h.skips, ds], bonuses: dropBonus, dayLevels: dropDayLevel(h.dayLevels, ds) };
      if (skpd)
        return { ...h, skips: h.skips.filter(s => s !== ds), fails: [...h.fails, ds] };
      return { ...h, fails: h.fails.filter(f => f !== ds) };
    }));
  }, []);

  // Middle-click: complete at the HIGHEST level (or, if no levels, the legacy $1 bonus)
  const toggleBonus = useCallback((id: string, ds: string) => {
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h;
      const hasLevels = habitHasLevels(h);

      if (hasLevels) {
        const topIdx = effectiveLevels(h).length - 1;
        const alreadyTop = h.completions.includes(ds) && (h.dayLevels?.[ds] ?? 0) === topIdx;
        if (alreadyTop)
          // already at top level → clear back to empty
          return { ...h, completions: h.completions.filter(c => c !== ds), dayLevels: dropDayLevel(h.dayLevels, ds) };
        return {
          ...h,
          completions: h.completions.includes(ds) ? h.completions : [...h.completions, ds],
          skips: h.skips.filter(s => s !== ds),
          fails: h.fails.filter(f => f !== ds),
          dayLevels: { ...(h.dayLevels ?? {}), [ds]: topIdx },
        };
      }

      // Legacy behavior: middle-click toggles a $1 bonus completion
      const bonuses = h.bonuses ?? [];
      if (bonuses.includes(ds))
        return { ...h, completions: h.completions.filter(c => c !== ds), bonuses: bonuses.filter(b => b !== ds) };
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

  const saveEdit = useCallback((name: string, color: HabitColor, price: number, bonusPrice: number, sectionBefore: string, levels: HabitLevel[], schedule: HabitSchedule | undefined) => {
    const nextVals = { name, color, price, bonusPrice, sectionBefore, levels, schedule };
    const current = habitsRef.current.find(h => h.id === editingId);
    if (current && defChanged(current, nextVals)) {
      setSnapshots(snaps => [snapshotFromHabit(current), ...snaps]);
    }
    setHabits(prev => prev.map(h => {
      if (h.id !== editingId) return h;
      const hasLevels = levels.length > 0;
      const maxIdx = levels.length; // effective levels = base(0) + extras → max index = extras count
      // Clamp existing per-day levels into the new range (drop entirely if no levels)
      let dayLevels = h.dayLevels;
      if (!hasLevels) {
        dayLevels = undefined;
      } else if (dayLevels) {
        dayLevels = Object.fromEntries(
          Object.entries(dayLevels).map(([k, v]) => [k, Math.min(v, maxIdx)])
        );
      }
      const activeLevel = hasLevels ? Math.min(h.activeLevel ?? 0, maxIdx) : undefined;
      return {
        ...h, name, color, price, bonusPrice,
        sectionBefore: sectionBefore || undefined,
        levels: hasLevels ? levels : undefined,
        dayLevels,
        activeLevel,
        schedule,
      };
    }));
    setEditingId(null);
  }, [editingId]);

  const restoreHabitSnapshot = useCallback((snap: HabitSnapshot) => {
    const current = habitsRef.current.find(h => h.id === snap.habitId);
    if (current) {
      setSnapshots(snaps => [snapshotFromHabit(current), ...snaps]);
    }
    setHabits(prev => prev.map(h => {
      if (h.id !== snap.habitId) return h;
      const levels = snap.levels?.length ? snap.levels.map(l => ({ ...l })) : undefined;
      const hasLevels = (levels?.length ?? 0) > 0;
      const maxIdx = levels?.length ?? 0;
      let dayLevels = h.dayLevels;
      if (!hasLevels) {
        dayLevels = undefined;
      } else if (dayLevels) {
        dayLevels = Object.fromEntries(
          Object.entries(dayLevels).map(([k, v]) => [k, Math.min(v, maxIdx)])
        );
      }
      return {
        ...h,
        name: snap.name,
        color: snap.color,
        price: snap.price,
        bonusPrice: snap.bonusPrice,
        levels,
        schedule: snap.schedule ? structuredClone(snap.schedule) : undefined,
        sectionBefore: snap.sectionBefore,
        dayLevels,
        activeLevel: hasLevels ? Math.min(h.activeLevel ?? 0, maxIdx) : undefined,
      };
    }));
    setEditingId(null);
    showToast('success', 'Habit restored from snapshot');
  }, [showToast]);

  // Set the currently-active level for a habit (used for new completions)
  const setActiveLevel = useCallback((id: string, level: number) => {
    setHabits(prev => prev.map(h => h.id === id ? { ...h, activeLevel: level } : h));
  }, []);

  const deleteHabit = useCallback(() => {
    if (!window.confirm('Delete this habit?')) return;
    setHabits(prev => prev.filter(h => h.id !== editingId));
    setEditingId(null);
  }, [editingId]);

  const archiveHabit = useCallback(() => {
    setHabits(prev => prev.map(h => h.id === editingId ? { ...h, archived: true } : h));
    setEditingId(null);
  }, [editingId]);

  // Manual sync: push current habits and pull remote, with toast feedback
  const syncNow = useCallback(async () => {
    if (!isSyncConfigured()) {
      showToast('error', 'Sync not configured — add VITE_GIST_ID and VITE_GITHUB_TOKEN in Vercel settings');
      return;
    }
    setSyncStatus('syncing');
    // Push first so remote always has our latest
    const pushResult = await pushRemote(buildPayload());
    if (!pushResult.ok) {
      setSyncStatus('error');
      showToast('error', `Push failed: ${pushResult.error}`);
      return;
    }
    // Then pull to confirm round-trip
    const fetchResult = await fetchRemote<unknown>();
    if (!fetchResult.ok) {
      setSyncStatus('error');
      showToast('error', `Push succeeded but pull failed: ${fetchResult.error}`);
      return;
    }
    setSyncStatus('synced');
    showToast('success', 'Synced to cloud ✓');
  }, [showToast, buildPayload]);

  const restoreCloudRevision = useCallback(async (sha: string) => {
    setSyncStatus('syncing');
    const result = await fetchRevision<unknown>(sha);
    if (!result.ok) {
      setSyncStatus('error');
      showToast('error', `Could not load revision: ${result.error}`);
      throw new Error(result.error);
    }
    const parsed = parseRemotePayload(result.data);
    if (!parsed.habits || parsed.habits.length === 0) {
      setSyncStatus('error');
      const msg = 'That revision has no habits to restore.';
      showToast('error', msg);
      throw new Error(msg);
    }
    setHabits(parsed.habits);
    if (parsed.spent !== null) setSpent(parsed.spent);
    if (parsed.lastSpend !== null) setLastSpend(parsed.lastSpend);
    if (parsed.snapshots !== null) setSnapshots(parsed.snapshots);
    // Push restored state as the new HEAD so other devices pick it up
    const pushResult = await pushRemote({
      habits: parsed.habits,
      spent: parsed.spent ?? spentRef.current,
      lastSpend: parsed.lastSpend ?? lastSpendRef.current,
      snapshots: parsed.snapshots ?? snapshotsRef.current,
    });
    if (!pushResult.ok) {
      setSyncStatus('error');
      showToast('error', `Restored locally but push failed: ${pushResult.error}`);
      return;
    }
    setSyncStatus('synced');
    showToast('success', 'Restored previous cloud version ✓');
  }, [showToast]);

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

  const openLevelPicker = useCallback((id: string) => {
    setLevelPickerId(id);
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

  // Per-habit pricing: per-level price when levels exist, else bonus/flat price
  const totalMoney = useMemo(() => habits.reduce((sum, h) =>
    sum + h.completions.reduce((s, ds) => s + priceForDay(h, ds), 0),
  0), [habits]);
  const dailyCount = useCallback((ds: string) =>
    visibleHabits.filter(h => h.completions.includes(ds)).length,
  [visibleHabits]);

  // Today's progress (always real "today", regardless of which day is in view).
  // Only habits actually due today count toward the ring / pips.
  const todayStr = fmt(todayNoon());
  const todayPips = useMemo(
    () => visibleHabits.filter(h => isScheduledOn(h, todayStr)).map(h => {
      const done = h.completions.includes(todayStr);
      return {
        id: h.id, name: h.name, color: h.color,
        done,
        bonus: (h.bonuses ?? []).includes(todayStr),
        earned: done ? priceForDay(h, todayStr) : 0,
      };
    }),
    [visibleHabits, todayStr],
  );
  const todayDone  = todayPips.filter(p => p.done).length;
  const todayMoney = todayPips.reduce((s, p) => s + p.earned, 0);
  const dayStreak  = useMemo(() => calcDayStreak(visibleHabits), [visibleHabits]);

  // Rows to render: in edit mode or with the eyeball on, show every habit;
  // otherwise show only habits due today.
  const shownHabits = useMemo(
    () => (editMode || showAllHabits)
      ? visibleHabits
      : visibleHabits.filter(h => isScheduledOn(h, todayStr)),
    [visibleHabits, editMode, showAllHabits, todayStr],
  );
  const hiddenCount = visibleHabits.length - shownHabits.length;
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
  const levelPickerHabit = levelPickerId ? visibleHabits.find(h => h.id === levelPickerId) : null;

  return (
    <div className={`app${isMobile ? ' mobile' : ''}`} style={{ '--row-h': `${rowH}px` } as React.CSSProperties}>
      {/* ── Unified header (toolbar + daily progress) ── */}
      <header className={`app-header${todayDone > 0 && todayDone === todayPips.length && todayPips.length > 0 ? ' is-complete' : ''}`}>
        <DailyProgress
          pips={todayPips}
          done={todayDone}
          total={todayPips.length}
          viewingToday={isCurrentDay}
          daySeed={daySeed}
          earned={todayMoney}
          dayStreak={dayStreak}
          tools={
            <div className="app-header-tools">
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
                <button
                  className={`sync-btn sync-btn-${syncStatus}`}
                  onClick={syncNow}
                  disabled={syncStatus === 'syncing'}
                  title={
                    !isSyncConfigured()       ? 'Sync not configured — click for details' :
                    syncStatus === 'syncing'  ? 'Syncing…' :
                    syncStatus === 'synced'   ? 'Saved to cloud — click to sync now' :
                    syncStatus === 'error'    ? 'Sync error — click to retry' :
                                               'Click to sync now'
                  }
                >
                  <SyncIcon spinning={syncStatus === 'syncing'} />
                </button>
                <button
                  className="data-btn"
                  onClick={() => {
                    if (!isSyncConfigured()) {
                      showToast('error', 'Sync not configured — add VITE_GIST_ID and VITE_GITHUB_TOKEN in Vercel settings');
                      return;
                    }
                    setShowSyncHistory(true);
                  }}
                  title="Restore a previous cloud sync"
                >
                  <HistoryIcon />
                </button>
                <MoneyMenu earned={totalMoney} spent={spent} lastSpend={lastSpend} onSpend={spend} />
                {!isMobile && <span className="username">Kevin ▾</span>}
              </div>
            </div>
          }
        />
      </header>

      {/* ── Sync toast ── */}
      {syncToast && (
        <div className={`sync-toast sync-toast-${syncToast.type}`} role="alert">
          <span className="sync-toast-msg">{syncToast.msg}</span>
          <button className="sync-toast-close" onClick={() => setSyncToast(null)}>✕</button>
        </div>
      )}

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
                  className={`eye-btn${showAllHabits ? ' active' : ''}`}
                  onClick={() => setShowAllHabits(v => !v)}
                  disabled={editMode}
                  title={
                    editMode ? 'All habits shown while editing'
                    : showAllHabits ? 'Showing all habits — click to show only today’s'
                    : hiddenCount > 0 ? `Showing today’s habits (${hiddenCount} hidden) — click to show all`
                    : 'Showing all habits'
                  }
                >
                  {showAllHabits || editMode ? <EyeIcon /> : <EyeOffIcon />}
                </button>
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
            {shownHabits.map(habit => (
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
                onOpenLevelPicker={openLevelPicker}
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
          snapshotCount={snapshots.filter(s => s.habitId === editingHabit.id).length}
          onSave={saveEdit}
          onCancel={cancelEdit}
          onDelete={deleteHabit}
          onArchive={archiveHabit}
          onHistory={() => {
            setHistoryHabitId(editingHabit.id);
            setEditingId(null);
          }}
        />
      )}

      {/* ── Level Picker ── */}
      {levelPickerHabit && (
        <LevelPicker
          habit={levelPickerHabit}
          onPick={lvl => setActiveLevel(levelPickerHabit.id, lvl)}
          onClose={() => setLevelPickerId(null)}
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

      {/* ── Cloud sync history ── */}
      {showSyncHistory && (
        <SyncHistoryPanel
          onRestore={restoreCloudRevision}
          onClose={() => setShowSyncHistory(false)}
        />
      )}

      {/* ── Habit definition history ── */}
      {historyHabitId && (() => {
        const h = habits.find(x => x.id === historyHabitId);
        return (
          <HabitHistoryPanel
            habitName={h?.name ?? 'Habit'}
            snapshots={snapshots.filter(s => s.habitId === historyHabitId)}
            onRestore={restoreHabitSnapshot}
            onClose={() => setHistoryHabitId(null)}
          />
        );
      })()}

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
function EyeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
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

function SyncIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      style={spinning ? { animation: 'spin 1s linear infinite' } : undefined}
    >
      <polyline points="1 4 1 10 7 10"/>
      <polyline points="23 20 23 14 17 14"/>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
      <path d="M3 3v5h5"/>
      <path d="M12 7v5l3 3"/>
    </svg>
  );
}
