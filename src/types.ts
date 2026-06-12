export type HabitColor = string; // hex color, e.g. "#4ade80"

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
  isBreak?: boolean;
  archived?: boolean;
  comments?: Record<string, string>; // YYYY-MM-DD → free-text note
}
