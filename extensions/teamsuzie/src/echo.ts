const ECHO_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ECHO_MAX_SIZE = 50;

const cache = new Map<string, number>();

export function rememberSentEvent(eventId: string): void {
  if (cache.size >= ECHO_MAX_SIZE) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
  }
  cache.set(eventId, Date.now());
}

export function isSentEcho(eventId: string): boolean {
  const ts = cache.get(eventId);
  if (ts === undefined) {
    return false;
  }
  cache.delete(eventId);
  if (Date.now() - ts > ECHO_TTL_MS) {
    return false;
  }
  return true;
}
