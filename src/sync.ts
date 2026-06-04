// Cloud sync via GitHub Gist
//
// Setup (takes ~2 minutes):
//   1. Go to https://gist.github.com and create a new SECRET gist.
//      Name the file  everyday-habits.json  and put  []  as the content.
//      Copy the gist ID from the URL: gist.github.com/<user>/<GIST_ID>
//
//   2. Go to https://github.com/settings/tokens/new?scopes=gist
//      Give it any name, set expiry as you like, tick the "gist" scope.
//      Copy the generated token (starts with ghp_...).
//
//   3. Add both to your .env:
//        VITE_GIST_ID=<your gist id>
//        VITE_GITHUB_TOKEN=ghp_xxxxxxxxxxxx
//
// Limits: GitHub Gists support files up to ~10 MB — plenty for heavy journaling.
// Bonus:  every sync push creates a revision, so you get free version history.
// Rate:   5 000 authenticated requests / hour — far more than this app needs.

const GIST_ID = import.meta.env.VITE_GIST_ID     as string | undefined;
const GH_TOKEN = import.meta.env.VITE_GITHUB_TOKEN as string | undefined;

const FILENAME = 'everyday-habits.json';
const API_BASE = 'https://api.github.com';

function headers() {
  return {
    'Authorization': `Bearer ${GH_TOKEN!.trim()}`,
    'Accept':        'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function isSyncConfigured(): boolean {
  return !!(GIST_ID?.trim() && GH_TOKEN?.trim());
}

export async function fetchRemote<T>(): Promise<T | null> {
  if (!isSyncConfigured()) return null;
  try {
    const res = await fetch(`${API_BASE}/gists/${GIST_ID!.trim()}`, {
      headers: headers(),
    });
    if (!res.ok) {
      console.warn(`[sync] gist fetch failed: ${res.status}`);
      return null;
    }
    const gist = await res.json();
    const content = gist?.files?.[FILENAME]?.content;
    if (!content) return null;
    return JSON.parse(content) as T;
  } catch (err) {
    console.warn('[sync] fetchRemote error', err);
    return null;
  }
}

export async function pushRemote<T>(data: T): Promise<void> {
  if (!isSyncConfigured()) return;
  try {
    const res = await fetch(`${API_BASE}/gists/${GIST_ID!.trim()}`, {
      method:  'PATCH',
      headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: {
          [FILENAME]: { content: JSON.stringify(data) },
        },
      }),
    });
    if (!res.ok) {
      console.warn(`[sync] gist push failed: ${res.status}`);
    }
  } catch (err) {
    console.warn('[sync] pushRemote error', err);
  }
}
