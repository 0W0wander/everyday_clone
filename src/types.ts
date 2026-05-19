export type HabitColor = 'green' | 'blue' | 'yellow' | 'orange' | 'red' | 'purple' | 'teal';

export interface Habit {
  id: string;
  name: string;
  color: HabitColor;
  completions: string[]; // YYYY-MM-DD — fully completed days
  skips: string[];       // YYYY-MM-DD — skipped (count toward streak, shown as triangle)
  fails: string[];       // YYYY-MM-DD — failed (don't count toward streak, shown as ✕)
  isBreak?: boolean;
}
