import type { ChatBackendId } from "./chatBackend";

export interface ChatHistoryTicket {
  key: string;
  openGeneration: number;
  requestSequence: number;
  sendEpoch: number;
  deleteVersion: number;
  scope?: string;
  scopeVersion?: number;
}

export interface ChatSendReadiness {
  backendOfSession(key: string): ChatBackendId;
  agentOfSession(key: string): string;
  readyAgentIds: ReadonlySet<string>;
  connected: boolean;
  connectedBackends: ReadonlySet<string> | null;
  disabledBackends?: ReadonlySet<string>;
}

/**
 * Hermes 与 Shoggoth 必须精确到当前 agent 已就绪；未知 readiness 一律不放行。
 * OpenClaw 继续使用既有的断线排队/重连补发，传输连通性仍由 queueSendable 负责。
 */
export function canSendSession(key: string | null | undefined, readiness: ChatSendReadiness): boolean {
  if (!key) return false;
  const backend = readiness.backendOfSession(key);
  if (readiness.disabledBackends?.has(backend)) return false;
  if (backend === "openclaw") return true;
  return readiness.connected
    && readiness.connectedBackends?.has(backend) === true
    && readiness.readyAgentIds.has(readiness.agentOfSession(key));
}

export type ChatSendEntry =
  | "composerButton"
  | "composerEnter"
  | "immersiveButton"
  | "immersiveEnter"
  | "widget"
  | "slash"
  | "retry"
  | "flushQueue";

export interface ChatSendController {
  canSend(key: string | null | undefined): boolean;
  composerButton<T>(key: string | null | undefined, action: () => T): T | undefined;
  composerEnter<T>(key: string | null | undefined, action: () => T): T | undefined;
  immersiveButton<T>(key: string | null | undefined, action: () => T): T | undefined;
  immersiveEnter<T>(key: string | null | undefined, action: () => T): T | undefined;
  widget<T>(key: string | null | undefined, action: () => T): T | undefined;
  slash<T>(key: string | null | undefined, action: () => T): T | undefined;
  retry<T>(key: string | null | undefined, action: () => T): T | undefined;
  flushQueue<T>(key: string | null | undefined, action: () => T): T | undefined;
}

/** 所有发送入口共用同一个同步门禁，拒绝时不执行 action，因此不会改草稿或队列。 */
export function createChatSendController(canSend: (key: string | null | undefined) => boolean): ChatSendController {
  const run = <T,>(key: string | null | undefined, action: () => T): T | undefined =>
    canSend(key) ? action() : undefined;
  return {
    canSend,
    composerButton: run,
    composerEnter: run,
    immersiveButton: run,
    immersiveEnter: run,
    widget: run,
    slash: run,
    retry: run,
    flushQueue: run,
  };
}

export interface ChatHistoryControllerDeps<TMessage> {
  backendOfSession(key: string): ChatBackendId;
  agentOfSession(key: string): string;
  getCacheScope?(backendId: ChatBackendId): Promise<string | undefined>;
  /** @deprecated Compatibility for older controller fixtures. */
  getHermesScope?(): Promise<string | undefined>;
  getCached(scope: string, key: string): Promise<unknown[] | undefined>;
  putCached(scope: string, key: string, messages: unknown[]): Promise<void>;
  deleteCached(scope: string, key: string): Promise<void>;
  clearCachedExcept(scope: string): Promise<void>;
  prepare(key: string, messages: unknown[]): Promise<TMessage[]>;
  requestCanonical(key: string): Promise<unknown>;
  isInFlight(key: string): boolean;
  commitOpen(key: string, messages: TMessage[], cacheVisible: boolean): void;
  commitCanonical(key: string, messages: TMessage[], raw: unknown[]): void;
  commitFailure(key: string, error: unknown, cacheVisible: boolean): void;
}

export interface ChatHistoryController<TMessage> {
  bootstrap(key: string): Promise<void>;
  open(key: string): Promise<void>;
  load(key: string): Promise<void>;
  markSend(key: string, messages?: TMessage[]): void;
  markNeedsRevalidate(key: string): void;
  revalidateReady(readyAgentIds: Iterable<string>): Promise<void>;
  revalidateConnected(connectedBackends: Iterable<string>): Promise<void>;
  delete(key: string): Promise<void>;
  activeKey(): string | null;
}

/**
 * 管理缓存首屏与权威历史之间的竞态。这里不持有 React state，生产页面和 Electron
 * fixture 都通过相同的提交回调消费结果，避免测试一套、真实页面另一套。
 */
export function createChatHistoryController<TMessage>(
  deps: ChatHistoryControllerDeps<TMessage>,
): ChatHistoryController<TMessage> {
  let currentKey: string | null = null;
  // A user selection takes precedence while its cache/scope is still loading.
  let requestedKey: string | null = null;
  let generation = 0;
  const scopes = new Map<ChatBackendId, { scope: string; version: number }>();
  const requestSequences = new Map<string, number>();
  const sendEpochs = new Map<string, number>();
  const deleteVersions = new Map<string, number>();
  const deletedKeys = new Set<string>();
  const liveSnapshots = new Map<string, TMessage[]>();
  const pendingWrites = new Map<string, Set<Promise<void>>>();
  const cacheVisible = new Set<string>();
  const needsRevalidate = new Set<string>();

  type ScopeBinding = { scope: string; version: number };

  // 每张 open/canonical ticket 都要通过一次真实 scope 读取绑定数据源；旧摘要只能用于
  // 比较变化，不能作为请求失败时的 fallback，否则配置切换期间会把 B 的历史写进 A。
  const bindScope = async (backendId: ChatBackendId): Promise<ScopeBinding | undefined> => {
    let rawScope: string | undefined;
    try {
      rawScope = deps.getCacheScope
        ? await deps.getCacheScope(backendId)
        : backendId === "hermes"
          ? await deps.getHermesScope?.()
          : undefined;
    } catch {
      return undefined;
    }
    if (!rawScope) return undefined;
    // The server scope describes a runtime/config source. Prefix it with the
    // registry owner so two facades sharing one service can never share cache.
    const next = deps.getCacheScope ? `${backendId}:${rawScope}` : rawScope;
    const current = scopes.get(backendId);
    if (!current) {
      const binding = { scope: next, version: 1 };
      scopes.set(backendId, binding);
      if (!deps.getCacheScope) await deps.clearCachedExcept(next);
      return binding;
    }
    if (current.scope !== next) {
      const binding = { scope: next, version: current.version + 1 };
      scopes.set(backendId, binding);
      if (!deps.getCacheScope) await deps.clearCachedExcept(next);
      if (scopes.get(backendId) !== binding) return undefined;
      return binding;
    }
    return current;
  };

  const sameScope = (left: ScopeBinding | undefined, right: ScopeBinding | undefined): boolean =>
    !!left && !!right && left.scope === right.scope && left.version === right.version;

  const ticketCurrent = (ticket: ChatHistoryTicket): boolean =>
    currentKey === ticket.key
    && generation === ticket.openGeneration
    && requestSequences.get(ticket.key) === ticket.requestSequence
    && (deleteVersions.get(ticket.key) ?? 0) === ticket.deleteVersion
    && !deletedKeys.has(ticket.key);

  const removeUnverifiedWrite = async (scope: string, key: string): Promise<void> => {
    try {
      await deps.deleteCached(scope, key);
    } catch {
      // 缓存清理是 best-effort；实时历史仍应继续落 UI。
    }
  };

  const canonical = async (key: string, openGeneration = generation): Promise<void> => {
    const deleteVersion = deleteVersions.get(key) ?? 0;
    const backendId = deps.backendOfSession(key);
    const scopeBinding = await bindScope(backendId);
    if (
      currentKey !== key
      || generation !== openGeneration
      || deletedKeys.has(key)
      || (deleteVersions.get(key) ?? 0) !== deleteVersion
    ) return;
    const requestSequence = (requestSequences.get(key) ?? 0) + 1;
    requestSequences.set(key, requestSequence);
    const ticket: ChatHistoryTicket = {
      key,
      openGeneration,
      requestSequence,
      sendEpoch: sendEpochs.get(key) ?? 0,
      deleteVersion,
      ...(scopeBinding ? { scope: scopeBinding.scope, scopeVersion: scopeBinding.version } : {}),
    };
    if (!ticketCurrent(ticket)) return;
    try {
      const raw = await deps.requestCanonical(key);
      if (!Array.isArray(raw)) throw new Error("chat.history returned no messages array");
      const prepared = await deps.prepare(key, raw);
      if (!ticketCurrent(ticket)) return;

      if (scopeBinding) {
        // 写前必须再次成功解析并确认仍是这张 ticket 绑定的数据源。
        const beforeWrite = await bindScope(backendId);
        if (beforeWrite && !sameScope(scopeBinding, beforeWrite)) {
          needsRevalidate.add(key);
          return;
        }
        // 临时拿不到 scope 只跳过缓存；它不是 realtime 权威响应失败。
        if (beforeWrite && ticketCurrent(ticket)) {
          const write = deps.putCached(beforeWrite.scope, key, raw);
          const writes = pendingWrites.get(key) ?? new Set<Promise<void>>();
          writes.add(write);
          pendingWrites.set(key, writes);
          try {
            await write;
          } finally {
            writes.delete(write);
            if (!writes.size) pendingWrites.delete(key);
          }
          if (!ticketCurrent(ticket)) {
            await removeUnverifiedWrite(beforeWrite.scope, key);
            return;
          }
          // put 期间配置也可能切换；明确变化时 clearExcept 已清旧 scope 并使响应失效。
          // 临时不可用时删掉本次未经复验的写入，但 realtime 消息仍可提交。
          const afterWrite = await bindScope(backendId);
          if (!afterWrite) {
            await removeUnverifiedWrite(beforeWrite.scope, key);
          } else if (!sameScope(scopeBinding, afterWrite)) {
            needsRevalidate.add(key);
            return;
          }
          if (!ticketCurrent(ticket)) return;
        }
      }

      // 请求开始以后发生过本地发送时不能覆盖 optimistic 线程。仅有 in-flight 标记
      // 还不够：窗口重开后会恢复后台 Run，却没有本进程的 optimistic 快照；此时权威
      // 历史必须立即提交，否则用户 prompt 会一直缺席到 final 触发下一次刷新。
      if (!ticketCurrent(ticket)) return;
      if (
        (sendEpochs.get(key) ?? 0) !== ticket.sendEpoch
        || (deps.isInFlight(key) && liveSnapshots.has(key))
      ) return;

      cacheVisible.delete(key);
      needsRevalidate.delete(key);
      liveSnapshots.delete(key);
      deps.commitCanonical(key, prepared, raw);
    } catch (error) {
      if (!ticketCurrent(ticket)) return;
      needsRevalidate.add(key);
      deps.commitFailure(key, error, cacheVisible.has(key));
    }
  };

  const open = async (key: string): Promise<void> => {
    requestedKey = key;
    const openGeneration = ++generation;
    deletedKeys.delete(key);
    let prepared: TMessage[] = [];
    let visible = false;

    // 生成中的线程只信本次进程内的 optimistic/pending 快照。旧持久缓存一定早于刚发送
    // 的 user 气泡，切走再切回若读取它会让整轮看似消失。
    const live = liveSnapshots.get(key);
    if (live && deps.isInFlight(key)) {
      currentKey = key;
      cacheVisible.add(key);
      deps.commitOpen(key, live, true);
      void canonical(key, openGeneration);
      return;
    }

    const backendId = deps.backendOfSession(key);
    {
      const binding = await bindScope(backendId);
      if (generation !== openGeneration || deletedKeys.has(key)) return;
      if (binding) {
        const cached = await deps.getCached(binding.scope, key);
        if (generation !== openGeneration) return;
        const verified = await bindScope(backendId);
        if (!sameScope(binding, verified)) {
          if (generation === openGeneration && !deletedKeys.has(key)) await open(key);
          return;
        }
        if (Array.isArray(cached)) {
          prepared = await deps.prepare(key, cached);
          if (generation !== openGeneration) return;
          visible = true;
        }
      }
    }

    if (generation !== openGeneration || deletedKeys.has(key)) return;
    currentKey = key;
    if (visible) cacheVisible.add(key);
    else cacheVisible.delete(key);
    deps.commitOpen(key, prepared, visible);
    void canonical(key, openGeneration);
  };

  return {
    bootstrap: async (key) => {
      if (currentKey !== null || requestedKey !== null) return;
      await open(key);
    },
    open,
    load: async (key) => canonical(key, currentKey === key ? generation : -1),
    markSend: (key, messages) => {
      sendEpochs.set(key, (sendEpochs.get(key) ?? 0) + 1);
      if (Array.isArray(messages)) liveSnapshots.set(key, messages);
    },
    markNeedsRevalidate: (key) => {
      needsRevalidate.add(key);
    },
    revalidateReady: async (readyAgentIds) => {
      const ready = new Set(readyAgentIds);
      const key = currentKey;
      if (!key || !needsRevalidate.has(key) || !ready.has(deps.agentOfSession(key))) return;
      await canonical(key, generation);
    },
    revalidateConnected: async (connectedBackends) => {
      const connected = new Set(connectedBackends);
      const key = currentKey;
      if (!key || !needsRevalidate.has(key)) return;
      const backend = deps.backendOfSession(key);
      // Non-gateway runtimes also need exact Agent readiness; revalidateReady
      // owns that transition. OpenClaw keeps its reconnect behavior.
      if (backend !== "openclaw" || !connected.has(backend)) return;
      await canonical(key, generation);
    },
    delete: async (key) => {
      deletedKeys.add(key);
      if (requestedKey === key) requestedKey = null;
      deleteVersions.set(key, (deleteVersions.get(key) ?? 0) + 1);
      requestSequences.set(key, (requestSequences.get(key) ?? 0) + 1);
      if (currentKey === key) {
        currentKey = null;
        generation += 1;
      }
      needsRevalidate.delete(key);
      cacheVisible.delete(key);
      liveSnapshots.delete(key);
      const backendId = deps.backendOfSession(key);
      // 已经开始的 put 无法取消；先让它结束，再做最后一次删除，保证 delete 返回后不会复活。
      const writes = pendingWrites.get(key);
      if (writes?.size) await Promise.allSettled([...writes]);
      const knownSafeScope = scopes.get(backendId)?.scope;
      const binding = await bindScope(backendId);
      const scope = binding?.scope ?? knownSafeScope;
      if (scope) {
        try {
          await deps.deleteCached(scope, key);
        } catch {
          // 缓存删除失败不应反向阻断已经成功的 sessions.delete。
        }
      }
    },
    activeKey: () => currentKey,
  };
}
