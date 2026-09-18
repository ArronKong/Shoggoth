// R116 低危修复共用的异步生命周期核心；页面与真实 renderer 回归使用同一实现。

export interface SettingsRefreshTicket {
  seq: number;
}

export interface SettingsTestTicket {
  key: string;
  seq: number;
  epoch: number;
}

// 管理 Settings 的挂载、配置刷新代际和逐连接测试代际。
export function createSettingsLifecycleGuard() {
  let mounted = false;
  let refreshSeq = 0;
  let testEpoch = 0;
  const testSeqByKey = new Map<string, number>();

  return {
    // React effect setup/cleanup 显式驱动挂载状态，兼容 StrictMode 重放。
    mount() {
      mounted = true;
    },
    unmount() {
      mounted = false;
      refreshSeq += 1;
    },
    isMounted() {
      return mounted;
    },
    // 每次配置刷新同时切换测试 epoch，但不清 Map，保证 key 序号单调。
    beginRefresh(): SettingsRefreshTicket {
      refreshSeq += 1;
      testEpoch += 1;
      return { seq: refreshSeq };
    },
    isRefreshCurrent(ticket: SettingsRefreshTicket) {
      return mounted && ticket.seq === refreshSeq;
    },
    // 输入变化只使指定连接行的测试失效。
    invalidateTest(key: string) {
      testSeqByKey.set(key, (testSeqByKey.get(key) || 0) + 1);
    },
    beginTest(key: string): SettingsTestTicket {
      const seq = (testSeqByKey.get(key) || 0) + 1;
      testSeqByKey.set(key, seq);
      return { key, seq, epoch: testEpoch };
    },
    isTestCurrent(ticket: SettingsTestTicket) {
      return mounted && ticket.epoch === testEpoch && testSeqByKey.get(ticket.key) === ticket.seq;
    },
  };
}

export interface CronSelectionSnapshot<TJob, TFilters> {
  job: TJob;
  filters: TFilters;
}

export interface BoardSwitchTicket {
  seq: number;
  target: string;
}

export interface AsyncRequestTicket {
  channel: string;
  context: string;
  generation: number;
  seq: number;
}

// 多个辅助请求共享页面/后端 generation，同时只在各自 channel 内互相取代。
// 这样 boards 与 orchestration 可以并行，但切后端、关窗或卸载会一起作废。
export function createAsyncRequestController() {
  let mounted = false;
  let generation = 0;
  const seqByChannel = new Map<string, number>();

  return {
    mount() {
      mounted = true;
    },
    unmount() {
      mounted = false;
      generation += 1;
    },
    invalidate() {
      generation += 1;
    },
    begin(channel: string, context: string): AsyncRequestTicket {
      const seq = (seqByChannel.get(channel) || 0) + 1;
      seqByChannel.set(channel, seq);
      return { channel, context, generation, seq };
    },
    isCurrent(ticket: AsyncRequestTicket, context: string) {
      return mounted
        && ticket.generation === generation
        && ticket.context === context
        && seqByChannel.get(ticket.channel) === ticket.seq;
    },
  };
}

export interface TargetRequestTicket {
  seq: number;
  target: string;
}

// 把异步读取绑定到完整目标串；后发目标和显式 invalidate 都会作废旧响应。
export function createTargetRequestGuard() {
  let seq = 0;
  return {
    begin(target: string): TargetRequestTicket {
      return { seq: ++seq, target };
    },
    invalidate() {
      seq += 1;
    },
    isCurrent(ticket: TargetRequestTicket, target: string) {
      return ticket.seq === seq && ticket.target === target;
    },
  };
}

export interface KeyedMutationTicket {
  scope: number;
  target: string;
  field: string;
  seq: number;
}

// 同一 profile 内逐字段 latest-wins；换 profile 时一次 invalidateScope 作废全部旧回填。
export function createKeyedMutationGuard() {
  let scope = 0;
  const seqByKey = new Map<string, number>();
  const confirmedByKey = new Map<string, { seq: number; value: string }>();
  const latestOutcomeByKey = new Map<string, { seq: number; outcome: "pending" | "success" | "failure" }>();
  const keyFor = (target: string, field: string) => JSON.stringify([target, field]);
  const inScope = (ticket: KeyedMutationTicket, target: string, field: string) =>
    ticket.scope === scope && ticket.target === target && ticket.field === field;
  const isCurrent = (ticket: KeyedMutationTicket, target: string, field: string) =>
    inScope(ticket, target, field) && seqByKey.get(keyFor(target, field)) === ticket.seq;
  return {
    invalidateScope() {
      scope += 1;
      seqByKey.clear();
      confirmedByKey.clear();
      latestOutcomeByKey.clear();
    },
    begin(target: string, field: string, confirmedValue = ""): KeyedMutationTicket {
      const key = keyFor(target, field);
      const seq = (seqByKey.get(key) || 0) + 1;
      seqByKey.set(key, seq);
      latestOutcomeByKey.set(key, { seq, outcome: "pending" });
      if (!confirmedByKey.has(key)) confirmedByKey.set(key, { seq: 0, value: confirmedValue });
      return { scope, target, field, seq };
    },
    confirm(ticket: KeyedMutationTicket, target: string, field: string, value: string) {
      if (!inScope(ticket, target, field)) return false;
      const key = keyFor(target, field);
      if (seqByKey.get(key) === ticket.seq) {
        latestOutcomeByKey.set(key, { seq: ticket.seq, outcome: "success" });
      }
      const confirmed = confirmedByKey.get(key);
      if (!confirmed || ticket.seq >= confirmed.seq) confirmedByKey.set(key, { seq: ticket.seq, value });
      return true;
    },
    rollbackValue(ticket: KeyedMutationTicket, target: string, field: string) {
      if (!isCurrent(ticket, target, field)) return null;
      const key = keyFor(target, field);
      latestOutcomeByKey.set(key, { seq: ticket.seq, outcome: "failure" });
      return confirmedByKey.get(key)?.value ?? null;
    },
    reconcileValue(ticket: KeyedMutationTicket, target: string, field: string) {
      if (!inScope(ticket, target, field)) return null;
      const key = keyFor(target, field);
      const latest = latestOutcomeByKey.get(key);
      if (!latest || latest.seq !== seqByKey.get(key) || latest.outcome !== "failure") return null;
      return confirmedByKey.get(key)?.value ?? null;
    },
    isCurrent,
  };
}

// 管理看板切换的挂载状态与请求代际；只有最后一次请求的目标可以落 UI 状态。
export function createBoardSwitchController() {
  let mounted = false;
  let seq = 0;

  return {
    // React effect setup/cleanup 显式驱动生命周期，卸载时同步作废在途请求。
    mount() {
      mounted = true;
    },
    unmount() {
      mounted = false;
      seq += 1;
    },
    // 切换后端等外部上下文变化时，不等待 effect 即可同步作废旧请求。
    invalidate() {
      seq += 1;
    },
    // 每次用户选择都领取新代际，并把目标写进票据用于结算时双重核对。
    begin(target: string): BoardSwitchTicket {
      seq += 1;
      return { seq, target };
    },
    isCurrent(ticket: BoardSwitchTicket, target: string) {
      return mounted && ticket.seq === seq && ticket.target === target;
    },
  };
}

// 保存 Cron 当前详情目标与筛选；迟到动作只能读取仍匹配其 id 的快照。
export function createCronSelectionController<TJob extends { id: string }, TFilters>(initialFilters: TFilters) {
  let selected: TJob | null = null;
  let filters = initialFilters;

  return {
    select(job: TJob) {
      selected = job;
    },
    clear() {
      selected = null;
    },
    setFilters(nextFilters: TFilters) {
      filters = nextFilters;
    },
    current(): CronSelectionSnapshot<TJob, TFilters> | null {
      return selected ? { job: selected, filters } : null;
    },
    currentForAction(id: string): CronSelectionSnapshot<TJob, TFilters> | null {
      return selected?.id === id ? { job: selected, filters } : null;
    },
  };
}
