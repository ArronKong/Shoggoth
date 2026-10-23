import { useEffect, useState } from "react";

/**
 * 保存持续超过 delayMs 后变 true。OpenClaw 每次凭据写都要等网关重建鉴权与
 * 模型目录（繁忙网关单次可达一分钟），只显示「保存中…」会被当成卡死。
 */
export function useSlowPending(pending: boolean, delayMs = 5000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!pending) return;
    const timer = window.setTimeout(() => setSlow(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [pending, delayMs]);
  return slow;
}
