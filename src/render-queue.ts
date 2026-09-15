/** Keep one active export and only the latest pending scene. */
export function createRenderQueue(onError: (error: unknown) => void) {
  let pending: (() => Promise<void>) | undefined;
  let running = false;
  let completion = Promise.resolve();
  async function drain() {
    try {
      while (pending) {
        const work = pending;
        pending = undefined;
        try { await work(); } catch (error) { onError(error); }
      }
    } finally { running = false; }
  }
  return {
    enqueue(work: () => Promise<void>): Promise<void> {
      pending = work;
      if (!running) {
        running = true;
        completion = drain();
      }
      return completion;
    },
    clear() { pending = undefined; },
  };
}
