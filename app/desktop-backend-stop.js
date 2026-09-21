"use strict";

function createDesktopBackendStopAction({ dialog, productHost, getLocale }) {
  let pending = null;
  const isStopped = status => status?.background?.supported === true
    && status.background.loaded === false && status.background.enabled === false;
  const readStopped = async () => isStopped(await productHost.getStatus().catch(() => null));
  const stop = async () => {
    const zh = getLocale() === "zh-CN";
    try {
      const impact = await productHost.getBackgroundStopImpact();
      const unknown = impact.availability === "unavailable";
      if (unknown && await readStopped()) return true;
      if (unknown || impact.totalCount > 0) {
        const runs = impact.runs.slice(0, 6).map(run => `• ${run.title || run.runId}${run.agentName ? ` · ${run.agentName}` : ""}`);
        if (impact.totalCount > runs.length) runs.push(zh
          ? `另有 ${impact.totalCount - runs.length} 个活动任务。`
          : `${impact.totalCount - runs.length} more active tasks.`);
        const { response } = await dialog.showMessageBox({
          type: "warning", title: "Shoggoth",
          message: unknown ? (zh ? "无法确认当前任务状态，仍要退出后端？" : "Task status is unavailable. Stop the backend anyway?")
            : (zh ? `退出后端将中断 ${impact.totalCount} 个活动任务` : `Stopping the backend will interrupt ${impact.totalCount} active tasks`),
          detail: [...runs, zh
            ? "正在执行或等待授权、补充信息的任务会中断。会话记录、已保存的任务与设置会保留，排队任务和自动调度将暂停。可在设置中重新启动后台运行。"
            : "Running tasks and tasks waiting for approval or input will be interrupted. Conversation history, saved tasks and settings are retained. Queued tasks and schedules will pause. Restart the background service in Settings."].join("\n"),
          buttons: zh ? ["取消", "退出后端"] : ["Cancel", "Stop backend"], defaultId: 0, cancelId: 0,
        });
        if (response !== 1) return false;
      }
      // Reuse the same revision check and launchd stop as Settings. A new task
      // appearing after this snapshot must never be silently interrupted.
      const status = await productHost.stopBackground({ revision: impact.revision });
      if (!isStopped(status)) throw new Error("Backend stop was not confirmed");
      return true;
    } catch (error) {
      const changed = error?.code === "SHOGGOTH_STOP_IMPACT_CHANGED";
      // launchd may complete the stop after the original response times out.
      if (!changed && await readStopped()) return true;
      await dialog.showMessageBox({
        type: "error", title: "Shoggoth",
        message: zh ? "后端尚未退出" : "The backend has not stopped",
        detail: changed
          ? (zh ? "任务状态已变化，请再次点击“退出后端”以查看最新影响。" : "Task states changed. Choose Stop backend again to review the current impact.")
          : (zh ? "无法确认后台服务已停止，请重试或在设置中检查后台运行状态。" : "Could not confirm that the background service stopped. Retry or check its status in Settings."),
        buttons: [zh ? "好" : "OK"],
      }).catch(() => {});
      return false;
    }
  };
  return () => {
    if (!pending) pending = stop().finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { createDesktopBackendStopAction };
