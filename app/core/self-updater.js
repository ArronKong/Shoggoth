"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const LOG_TAIL_MAX = 8 * 1024; // 状态里只留输出尾部，够定位失败原因即可
const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 兜底杀挂死的更新进程（npm/git 卡网络）

// 0 号信号只做存在性/权限检查，不投递。除 ESRCH（确定没了）外一律当活着：
// EPERM 说明 pid 被别人的进程占着（多半是 pid 复用），宁可拒绝新一轮更新，
// 也不能和仍在写同一安装目录的孤儿并发。
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

/**
 * 封装「官方自更新命令」的执行与状态跟踪，OpenClaw/Hermes 两个 backend 共用。
 * 更新是分钟级长操作，REST 平面不能同步等 → run() 只负责启动（单飞：已在跑
 * 时直接返回进行中状态），前端轮询 status() 拿进度/结果。
 */
class SelfUpdater {
  /**
   * @param {{ command: () => {cmd: string, args: string[]},
   *           onSuccess?: (state: object) => Promise<void>|void,
   *           statePath?: string }} spec
   *   command   — 惰性解析要执行的命令（bin 可能随配置变）。
   *   onSuccess — 更新命令成功后的收尾（重启本地服务 / 健康检查），收到本轮
   *               状态快照。抛错=收尾失败，终态判 ok=false 并记入
   *               postUpdateError（更新命令成功但服务没起来，对用户就是失败）。
   *   statePath — 可选：终态落盘到这个 json，app 重启后 status() 仍能报告
   *               上次结果（更新失败的原因不能随进程退出蒸发）。
   */
  constructor({ command, onSuccess, statePath } = {}) {
    this._command = command;
    this._onSuccess = onSuccess;
    this._statePath = statePath || null;
    this._state = this._loadPersisted();
  }

  /** 当前/最近一次更新的状态快照（前端轮询消费）。 */
  status() {
    // 认领来的孤儿没有 exit 事件可听，只能轮询时补探活：它没了就地转终态，
    // 否则本进程会一直卡在 running（连重试更新都被单飞挡掉）。
    if (this._adopted && !this._orphanAlive(this._state)) {
      this._adopted = false;
      this._state = this._interrupted(this._state);
      this._persist(this._state);
    }
    const snapshot = { ...this._state };
    if (
      this._adopted
      && snapshot.running
      && Date.now() - (snapshot.startedAt || 0) >= HARD_TIMEOUT_MS
    ) {
      snapshot.staleLive = true;
    }
    return snapshot;
  }

  // 上次进程留下的状态。磁盘上 running:true 且那个 detached 子进程还活着 →
  // 更新真的还在跑，继续报 running（单飞据此挡住并发的第二次更新）；进程没
  // 了就是结果未知，转成明确的失败终态（interrupted），别让 UI 以为还在跑。
  _loadPersisted() {
    if (!this._statePath) return { running: false };
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this._statePath, "utf8"));
    } catch {
      return { running: false }; // 无文件（首次）或损坏：从头开始
    }
    if (!parsed || typeof parsed !== "object") return { running: false };
    if (parsed.running) {
      if (this._orphanAlive(parsed)) {
        this._adopted = true;
        return { ...parsed };
      }
      const state = this._interrupted(parsed);
      this._persist(state);
      return state;
    }
    return { ...parsed };
  }

  // 上个 app 留下的更新是否还真的在跑。没有 pid 的老状态文件一律当已中断
  // （与落 pid 之前的行为一致）。年龄不能证明进程已死：旧 app 的兜底 timer
  // 已随它退出，live PID 仍可能在写安装目录；宁可保持单飞锁并标 staleLive，
  // 也不能自动开启第二轮并发更新。
  _orphanAlive(parsed) {
    return pidAlive(parsed?.pid);
  }

  _interrupted(parsed) {
    return {
      ...parsed,
      running: false,
      ok: false,
      interrupted: true,
      error: "update interrupted: the app exited while the update was running",
    };
  }

  // 原子写（write-then-rename，与 config-store 同款）。落盘失败静默：更新
  // 状态是尽力而为的附属品，不能因为磁盘满反过来打断更新流程本身。
  _persist(state) {
    if (!this._statePath) return;
    try {
      fs.mkdirSync(path.dirname(this._statePath), { recursive: true });
      const tmp = `${this._statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, this._statePath);
    } catch {
      /* best-effort */
    }
  }

  /** 启动更新；已在跑时不重复启动，幂等返回当前状态。 */
  run() {
    const current = this.status(); // 先走 status()：孤儿探活可能刚把 running 摘掉
    if (current.running) return current;
    const { cmd, args } = this._command();
    const startedAt = Date.now();
    // 本轮的状态对象，全程原地改。append 只写它，绝不写 this._state——被兜底
    // SIGKILL 打断的上一轮可能留下仍握着管道的孙进程，它们迟到的输出会继续
    // 触发 append；写 this._state 就会把下一轮的 logTail 覆盖成旧日志。
    const state = { running: true, startedAt, command: [cmd, ...args].join(" ") };
    this._state = state;
    let tail = "";
    const append = (chunk) => {
      tail = (tail + String(chunk)).slice(-LOG_TAIL_MAX);
      state.logTail = tail;
    };
    let proc;
    try {
      // env 继承 process.env：main.js 启动时已灌入 login-shell PATH。
      // detached：让子进程自成进程组，兜底超时才杀得掉整棵树（见下）。
      proc = spawn(cmd, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (err) {
      this._state = {
        running: false,
        startedAt,
        finishedAt: Date.now(),
        ok: false,
        error: err?.message || String(err),
      };
      this._persist(this._state);
      return this.status();
    }
    // running 态连 pid 一起落盘：detached 子进程活得过 app 退出，下次启动靠
    // pid 探活区分「更新还在跑」和「上次被中断」。
    state.pid = proc.pid;
    this._persist(state);
    proc.stdout.on("data", append);
    proc.stderr.on("data", append);
    const timer = setTimeout(() => {
      // 真正干活的是 npm/git 孙进程；只 kill 直接子进程会把它们留下继续跑，
      // 与用户随后重试的更新并发写同一安装目录。杀整个进程组。
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }, HARD_TIMEOUT_MS);
    // spawn ENOENT 走 error（无 exit）；正常结束走 exit。settled 防双写。
    let settled = false;
    const finish = (patch) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const done = (extra) => {
        Object.assign(state, { running: false, finishedAt: Date.now(), ...patch, ...extra });
        this._persist(state);
      };
      if (patch.ok && this._onSuccess) {
        // 收尾（重启本地服务 / 健康检查）也算在 running 生命周期内：轮询端
        // 看到 running=false 即终态，不会在服务还在重启时提前报「完成」。
        // 收尾失败 = 更新后服务没起来，对用户就是更新失败 → ok 翻成 false，
        // 原因记 postUpdateError（exitCode 仍是 0，前端据此细分文案）。
        Promise.resolve(state)
          .then(this._onSuccess)
          .then(() => done())
          .catch((err) => done({ ok: false, postUpdateError: err?.message || String(err) }));
      } else {
        done();
      }
    };
    proc.on("error", (err) => finish({ ok: false, error: err?.message || String(err) }));
    proc.on("exit", (code, signal) =>
      finish({
        ok: code === 0,
        exitCode: code,
        ...(signal ? { error: `terminated by ${signal}` } : {}),
      }),
    );
    return this.status();
  }
}

module.exports = { SelfUpdater };
