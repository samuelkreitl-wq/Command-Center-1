/** In-process loop. A failed tick is logged and the next tick is still scheduled. */

export function createResilientLoop(opts: {
  intervalMs: number;
  tick: () => Promise<void>;
  onError?: (error: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}) {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  let stopped = false;
  let beats = 0;
  let timer: unknown = null;
  let running = false;

  async function iteration() {
    if (stopped) return;
    running = true;
    try {
      await opts.tick();
      beats += 1;
    } catch (error) {
      opts.onError?.(error);
    } finally {
      running = false;
      if (!stopped) timer = setTimer(() => { void iteration(); }, opts.intervalMs);
    }
  }

  return {
    start: () => iteration(),
    stop() {
      stopped = true;
      if (timer != null) clearTimer(timer);
    },
    get beats() { return beats; },
    get running() { return running; },
  };
}
