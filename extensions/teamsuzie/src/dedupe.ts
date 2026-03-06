const DEDUP_TTL_MS = 20 * 60 * 1000; // 20 minutes
const DEDUP_MAX_SIZE = 5000;

const cache = new Map<string, number>();

export function isDuplicate(eventId: string): boolean {
  pruneExpired();
  if (cache.has(eventId)) {
    return true;
  }
  if (cache.size >= DEDUP_MAX_SIZE) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
  }
  cache.set(eventId, Date.now());
  return false;
}

function pruneExpired(): void {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  for (const [key, ts] of cache) {
    if (ts < cutoff) {
      cache.delete(key);
    } else {
      break; // Map preserves insertion order; once we hit a fresh entry, rest are fresh
    }
  }
}
