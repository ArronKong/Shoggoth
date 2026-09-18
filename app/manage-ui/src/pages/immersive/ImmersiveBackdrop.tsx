import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { fetchBgManifest, resolveBgMedia, type BgManifest, type BgMedia, type ImmersivePhase } from "./immersiveBg";
import styles from "./ImmersiveBackdrop.module.css";

// 沉浸模式背景媒体层：按 agent 状态相位实时切换视频/图片素材。
// - 双槽（A/B）常驻叠层 + opacity crossfade：目标素材先在后台槽加载，就绪才开始
//   淡入——加载期间旧画面常驻，杜绝单 <video> 换 src 的黑闪（root 深底露出）。
// - 滞回在本组件内做（ChatPage 传的是未滞回的原始相位）：新相位稳定 ~350ms 才提交
//   （吸收 thinking↔tool 抖动；error/offline 立即），每张背景最短展示 1200ms。
// - 素材解析走 immersiveBg.ts（自定义目录 > 内置 > 回退链）；加载失败的 url 记入
//   会话级 blacklist 后重解析，同链自动跳过坏源。
// - sourceRef：把「当前前台且已就绪」的媒体元素暴露给 useGlassRenderer 作折射纹理
//   源——GL 层不感知双槽切换。
// - keep-alive 恢复：路由切走（display:none）浏览器会暂停 <video>；根元素尺寸
//   0→非0 与 visibilitychange 双钩子上对前台视频补 play()。

const DEBOUNCE_MS = 350;
const MIN_SHOW_MS = 1200;
const FADE_MS = 600;

type SlotKey = "a" | "b";

export default function ImmersiveBackdrop({
  phase,
  sourceRef,
}: {
  phase: ImmersivePhase;
  sourceRef: MutableRefObject<HTMLVideoElement | HTMLImageElement | null>;
}) {
  const [manifest, setManifest] = useState<BgManifest>({});
  const [committed, setCommitted] = useState<ImmersivePhase>(phase);
  const [slotA, setSlotA] = useState<BgMedia | null>(null);
  const [slotB, setSlotB] = useState<BgMedia | null>(null);
  const [front, setFront] = useState<SlotKey>("a");
  const [retryTick, setRetryTick] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const elsRef = useRef<Record<SlotKey, HTMLVideoElement | HTMLImageElement | null>>({ a: null, b: null });
  const readyRef = useRef<Record<SlotKey, boolean>>({ a: false, b: false });
  const blacklistRef = useRef<Set<string>>(new Set());
  const lastCommitAtRef = useRef(0);
  const frontRef = useRef<SlotKey>("a");
  frontRef.current = front;

  useEffect(() => {
    let alive = true;
    void fetchBgManifest().then((m) => {
      if (alive) setManifest(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 滞回：目标相位稳定一段时间才提交；提交间隔不短于 MIN_SHOW_MS。
  useEffect(() => {
    if (phase === committed) return;
    const immediate = phase === "error" || phase === "offline";
    const held = Date.now() - lastCommitAtRef.current;
    const minHold = Math.max(0, MIN_SHOW_MS - held);
    const delay = immediate ? Math.min(minHold, 300) : Math.max(DEBOUNCE_MS, minHold);
    const t = setTimeout(() => {
      lastCommitAtRef.current = Date.now();
      setCommitted(phase);
    }, delay);
    return () => clearTimeout(t);
  }, [phase, committed]);

  const target = useMemo(() => resolveBgMedia(committed, manifest, blacklistRef.current), [committed, manifest, retryTick]);

  // 翻转后延时清空旧槽：等淡出走完（元素卸载即停播/释放解码器）。只清「仍是当时那张」
  // 的槽——期间编排可能已把该槽装填成新的加载目标，无脑清会把合法加载打断。
  const scheduleCleanup = (oldKey: SlotKey, oldUrl: string | undefined, newFront: SlotKey) => {
    if (!oldUrl) return;
    setTimeout(() => {
      if (frontRef.current !== newFront) return;
      (oldKey === "a" ? setSlotA : setSlotB)((prev) => (prev?.url === oldUrl ? null : prev));
    }, FADE_MS + 100);
  };

  // 槽位编排。关键：翻转后「变成后台的旧前台」正在淡出，必须留给 scheduleCleanup 的
  // 延时清理——effect 里即时清会让旧画面瞬间消失、crossfade 退化成暗底闪现（实测踩过）。
  // effect 只清「还没就绪的过期加载目标」。
  useEffect(() => {
    const frontMedia = front === "a" ? slotA : slotB;
    const backKey: SlotKey = front === "a" ? "b" : "a";
    const backMedia = front === "a" ? slotB : slotA;
    const setBack = backKey === "a" ? setSlotA : setSlotB;
    if (frontMedia?.url === target.url) {
      if (backMedia && !readyRef.current[backKey]) setBack(null); // 过期的加载中目标
      return;
    }
    if (!frontMedia) {
      readyRef.current[front] = false;
      (front === "a" ? setSlotA : setSlotB)(target);
      return;
    }
    if (backMedia?.url === target.url) {
      // 快速回切：后台槽恰好就是目标且已就绪（正在淡出的前一张）——直接翻回，免重载
      if (readyRef.current[backKey]) {
        const oldKey = front;
        setFront(backKey);
        scheduleCleanup(oldKey, frontMedia.url, backKey);
      }
      return;
    }
    readyRef.current[backKey] = false;
    setBack(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, front, slotA, slotB]);

  const syncSourceRef = () => {
    const el = elsRef.current[frontRef.current];
    sourceRef.current = el && readyRef.current[frontRef.current] ? el : null;
  };

  const onReady = (k: SlotKey) => {
    if (readyRef.current[k]) return; // video 的 canplay 会因缓冲/循环重触发
    readyRef.current[k] = true;
    const el = elsRef.current[k];
    if (el instanceof HTMLVideoElement) el.play().catch(() => undefined);
    if (k !== frontRef.current) {
      const oldKey = frontRef.current;
      const oldUrl = (oldKey === "a" ? slotA : slotB)?.url;
      setFront(k);
      scheduleCleanup(oldKey, oldUrl, k);
    }
    syncSourceRef();
  };

  const onError = (k: SlotKey, url: string) => {
    blacklistRef.current.add(url);
    (k === "a" ? setSlotA : setSlotB)(null);
    readyRef.current[k] = false;
    if (k === frontRef.current) sourceRef.current = null;
    setRetryTick((t) => t + 1); // 重解析：同链跳过刚拉黑的源
  };

  // 前台变化后同步纹理源。
  useEffect(() => {
    syncSourceRef();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [front, slotA, slotB]);
  useEffect(
    () => () => {
      sourceRef.current = null;
    },
    [sourceRef],
  );

  // keep-alive 恢复：display:none 期间视频被暂停，回来补 play()。
  useEffect(() => {
    const resume = () => {
      const el = elsRef.current[frontRef.current];
      if (el instanceof HTMLVideoElement && (rootRef.current?.clientWidth ?? 0) > 0) {
        el.play().catch(() => undefined);
      }
    };
    document.addEventListener("visibilitychange", resume);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resume) : null;
    if (ro && rootRef.current) ro.observe(rootRef.current);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      ro?.disconnect();
    };
  }, []);

  // ref 回调必须是稳定身份：内联 `bindEl(k)` 每次渲染都是新函数，React 对「ref 身份
  // 变化」的处理是每次提交先 oldRef(null) 再 newRef(el)——null 分支的「卸载即停播 +
  // 摘 src」就会打在活元素上，把加载中的视频当场掐死（src attribute 被摘、React 因
  // vdom 未变不会回写 → networkState 永远 NETWORK_EMPTY → 背景全黑。实测踩过：
  // v0.8.0 首发即黑屏）。稳定身份下 null 只在真卸载（key 换源/槽清空）时到来。
  const bindEl = (k: SlotKey, el: HTMLVideoElement | HTMLImageElement | null) => {
    const prev = elsRef.current[k];
    if (!el && prev instanceof HTMLVideoElement) {
      // 卸载即停播 + 释放解码器（双视频并存只限 fade 窗口）
      try {
        prev.pause();
        prev.removeAttribute("src");
        prev.load();
      } catch {
        /* ignore */
      }
    }
    elsRef.current[k] = el;
  };
  const bindA = useCallback((el: HTMLVideoElement | HTMLImageElement | null) => bindEl("a", el), []);
  const bindB = useCallback((el: HTMLVideoElement | HTMLImageElement | null) => bindEl("b", el), []);

  const renderSlot = (k: SlotKey, media: BgMedia | null) => {
    if (!media) return null;
    const cls = front === k ? `${styles.media} ${styles.front}` : styles.media;
    return media.type === "video" ? (
      <video
        key={media.url}
        ref={k === "a" ? bindA : bindB}
        className={cls}
        src={media.url}
        autoPlay
        loop
        muted
        playsInline
        onCanPlay={() => onReady(k)}
        onError={() => onError(k, media.url)}
      />
    ) : (
      <img key={media.url} ref={k === "a" ? bindA : bindB} className={cls} src={media.url} alt="" onLoad={() => onReady(k)} onError={() => onError(k, media.url)} />
    );
  };

  return (
    <div ref={rootRef} className={styles.root} aria-hidden="true">
      {renderSlot("a", slotA)}
      {renderSlot("b", slotB)}
    </div>
  );
}
