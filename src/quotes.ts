// Motivational quotes for the Daily Progress band.
//
// Two themed collections:
//   • WAR_QUOTES  — Call of Duty-style loading-screen war quotes (historical figures)
//   • CIV_QUOTES  — Civilization VI technology / civic "unlock" narration quotes
//
// Selection is deterministic (see getQuote) so the quote only changes when your
// progress changes — every completed habit "unlocks" a fresh line.

export interface Quote {
  text: string;
  source: string;
}

// ── Rallying cries: shown at the start of the day (0 done) ──────────────────
export const START_QUOTES: Quote[] = [
  { text: 'A good plan violently executed now is better than a perfect plan executed next week.', source: 'George S. Patton' },
  { text: 'The true soldier fights not because he hates what is in front of him, but because he loves what is behind him.', source: 'G.K. Chesterton' },
  { text: 'Courage is not the absence of fear, but the triumph over it.', source: 'Nelson Mandela' },
  { text: 'It always seems impossible until it is done.', source: 'Nelson Mandela' },
  { text: 'Freedom is the sure possession of those alone who have the courage to defend it.', source: 'Pericles' },
  { text: 'I have not yet begun to fight!', source: 'John Paul Jones' },
  { text: 'The journey of a thousand miles begins with a single step.', source: 'Lao Tzu' },
];

// ── War quotes: shown while you push through the day (some done, not all) ────
export const WAR_QUOTES: Quote[] = [
  { text: 'If you know the enemy and know yourself, you need not fear the result of a hundred battles.', source: 'Sun Tzu' },
  { text: 'Never interrupt your enemy when he is making a mistake.', source: 'Napoleon Bonaparte' },
  { text: 'Cowards die many times before their deaths; the valiant never taste of death but once.', source: 'William Shakespeare' },
  { text: 'It is well that war is so terrible, otherwise we should grow too fond of it.', source: 'Robert E. Lee' },
  { text: 'The supreme art of war is to subdue the enemy without fighting.', source: 'Sun Tzu' },
  { text: 'Victory belongs to the most persevering.', source: 'Napoleon Bonaparte' },
  { text: 'Retreat? Hell, we just got here!', source: 'Capt. Lloyd Williams' },
  { text: 'We sleep safely at night because rough men stand ready to visit violence on those who would harm us.', source: 'attributed to George Orwell' },
  { text: 'Battles are won by slaughter and maneuver. The greater the general, the more he contributes in maneuver.', source: 'Winston Churchill' },
  { text: 'In war you can only be killed once, but in politics many times.', source: 'Winston Churchill' },
  { text: 'He who fears being conquered is sure of defeat.', source: 'Napoleon Bonaparte' },
];

// ── Civ VI tech / civic unlock quotes: every completed habit "unlocks" one ──
export const CIV_QUOTES: Quote[] = [
  { text: 'Once you have tasted flight, you will forever walk the earth with your eyes turned skyward.', source: 'Leonardo da Vinci \u2014 Flight' },
  { text: 'The laws of nature are but the mathematical thoughts of God.', source: 'Euclid \u2014 Mathematics' },
  { text: 'Astronomy compels the soul to look upwards, and leads us from this world to another.', source: 'Plato \u2014 Astronomy' },
  { text: 'He who destroys a good book kills reason itself.', source: 'John Milton \u2014 Writing' },
  { text: 'Do not wait to strike till the iron is hot; but make it hot by striking.', source: 'W.B. Yeats \u2014 Iron Working' },
  { text: 'I shot an arrow into the air. It fell to earth, I knew not where.', source: 'H.W. Longfellow \u2014 Archery' },
  { text: 'One machine can do the work of fifty ordinary men. No machine can do the work of one extraordinary man.', source: 'Elbert Hubbard \u2014 Engineering' },
  { text: 'He who would learn to pray, let him go to sea.', source: 'George Herbert \u2014 Sailing' },
  { text: 'Money often costs too much.', source: 'Ralph Waldo Emerson \u2014 Currency' },
  { text: 'Computers are like Old Testament gods: lots of rules and no mercy.', source: 'Joseph Campbell \u2014 Computers' },
  { text: 'I am as free as nature first made man, ere the base laws of servitude began.', source: 'John Dryden \u2014 Animal Husbandry' },
];

// ── Victory quotes: shown when every habit is done ──────────────────────────
export const VICTORY_QUOTES: Quote[] = [
  { text: 'Veni, vidi, vici. I came, I saw, I conquered.', source: 'Julius Caesar' },
  { text: 'Now this is not the end. It is not even the beginning of the end. But it is, perhaps, the end of the beginning.', source: 'Winston Churchill' },
  { text: 'There is no substitute for victory.', source: 'Douglas MacArthur' },
  { text: 'Discipline is the soul of an army. It makes small numbers formidable.', source: 'George Washington' },
  { text: 'The will to conquer is the first condition of victory.', source: 'Ferdinand Foch' },
  { text: 'We make our destinies by the choices we make.', source: 'Civilization VI' },
];

export const EMPTY_QUOTES: Quote[] = [
  { text: 'Every empire begins with a single decision. Add a habit to begin.', source: 'Civilization VI' },
];

// Deterministic, non-negative index into an array.
function pick<T>(arr: T[], seed: number): T {
  const i = ((seed % arr.length) + arr.length) % arr.length;
  return arr[i];
}

/**
 * Pick a quote for the current progress.
 * @param done    habits completed today
 * @param total   total active habits
 * @param daySeed a stable per-day number, so "start"/"victory" lines vary day to day
 */
export function getQuote(done: number, total: number, daySeed: number): Quote {
  if (total === 0) return pick(EMPTY_QUOTES, daySeed);
  if (done === 0) return pick(START_QUOTES, daySeed);
  if (done >= total) return pick(VICTORY_QUOTES, daySeed);

  // Mid-day: alternate between war cries and Civ unlock quotes as you progress,
  // keyed on how many you've completed so each habit reveals a new line.
  const pool = done % 2 === 0 ? WAR_QUOTES : CIV_QUOTES;
  return pick(pool, done - 1);
}
