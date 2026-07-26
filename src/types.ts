export type HabitColor = string; // hex color, e.g. "#4ade80"

// When a habit is "due". Absent → daily (every day).
export type HabitSchedule =
  | { type: 'daily' }
  | { type: 'weekly'; weekdays: number[] }           // 0=Sun … 6=Sat
  | { type: 'interval'; every: number }; // hide for N days after each completion

// An optional intensity tier for a habit, e.g. "Go to gym" / "30 min" / "1 hour".
// Ordered smallest → largest. Each carries its own payout.
export interface HabitLevel {
  name: string;
  price: number;
}

/** Independent board header — sits in board order, not owned by a habit. */
export interface BoardSection {
  id: string;
  label: string;
}

/** Named snapshot of board layout (habit + section order) with optional weekday defaults. */
export interface BoardTemplate {
  id: string;
  name: string;
  boardOrder: string[];      // habit + section ids
  sections: BoardSection[];  // label snapshot for section ids in this template
  weekdays: number[];        // 0=Sun … 6=Sat; empty = manual-only
  /** habitId → activeLevel index to restore when this board is applied */
  habitLevels?: Record<string, number>;
  /** Habits inactive on this board (hidden; don't break streaks) */
  disabledHabitIds?: string[];
  /** Section headers omitted on this board (habits underneath stay) */
  hiddenSectionIds?: string[];
}

export interface Habit {
  id: string;
  name: string;
  color: HabitColor;
  completions: string[]; // YYYY-MM-DD — fully completed days
  skips: string[];       // YYYY-MM-DD — skipped (count toward streak, shown as triangle)
  fails: string[];       // YYYY-MM-DD — failed (don't count toward streak, shown as ✕)
  price?: number;        // $ earned per normal / base-level completion (default 0.10)
  levels?: HabitLevel[]; // extra intensity tiers above the base (name + price), smallest → largest
  dayLevels?: Record<string, number>; // YYYY-MM-DD → index into effectiveLevels[] for that day
  activeLevel?: number;  // currently selected level index for new completions
  schedule?: HabitSchedule; // when this habit is due; absent = every day
  isBreak?: boolean;
  archived?: boolean;
  comments?: Record<string, string>; // YYYY-MM-DD → free-text note
}

/** Point-in-time copy of a habit's editable definition (not day completions). */
export interface HabitSnapshot {
  id: string;
  habitId: string;
  at: string; // ISO timestamp
  name: string;
  color: HabitColor;
  price?: number;
  levels?: HabitLevel[];
  schedule?: HabitSchedule;
}
