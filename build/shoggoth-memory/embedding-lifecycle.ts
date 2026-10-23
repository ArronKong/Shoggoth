// Product generation fences replace Gateway plugin reload lifecycle ownership.
export class MemoryManagerReloadError extends Error {
  constructor() { super("Memory provider is reloading; retry after the plugin operation completes."); }
}
