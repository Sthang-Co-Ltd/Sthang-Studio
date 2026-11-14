/** Bounded process-local reuse for deterministic prerequisites, never AI answers.
 * Invalidation retires both stored values and in-flight publication. Callers of
 * retired work join the current generation instead of consuming an old result.
 */
export function createPrerequisiteCache<Key, Value>(options: { maxEntries: number; ttlMs: number; now?: () => number }) {
  const now = options.now || Date.now;
  let generation = 0;
  const values = new Map<Key, { at: number; value: Value }>();
  const pending = new Map<Key, { generation: number; promise: Promise<Value> }>();
  return {
    invalidate() {
      generation += 1;
      values.clear();
      pending.clear();
    },
    async read(key: Key, load: () => Promise<Value>): Promise<Value> {
      for (;;) {
        const cached = values.get(key);
        if (cached && now() - cached.at < options.ttlMs) return cached.value;
        let entry = pending.get(key);
        if (!entry) {
          entry = { generation, promise: Promise.resolve().then(load) };
          pending.set(key, entry);
        }
        try {
          const value = await entry.promise;
          if (entry.generation !== generation) continue;
          if (pending.get(key) === entry) {
            pending.delete(key);
            for (const [oldKey, old] of values) if (now() - old.at >= options.ttlMs) values.delete(oldKey);
            if (values.size >= options.maxEntries) values.delete(values.keys().next().value!);
            values.set(key, { at: now(), value });
          }
          return value;
        } catch (error) {
          if (pending.get(key) === entry) pending.delete(key);
          if (entry.generation !== generation) continue;
          throw error;
        }
      }
    },
  };
}
