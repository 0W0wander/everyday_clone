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

export interface Habit {
  id: string;
  name: string;
  color: HabitColor;
  completions: string[]; // YYYY-MM-DD — fully completed days
  skips: string[];       // YYYY-MM-DD — skipped (count toward streak, shown as triangle)
  fails: string[];       // YYYY-MM-DD — failed (don't count toward streak, shown as ✕)
  bonuses?: string[];    // YYYY-MM-DD — completions worth the bonus price (middle-click)
  price?: number;        // $ earned per normal completion (default 0.10)
  bonusPrice?: number;   // $ earned per middle-click "bonus" completion (default 1.00)
  levels?: HabitLevel[]; // optional intensity tiers, smallest → largest
  dayLevels?: Record<string, number>; // YYYY-MM-DD → index into levels[] for that day
  activeLevel?: number;  // currently selected level index for new completions
  sectionBefore?: string; // if set, a named section divider renders above this habit
  schedule?: HabitSchedule; // when this habit is due; absent = every day
  isBreak?: boolean;
  archived?: boolean;
  comments?: Record<string, string>; // YYYY-MM-DD → free-text note
}
