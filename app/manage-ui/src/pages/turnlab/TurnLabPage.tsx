// Turn Lab —— AI 回合过程可视化的临时演示页(隐藏路由 #/turnlab,不进侧栏)。
// 两个数据源:mock 剧本(完整效果,含出错/换工具/并行)与真实历史回放(降级数据,
// 只还原顺序)。时间线核心与展示组件都是将来并入聊天页直接复用的部分。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PageHead } from "../../components/PageHead";
import PillTabs from "../../components/PillTabs";
import { Option, Select, Switch } from "../../components/Field";
import TurnTimeline from "../../components/TurnTimeline/TurnTimeline";
import { createTimeline, reduceTimeline, type TurnTimelineState } from "../../lib/turnTimeline";
import { SCENARIOS, type ScenarioEvent, type ScenarioId } from "./scenarios";
import { ChatWsClient, fetchReplayTurns, listReplaySessions, type ReplaySessionRow, type ReplayTurn } from "./historyReplay";
import styles from "./TurnLabPage.module.css";

// ---- 事件播放引擎:单 setTimeout 链;调度延时按倍速缩放,但传给 reducer 的虚拟
// 时钟用未缩放 dt 累加 —— 任何倍速下时间线里显示的耗时都是剧本真值。 ----------
interface PlayerEngine {
  idx: number;
  vts: number;
  tl: TurnTimelineState;
  timer: ReturnType<typeof setTimeout> | null;
  armedAt: number;
  armedVirtual: number;
  remainingVirtual: number | null; // 暂停时存「未走完的虚拟毫秒」,恢复/变速时按新倍速换算
}

function useEventPlayer(events: ScenarioEvent[] | null, deriveDurations: boolean, resetKey: string) {
  const [timeline, setTimeline] = useState<TurnTimelineState>(() => createTimeline({ deriveDurations }));
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [index, setIndex] = useState(0);
  const engRef = useRef<PlayerEngine | null>(null);
  const speedRef = useRef(1);
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const stopTimer = useCallback(() => {
    const eng = engRef.current;
    if (eng?.timer) {
      clearTimeout(eng.timer);
      eng.timer = null;
    }
  }, []);

  const scheduleNext = useCallback(() => {
    const eng = engRef.current;
    const evs = eventsRef.current;
    if (!eng || !evs) return;
    if (eng.idx >= evs.length) {
      setPlaying(false);
      return;
    }
    const virtualDelay = eng.remainingVirtual ?? evs[eng.idx].dt;
    eng.remainingVirtual = null;
    eng.armedVirtual = virtualDelay;
    eng.armedAt = performance.now();
    eng.timer = setTimeout(() => {
      eng.timer = null;
      const e = evs[eng.idx];
      if (!e) {
        setPlaying(false);
        return;
      }
      eng.vts += e.dt;
      eng.tl = reduceTimeline(eng.tl, e.ev, eng.vts);
      eng.idx += 1;
      setTimeline(eng.tl);
      setIndex(eng.idx);
      scheduleNext();
    }, virtualDelay / speedRef.current);
  }, []);

  const reset = useCallback(() => {
    stopTimer();
    engRef.current = { idx: 0, vts: 0, tl: createTimeline({ deriveDurations }), timer: null, armedAt: 0, armedVirtual: 0, remainingVirtual: null };
    setTimeline(engRef.current.tl);
    setIndex(0);
    setPlaying(false);
  }, [deriveDurations, stopTimer]);

  const play = useCallback(() => {
    const evs = eventsRef.current;
    if (!evs?.length) return;
    const eng = engRef.current;
    if (!eng || eng.idx >= evs.length) reset();
    setPlaying(true);
    scheduleNext();
  }, [reset, scheduleNext]);

  const pause = useCallback(() => {
    const eng = engRef.current;
    if (eng?.timer) {
      clearTimeout(eng.timer);
      eng.timer = null;
      const elapsedVirtual = (performance.now() - eng.armedAt) * speedRef.current;
      eng.remainingVirtual = Math.max(0, eng.armedVirtual - elapsedVirtual);
    }
    setPlaying(false);
  }, []);

  const changeSpeed = useCallback(
    (v: number) => {
      const eng = engRef.current;
      const wasArmed = !!eng?.timer;
      if (eng?.timer) {
        clearTimeout(eng.timer);
        eng.timer = null;
        const elapsedVirtual = (performance.now() - eng.armedAt) * speedRef.current;
        eng.remainingVirtual = Math.max(0, eng.armedVirtual - elapsedVirtual);
      }
      speedRef.current = v;
      setSpeed(v);
      if (wasArmed) scheduleNext();
    },
    [scheduleNext],
  );

  const restart = useCallback(() => {
    reset();
    if (eventsRef.current?.length) {
      setPlaying(true);
      scheduleNext();
    }
  }, [reset, scheduleNext]);

  // 换剧本/换回合:全量重置并自动开播(演示页要「进来就有效果」)。
  useEffect(() => {
    restart();
    return stopTimer;
  }, [resetKey, restart, stopTimer]);

  return { timeline, playing, speed, index, total: events?.length ?? 0, play, pause, changeSpeed, restart };
}

// ---- 剧本演示 tab -----------------------------------------------------------
function ScriptedTab() {
  const { t } = useTranslation();
  const [scenarioId, setScenarioId] = useState<ScenarioId>("smooth");
  const scenario = useMemo(() => SCENARIOS.find((s) => s.id === scenarioId)!, [scenarioId]);
  const [follow, setFollow] = useState(true);
  const player = useEventPlayer(scenario.events, true, scenarioId);

  return (
    <div className={styles.layout}>
      <aside className={styles.side}>
        <div className={styles.sideLabel}>{t("turnLab.scenarioLabel")}</div>
        {SCENARIOS.map((s) => (
          <button key={s.id} type="button" className={styles.scenarioCard} data-on={s.id === scenarioId ? "1" : undefined} onClick={() => setScenarioId(s.id)}>
            <span className={styles.scenarioName}>{t(`turnLab.scenarios.${s.id}.name`)}</span>
            <span className={styles.scenarioDesc}>{t(`turnLab.scenarios.${s.id}.desc`)}</span>
          </button>
        ))}
      </aside>
      <section className={styles.panel}>
        <div className="ui-toolbar">
          <button type="button" className="ui-cbtn" onClick={player.playing ? player.pause : player.play}>
            {player.playing ? t("turnLab.pause") : t("turnLab.play")}
          </button>
          <button type="button" className="ui-cbtn" onClick={player.restart}>
            {t("turnLab.restart")}
          </button>
          {[1, 2, 4].map((v) => (
            <button key={v} type="button" className="ui-cbtn" aria-pressed={player.speed === v} onClick={() => player.changeSpeed(v)} aria-label={`${t("turnLab.speed")} ${v}x`}>
              {v}x
            </button>
          ))}
          <span className={styles.progress}>{t("turnLab.progress", { done: player.index, total: player.total })}</span>
          <div className="ui-toolbar-end">
            <Switch checked={follow} onChange={setFollow} label={t("turnLab.autoFollow")} />
          </div>
        </div>
        <TurnTimeline steps={player.timeline.steps} status={player.timeline.status} autoFollow={follow} onUserScrollAway={() => setFollow(false)} className={styles.timeline} />
      </section>
    </div>
  );
}

// ---- 真实回放 tab -----------------------------------------------------------
type ReplayPhase = "connecting" | "ready" | "unavailable";

function ReplayTab() {
  const { t } = useTranslation();
  const clientRef = useRef<ChatWsClient | null>(null);
  const [phase, setPhase] = useState<ReplayPhase>("connecting");
  const [connectErr, setConnectErr] = useState("");
  const [sessions, setSessions] = useState<ReplaySessionRow[]>([]);
  const [sessionKey, setSessionKey] = useState("");
  const [turns, setTurns] = useState<ReplayTurn[] | null>(null);
  const [turnIdx, setTurnIdx] = useState(-1);
  const [loadingTurns, setLoadingTurns] = useState(false);
  const [mode, setMode] = useState<"instant" | "step">("instant");
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    let alive = true;
    const client = new ChatWsClient();
    clientRef.current = client;
    (async () => {
      try {
        await client.connect();
        const rows = await listReplaySessions(client);
        if (!alive) return;
        setSessions(rows);
        setPhase("ready");
      } catch (e) {
        if (!alive) return;
        setConnectErr(e instanceof Error ? e.message : String(e));
        setPhase("unavailable");
      }
    })();
    return () => {
      alive = false;
      client.close();
      clientRef.current = null;
    };
  }, []);

  const pickSession = useCallback(async (key: string) => {
    setSessionKey(key);
    setTurns(null);
    setTurnIdx(-1);
    if (!key || !clientRef.current) return;
    setLoadingTurns(true);
    try {
      setTurns(await fetchReplayTurns(clientRef.current, key));
    } catch {
      setTurns([]);
    } finally {
      setLoadingTurns(false);
    }
  }, []);

  const turn = turns && turnIdx >= 0 ? turns[turnIdx] : null;
  const stepEvents = useMemo(() => (turn ? turn.events.map((ev): ScenarioEvent => ({ dt: 350, ev })) : null), [turn]);
  const instantTimeline = useMemo(() => {
    if (!turn) return null;
    let tl = createTimeline({ deriveDurations: false });
    turn.events.forEach((ev, i) => {
      tl = reduceTimeline(tl, ev, i);
    });
    return tl;
  }, [turn]);
  const player = useEventPlayer(mode === "step" ? stepEvents : null, false, `${sessionKey}:${turnIdx}:${mode}`);

  if (phase === "connecting") {
    return <div className={styles.centerHint}>{t("turnLab.replay.loading")}</div>;
  }
  if (phase === "unavailable") {
    return (
      <div className={styles.centerHint}>
        <div className={styles.hint}>{t("turnLab.replay.unavailable")}</div>
        <div className={styles.hintSub}>{t("turnLab.replay.connectFailed", { msg: connectErr })}</div>
      </div>
    );
  }

  const shown = mode === "step" ? player.timeline : instantTimeline;
  return (
    <div className={styles.layout}>
      <aside className={styles.side}>
        <div className={styles.sideLabel}>{t("turnLab.replay.pickSession")}</div>
        {sessions.length ? (
          <Select value={sessionKey} onChange={pickSession}>
            {sessions.map((s) => (
              <Option key={s.key} value={s.key}>
                {s.label}
              </Option>
            ))}
          </Select>
        ) : (
          <div className={styles.hintSub}>{t("turnLab.replay.empty")}</div>
        )}
        <div className={styles.sideLabel}>{t("turnLab.replay.pickTurn")}</div>
        <div className={styles.turnList}>
          {loadingTurns ? (
            <div className={styles.hintSub}>{t("turnLab.replay.loading")}</div>
          ) : turns && !turns.length ? (
            <div className={styles.hintSub}>{t("turnLab.replay.noTurns")}</div>
          ) : (
            (turns ?? []).map((tn, i) => (
              <button key={i} type="button" className={styles.turnRow} data-on={i === turnIdx ? "1" : undefined} onClick={() => setTurnIdx(i)}>
                {tn.label}
              </button>
            ))
          )}
        </div>
      </aside>
      <section className={styles.panel}>
        <div className={styles.hint}>{t("turnLab.replay.degraded")}</div>
        <div className="ui-toolbar">
          <button type="button" className="ui-cbtn" aria-pressed={mode === "instant"} onClick={() => setMode("instant")}>
            {t("turnLab.replay.modeInstant")}
          </button>
          <button type="button" className="ui-cbtn" aria-pressed={mode === "step"} onClick={() => setMode("step")}>
            {t("turnLab.replay.modeStep")}
          </button>
          {mode === "step" && turn ? (
            <>
              <button type="button" className="ui-cbtn" onClick={player.playing ? player.pause : player.play}>
                {player.playing ? t("turnLab.pause") : t("turnLab.play")}
              </button>
              <button type="button" className="ui-cbtn" onClick={player.restart}>
                {t("turnLab.restart")}
              </button>
              <span className={styles.progress}>{t("turnLab.progress", { done: player.index, total: player.total })}</span>
            </>
          ) : null}
          <div className="ui-toolbar-end">
            <Switch checked={follow} onChange={setFollow} label={t("turnLab.autoFollow")} />
          </div>
        </div>
        <TurnTimeline
          steps={shown?.steps ?? []}
          status={shown?.status ?? "idle"}
          showDurations={false}
          autoFollow={follow}
          onUserScrollAway={() => setFollow(false)}
          emptyHint={<div className={styles.centerHint}>{t("turnLab.replay.pickHint")}</div>}
          className={styles.timeline}
        />
      </section>
    </div>
  );
}

export default function TurnLabPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"scripted" | "replay">("scripted");
  return (
    <div className={`page management-page ${styles.root}`}>
      <PageHead
        title={t("turnLab.title")}
        subtitle={t("turnLab.subtitle")}
        actions={
          <PillTabs
            value={tab}
            onChange={(v) => setTab(v === "replay" ? "replay" : "scripted")}
            items={[
              { value: "scripted", label: t("turnLab.tabScripted") },
              { value: "replay", label: t("turnLab.tabReplay") },
            ]}
            ariaLabel={t("turnLab.title")}
          />
        }
      />
      {tab === "scripted" ? <ScriptedTab /> : <ReplayTab />}
    </div>
  );
}
