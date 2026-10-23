export const CHAT_HISTORY_PAGE_SIZE = 50;
export interface HistoryTransportPage<T> {
  messages: T[];
  hasMore: boolean;
  nextCursor: string | null;
  sourceId: string;
}
export interface HistoryWindow {
  start: number;
  count: number;
  needsEarlier: boolean;
}
interface HistoryState<T> {
  key: string;
  messages: T[];
  buffer: T[];
  cursor: string | null;
  exhausted: boolean;
  sourceId: string;
  expanded: boolean;
  token: string;
}
const failure = () => new Error("无法完整读取历史，请重试");

/**
 * Backend pages contain transport records. A display projection decides where
 * 50 user/assistant messages start, retaining their tool/thinking predecessors.
 * Candidates commit only after the existing history controller verifies owner,
 * navigation and send epochs. Failed reads never mutate the displayed window.
 */
export function createChatHistoryPager<T>(deps: {
  request(key: string, cursor: string | null): Promise<HistoryTransportPage<T>>;
  window(messages: T[], count: number, key: string): HistoryWindow;
  id(message: T): string;
}) {
  let activeKey = "", operation = 0;
  let generation = 0, queue = Promise.resolve();
  let committed: HistoryState<T> | null = null;
  const candidates = new WeakMap<T[], HistoryState<T>>();
  const releases = new WeakMap<T[], () => void>();
  const pending = new Set<() => void>();
  // Hold the reader through prepare/cache/owner checks, until commit or explicit
  // discard. A background refresh must not supersede a user's earlier-page click.
  const serial = async (key: string, read: () => Promise<T[]>) => {
    const epoch = generation, previous = queue;
    let done!: () => void;
    const complete = new Promise<void>(resolve => {
      done = () => { pending.delete(done); resolve(); };
    });
    pending.add(done);
    queue = previous.then(() => complete);
    await previous;
    try {
      if (epoch !== generation || key !== activeKey) throw failure();
      const messages = await read();
      releases.set(messages, done);
      return messages;
    } catch (error) { done(); throw error; }
  };
  const release = (messages: T[]) => {
    releases.get(messages)?.();
    releases.delete(messages);
    candidates.delete(messages);
  };
  const empty = (key: string): HistoryState<T> => ({
    key, messages: [], buffer: [], cursor: null, exhausted: false,
    sourceId: "", expanded: false, token: "",
  });
  const context = () => ({ bytes: 0, pages: 0, cursors: new Set<string>(), operation });
  type ReadContext = ReturnType<typeof context>;
  const fetchOlder = async (state: HistoryState<T>, read: ReadContext) => {
    if (read.operation !== operation || state.key !== activeKey) throw failure();
    if (++read.pages > 256) throw failure();
    const page = await deps.request(state.key, state.cursor);
    if (read.operation !== operation || state.key !== activeKey) throw failure();
    if (!Array.isArray(page?.messages) || typeof page.hasMore !== "boolean"
      || typeof page.sourceId !== "string" || !page.sourceId
      || (page.hasMore ? typeof page.nextCursor !== "string" || !page.nextCursor : page.nextCursor !== null)) throw failure();
    if (state.sourceId && state.sourceId !== page.sourceId) throw Object.assign(failure(), { code: "CHAT_HISTORY_CURSOR_INVALID" });
    read.bytes += new TextEncoder().encode(JSON.stringify(page.messages)).byteLength;
    if (read.bytes > 8 * 1024 * 1024) throw failure();
    if (page.hasMore && (page.nextCursor === state.cursor || read.cursors.has(page.nextCursor!))) throw failure();
    if (page.nextCursor) read.cursors.add(page.nextCursor);
    state.sourceId = page.sourceId;
    state.buffer = [...page.messages, ...state.buffer];
    state.cursor = page.nextCursor;
    state.exhausted = !page.hasMore;
  };
  const take = async (state: HistoryState<T>, read: ReadContext) => {
    while (true) {
      const window = deps.window(state.buffer, CHAT_HISTORY_PAGE_SIZE, state.key);
      if (state.exhausted || (window.count >= CHAT_HISTORY_PAGE_SIZE && !window.needsEarlier)) {
        let start = window.count < CHAT_HISTORY_PAGE_SIZE ? 0 : window.start;
        if (state.exhausted && !deps.window(state.buffer.slice(0, start), 1, state.key).count) start = 0;
        state.messages = [...state.buffer.slice(start), ...state.messages];
        state.buffer = state.buffer.slice(0, start);
        return;
      }
      await fetchOlder(state, read);
    }
  };
  const candidate = (state: HistoryState<T>, token: number) => {
    state.token = String(token);
    candidates.set(state.messages, state);
    return state.messages;
  };
  const copy = (state: HistoryState<T>) => ({ ...state, messages: state.messages.slice(), buffer: state.buffer.slice() });
  const first = async (key: string, read: ReadContext) => {
    const state = empty(key);
    await take(state, read);
    return state;
  };
  const recover = async (old: HistoryState<T>, read: ReadContext) => {
    const state = empty(old.key);
    const anchor = old.messages[0] && deps.id(old.messages[0]);
    while (true) {
      await fetchOlder(state, read);
      if (state.sourceId !== old.sourceId) break;
      const index = anchor ? state.buffer.findIndex(message => deps.id(message) === anchor) : -1;
      if (index >= 0) {
        state.messages = state.buffer.slice(index);
        state.buffer = state.buffer.slice(0, index);
        state.expanded = old.expanded;
        return { state, found: true };
      }
      if (state.exhausted) break;
    }
    // Reset/replaced transcript: only a fresh authoritative window survives.
    await take(state, read);
    return { state, found: false };
  };
  return {
    reset(key: string) {
      activeKey = key; committed = null; operation++; generation++;
      for (const done of pending) done();
      queue = Promise.resolve();
    },
    get current() { return committed; },
    sourceOf(messages: T[]) { return candidates.get(messages)?.sourceId; },
    get hasMore() { return !!committed && (committed.buffer.length > 0 || !committed.exhausted); },
    refresh(key: string) { return serial(key, async () => {
      const token = ++operation, old = committed?.key === key ? committed : null, read = context();
      const state = await first(key, read);
      if (old?.expanded && state.sourceId === old.sourceId && state.messages.length) {
        const oldIds = new Map(old.messages.map((message, index) => [deps.id(message), index]));
        while (true) {
          const overlap = state.messages.find(message => oldIds.has(deps.id(message)));
          if (overlap) {
            state.messages = [...old.messages.slice(0, oldIds.get(deps.id(overlap))), ...state.messages];
            state.buffer = old.buffer.slice();
            state.cursor = old.cursor;
            state.exhausted = old.exhausted;
            state.expanded = true;
            break;
          }
          if (state.exhausted && !state.buffer.length) {
            // The same logical session may have been reset/rewritten. A failed
            // overlap search must not expose the entire replacement transcript.
            state.buffer = state.messages;
            state.messages = [];
            await take(state, read);
            break;
          }
          await take(state, read);
        }
      }
      return candidate(state, token);
    }); },
    earlier(key: string) { return serial(key, async () => {
      const token = ++operation, old = committed;
      if (!old || old.key !== key) throw failure();
      let state = copy(old);
      const read = context();
      try {
        await take(state, read);
        state.expanded = true;
      } catch (error) {
        if (!/CURSOR/.test((error as { code?: string })?.code ?? "")) throw error;
        const recovered = await recover(old, context());
        state = recovered.state;
        if (recovered.found) {
          await take(state, context());
          state.expanded = true;
        }
      }
      return candidate(state, token);
    }); },
    release,
    commit(messages: T[]) {
      const state = candidates.get(messages);
      if (!state || state.key !== activeKey || state.token !== String(operation)) return false;
      committed = state;
      release(messages);
      return true;
    },
  };
}
