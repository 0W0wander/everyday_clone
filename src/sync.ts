// Cloud sync via JSONBin.io
// VITE_JSONBIN_ID  — the bin ID from the URL (e.g. 6634abc12...)
// VITE_JSONBIN_KEY — your master key (starts with $2a$10$...)

const BIN_ID  = import.meta.env.VITE_JSONBIN_ID  as string | undefined;
const API_KEY = import.meta.env.VITE_JSONBIN_KEY as string | undefined;
const BASE    = 'https://api.jsonbin.io/v3/b';

export function isSyncConfigured(): boolean {
  return !!(BIN_ID?.trim() && API_KEY?.trim());
}

export async function fetchRemote<T>(): Promise<T | null> {
  if (!isSyncConfigured()) return null;
  try {
    const res = await fetch(`${BASE}/${BIN_ID!.trim()}/latest`, {
      headers: {
        'X-Master-Key': API_KEY!.trim(),
        'X-Bin-Meta':   'false',   // skip metadata wrapper, get record directly
      },
    });
    if (!res.ok) {
      console.warn(`[sync] fetch failed: ${res.status}`);
      return null;
    }
    // JSONBin with X-Bin-Meta: false returns the record directly
    const data = await res.json();
    // Tolerate both {record: [...]} shape and raw array
    if (Array.isArray(data)) return data as T;
    if (data && Array.isArray(data.record)) return data.record as T;
    // Bin has unexpected content (e.g. integer 1) — return it as-is so the
    // caller can detect "bin exists but needs initialising" vs a real failure.
    return data as T;
  } catch (err) {
    console.warn('[sync] fetchRemote error', err);
    return null;
  }
}

export async function pushRemote<T>(data: T): Promise<void> {
  if (!isSyncConfigured()) return;
  try {
    const res = await fetch(`${BASE}/${BIN_ID!.trim()}`, {
      method:  'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': API_KEY!.trim(),
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      console.warn(`[sync] push failed: ${res.status}`);
    }
  } catch (err) {
    console.warn('[sync] pushRemote error', err);
  }
}
