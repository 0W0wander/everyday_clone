// Cloud sync via JSONBin.io — free, no login required in the app.
// Set VITE_JSONBIN_ID and VITE_JSONBIN_KEY in Vercel environment variables.

const BIN_ID  = import.meta.env.VITE_JSONBIN_ID as string | undefined;
const API_KEY = import.meta.env.VITE_JSONBIN_KEY as string | undefined;
const BASE    = 'https://api.jsonbin.io/v3/b';

export function isSyncConfigured(): boolean {
  return !!(BIN_ID && API_KEY);
}

export async function fetchRemote<T>(): Promise<T | null> {
  if (!isSyncConfigured()) return null;
  try {
    const res = await fetch(`${BASE}/${BIN_ID}/latest`, {
      headers: { 'X-Master-Key': API_KEY! },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.record as T;
  } catch {
    return null;
  }
}

export async function pushRemote<T>(data: T): Promise<void> {
  if (!isSyncConfigured()) return;
  await fetch(`${BASE}/${BIN_ID}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': API_KEY!,
    },
    body: JSON.stringify(data),
  });
}
