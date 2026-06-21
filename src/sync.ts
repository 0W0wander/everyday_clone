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
//   3. Add both to your Vercel environment variables:
//        VITE_GIST_ID=<your gist id>
//        VITE_GITHUB_TOKEN=ghp_xxxxxxxxxxxx
//
// Limits: GitHub Gists support files up to ~10 MB — plenty for heavy journaling.
// Bonus:  every sync push creates a revision, so you get free version history.
// Rate:   5 000 authenticated requests / hour — far more than this app needs.

const GIST_ID  = import.meta.env.VITE_GIST_ID      as string | undefined;
const GH_TOKEN = import.meta.env.VITE_GITHUB_TOKEN  as string | undefined;

const FILENAME = 'everyday-habits.json';
const API_BASE = 'https://api.github.com';

function authHeaders() {
  return {
    'Authorization':        `Bearer ${GH_TOKEN!.trim()}`,
    'Accept':               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export function isSyncConfigured(): boolean {
  return !!(GIST_ID?.trim() && GH_TOKEN?.trim());
}

// ── Typed result so callers can show real error detail ────────────────────────

export type SyncOk<T>  = { ok: true;  data: T };
export type SyncErr    = { ok: false; error: string };
export type SyncResult<T> = SyncOk<T> | SyncErr;

// Translate an HTTP response into a human-readable error string.
async function httpError(res: Response): Promise<string> {
  const status = res.status;
  try {
    const body = await res.json() as { message?: string };
    const msg  = body?.message ?? res.statusText;
    if (status === 401) return `401 Unauthorized — check your VITE_GITHUB_TOKEN (is it expired?)`;
    if (status === 403) return `403 Forbidden — token may be missing the "gist" scope`;
    if (status === 404) return `404 Not found — check your VITE_GIST_ID`;
    if (status === 422) return `422 Validation failed — ${msg}`;
    return `HTTP ${status}: ${msg}`;
  } catch {
    return `HTTP ${status}: ${res.statusText}`;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchRemote<T>(): Promise<SyncResult<T>> {
  if (!isSyncConfigured()) return { ok: false, error: 'Sync not configured (missing env vars)' };
  try {
    const res = await fetch(`${API_BASE}/gists/${GIST_ID!.trim()}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return { ok: false, error: await httpError(res) };

    const gist    = await res.json();
    const content = gist?.files?.[FILENAME]?.content;
    if (!content) return { ok: false, error: `Gist found but file "${FILENAME}" is missing or empty` };

    const data = JSON.parse(content) as T;
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${msg}` };
  }
}

export async function pushRemote<T>(data: T): Promise<SyncResult<T>> {
  if (!isSyncConfigured()) return { ok: false, error: 'Sync not configured (missing env vars)' };
  try {
    const res = await fetch(`${API_BASE}/gists/${GIST_ID!.trim()}`, {
      method:  'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: { [FILENAME]: { content: JSON.stringify(data) } },
      }),
    });
    if (!res.ok) return { ok: false, error: await httpError(res) };
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Network error: ${msg}` };
  }
}
