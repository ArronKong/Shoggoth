// Model discovery can outlive a chat's first render. Keep failures visible and
// retry briefly without duplicate native CLI requests or an unbounded polling loop.
export function createModelCatalogRefresh({ load, onState }: {
  load: () => Promise<void>;
  onState: (state: { loading: boolean; error: boolean }) => void;
}) {
  const retryDelays = [1500, 5000];
  let retries = 0;
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  const clearRetry = () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight;
    clearRetry();
    onState({ loading: true, error: false });
    const request = Promise.resolve().then(load).then(() => {
      if (disposed) return;
      retries = 0;
      onState({ loading: false, error: false });
    }, (error: unknown) => {
      if (!disposed) {
        onState({ loading: false, error: true });
        if (retries < retryDelays.length) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            void refresh().catch(() => {});
          }, retryDelays[retries++]);
        }
      }
      throw error;
    }).finally(() => {
      if (inFlight === request) inFlight = null;
    });
    inFlight = request;
    return request;
  };

  return {
    refresh,
    dispose() {
      disposed = true;
      clearRetry();
    },
  };
}
