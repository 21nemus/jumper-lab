// Small per-viewer preferences and best times in localStorage. Every access is guarded: private windows,
// blocked storage and quota errors simply mean nothing is remembered.

const PREFIX = 'jumper-lab:';

export const store = {
  get<T>(key: string): T | null {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* not remembered */
    }
  },
};
