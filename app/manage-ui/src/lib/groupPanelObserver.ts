/** One observation chain per mounted panel. A notification invalidates a revision, never starts work. */
export function createGroupPanelObserver<T>(options: {
  read(initial: boolean): Promise<T>; commit(value: T, initial: boolean): void; failed(error: unknown): void;
  visible?(): boolean; active?(): boolean; now?(): number; random?(): number;
  setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout;
}) {
  const now = options.now ?? Date.now, random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? setTimeout, clearTimer = options.clearTimer ?? clearTimeout;
  let disposed = false, dirtyRevision = 0, coveredRevision = -1, initial = true;
  let inFlight: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  let retry = 0, lastNotification = now(), lastSuccess = 0, timerAt = 0;
  const cancelTimer = () => { if (timer !== null) clearTimer(timer); timer = null; timerAt = 0; };
  const schedule = (delay: number) => {
    if (disposed) return;
    const at = now() + delay;
    // 持续通知只能提前已有恢复期限，不能推迟重试。
    if (timer !== null && timerAt <= at) return;
    cancelTimer(); timerAt = at;
    timer = setTimer(() => { timer = null; timerAt = 0; void load(); }, delay);
  };
  const load = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    cancelTimer();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let readPages = 0;
      do {
        const startedRevision = dirtyRevision, first = initial;
        try {
          const result = await options.read(first);
          if (disposed) return;
          options.commit(result, first);
          initial = false; retry = 0; coveredRevision = startedRevision; lastSuccess = now();
        } catch (error) {
          if (disposed) return;
          options.failed(error);
          schedule(Math.min(30_000, 800 * 2 ** Math.min(retry++, 6)) * (0.8 + random() * 0.4));
          return;
        }
        // 长增量分批读取，给渲染及其他请求留出机会。
        if (coveredRevision !== dirtyRevision && ++readPages >= 8) { schedule(1000); return; }
      } while (!disposed && coveredRevision !== dirtyRevision);
    })().finally(() => { inFlight = null; });
    return inFlight;
  };
  const invalidate = (immediate = true) => {
    if (disposed) return Promise.resolve();
    dirtyRevision++; lastNotification = now();
    if (inFlight) return inFlight;
    if (immediate) return load();
    schedule(150); return Promise.resolve();
  };
  const check = () => {
    // 首读及已有恢复期限由 retry 主导，watchdog 不抢跑 backoff。
    if (disposed || initial || timer !== null || inFlight || options.visible?.() === false) return;
    if (options.active?.() && now() - lastSuccess >= 3000) void invalidate();
    else if (now() - lastNotification >= 20_000 && now() - lastSuccess >= 20_000) void invalidate();
  };
  return { load, invalidate, check, snapshot: () => ({ dirtyRevision, coveredRevision, inFlight: !!inFlight, lastSuccess }),
    dispose: () => { disposed = true; cancelTimer(); } };
}
