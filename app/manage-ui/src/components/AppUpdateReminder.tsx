import { useCallback, useEffect, useRef, useState } from "react";
import { Toast } from "@base-ui/react/toast";
import { useTranslation } from "react-i18next";
import { appUpdateBridge, observeAppUpdateState, type AppUpdateState } from "../lib/appUpdate";
import { useNavigationRequest } from "../lib/navigation-guard";
import styles from "./AppUpdateReminder.module.css";

const READY_TOAST_ID = "app-update-ready";
type UpdateAction = "download" | "restart";

function isDownloading(state: AppUpdateState | null) {
  return state?.status === "downloading" || (state?.status === "available" && !state.canCheck);
}

export default function AppUpdateReminder() {
  const { t } = useTranslation();
  const { add, close } = Toast.useToastManager();
  const requestNavigation = useNavigationRequest();
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [pending, setPending] = useState<UpdateAction | null>(null);
  const latestState = useRef<AppUpdateState | null>(null);
  const actionInFlight = useRef<UpdateAction | null>(null);
  const promptedVersion = useRef<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const downloadFailed = t("nav.appUpdateFailed");
  const reportInstallFailure = useCallback((reason: string) => {
    add({ type: "error", title: t(`settings.appUpdate.installBlocked.${reason}`, {
      defaultValue: t("settings.appUpdate.installBlocked.unknown"),
    }) });
  }, [add, t]);

  useEffect(() => {
    const bridge = appUpdateBridge();
    if (!bridge) return;
    return observeAppUpdateState(bridge, (next) => {
      const previous = latestState.current;
      latestState.current = next;
      setState(next);
      if (next?.status === "error" && previous?.status !== "error"
        && (actionInFlight.current === "download" || isDownloading(previous))) {
        add({ type: "error", title: downloadFailed });
      }
      if (next?.installBlockReason && previous && next.installBlockReason !== previous.installBlockReason) {
        reportInstallFailure(next.installBlockReason);
      }
    });
  }, [add, downloadFailed, reportInstallFailure]);

  const runAction = useCallback(async (action: UpdateAction, version: string) => {
    const bridge = appUpdateBridge();
    const current = latestState.current;
    if (!bridge || !current?.supported || current.availableVersion !== version || actionInFlight.current) return;
    if (action === "download" ? !current.canCheck : !current.canInstall) return;

    actionInFlight.current = action;
    setPending(action);
    try {
      if (action === "download") {
        // The stream drives progress, including events that arrive before this reply.
        if (!await bridge.check()) add({ type: "error", title: downloadFailed });
      } else {
        close(READY_TOAST_ID);
        if (!await bridge.install()) {
          const next = await bridge.getState();
          if (!next || (next.canInstall && !next.installBlockReason)) reportInstallFailure("unknown");
        }
      }
    } catch {
      if (action === "download") add({ type: "error", title: downloadFailed });
      else reportInstallFailure("unknown");
    } finally {
      actionInFlight.current = null;
      setPending(null);
    }
  }, [add, close, downloadFailed, reportInstallFailure]);

  const showRestartPrompt = useCallback((version: string) => {
    const anchor = buttonRef.current;
    if (!anchor) return;
    add({
      id: READY_TOAST_ID,
      type: "info",
      title: t("settings.appUpdate.downloaded", { version }),
      timeout: 12_000,
      positionerProps: {
        anchor,
        positionMethod: "fixed",
        side: "right",
        sideOffset: 24,
        collisionPadding: 12,
        collisionAvoidance: { side: "none", align: "shift" },
      },
      actionProps: {
        children: t("settings.appUpdate.restart"),
        onClick: () => requestNavigation(() => { void runAction("restart", version); }),
      },
    });
  }, [add, requestNavigation, runAction, t]);

  const readyVersion = state?.canInstall ? state.availableVersion : null;
  useEffect(() => {
    if (!readyVersion) { close(READY_TOAST_ID); return; }
    if (promptedVersion.current === readyVersion) return;
    promptedVersion.current = readyVersion;
    showRestartPrompt(readyVersion);
  }, [close, readyVersion, showRestartPrompt]);

  if (!state?.supported || !state.availableVersion) return null;
  const version = state.availableVersion;
  const installing = state.status === "preparing" || state.status === "installing" || state.status === "recovering";
  const downloading = !state.canInstall && (pending === "download" || isDownloading(state));
  const progress = Math.round(state.progress ?? 0);
  const disabled = pending !== null || (!state.canCheck && !state.canInstall);
  let label = t("nav.appUpdate", { version });
  if (installing) label = t(`settings.appUpdate.${state.status}`);
  else if (pending === "restart") label = t("settings.appUpdate.preparing");
  else if (state.canInstall) label = t("nav.appUpdateReady", { version });
  else if (downloading) label = t("settings.appUpdate.downloading", { progress });
  else if (state.status === "checking") label = t("settings.appUpdate.checking");
  else if (state.status === "error") label = downloadFailed;
  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.button}
      data-phase={downloading ? "downloading" : state.canInstall ? "ready" : undefined}
      title={label}
      aria-label={label}
      aria-disabled={disabled}
      onClick={() => {
        if (disabled) return;
        if (state.canInstall) showRestartPrompt(version);
        else void runAction("download", version);
      }}
    >
      {downloading && <svg className={styles.ring} width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
        <circle className={styles.track} cx="14" cy="14" r="12.5" />
        <circle className={styles.fill} cx="14" cy="14" r="12.5" pathLength="100" strokeDasharray="100"
          strokeDashoffset={100 - progress} transform="rotate(-90 14 14)" />
      </svg>}
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {state.canInstall || installing || pending === "restart"
          ? <path d="M20 4v5h-5m4.6-.4A8 8 0 1 0 20 15" />
          : <path d="M12 3v11m-4-4 4 4 4-4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />}
      </svg>
    </button>
  );
}
