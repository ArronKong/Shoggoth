import { useEffect, useRef, useSyncExternalStore } from "react";
import { getDesktopProductTelemetry } from "../api/client";
import type {
  TelemetryDimension, TelemetryFeature, TelemetryOutcome, TelemetrySettingError,
  TelemetrySettings, TelemetryPayload, TelemetryStep, TelemetryUsage,
} from "../types";
import catalog from "../../../core/data/product-telemetry-catalog.json";

type SettingsState = { settings: TelemetrySettings | null; saving: boolean; error: TelemetrySettingError | null };
type Snapshot = Record<string, number | true | string[]>;
export interface TelemetryOperation {
  finish: (outcome: TelemetryOutcome, cause?: unknown, usage?: TelemetryUsage) => void;
}

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const notify = () => { for (const listener of listeners) listener(); };
let view: SettingsState = { settings: null, saving: false, error: null };
let request = 0;
let detailDay: string | null = null;
const seenPages = new Set<string>();
const seenSnapshots = new Set<TelemetryDimension>();

function publish(next: SettingsState) {
  if (view.settings?.detailedEpoch !== next.settings?.detailedEpoch) {
    detailDay = null;
    seenPages.clear();
    seenSnapshots.clear();
  }
  view = next;
  notify();
}
const getView = () => view;
export function useTelemetrySettings() {
  return useSyncExternalStore(subscribe, getView, getView);
}

async function refreshSettings() {
  const bridge = getDesktopProductTelemetry();
  if (!bridge || view.saving) return;
  const ticket = ++request;
  let settings: TelemetrySettings | null = null;
  try { settings = await bridge.getSettings(); } catch { /* unavailable */ }
  if (ticket === request) publish({ ...view, settings });
}

export async function changeTelemetrySetting(field: "enabled" | "detailedEnabled", enabled: boolean) {
  const bridge = getDesktopProductTelemetry(), current = view.settings;
  if (!bridge || !current?.available || view.saving) return;
  const ticket = ++request;
  // Drop the renderer's signal gate before the main process replies to opt-out.
  const settings = enabled ? current : { ...current, detailedEpoch: null,
    basicEpoch: field === "enabled" ? null : current.basicEpoch };
  publish({ settings, saving: true, error: null });
  try {
    const result = await (field === "enabled" ? bridge.setEnabled(enabled) : bridge.setDetailedEnabled(enabled));
    if (ticket === request) publish({ settings: result?.settings ?? settings, saving: false,
      error: result ? result.error : "unavailable" });
  } catch {
    if (ticket === request) publish({ settings, saving: false, error: enabled ? "not_saved" : "paused_not_saved" });
  }
}

function emit(epoch: string, signal: TelemetryPayload) {
  try { getDesktopProductTelemetry()?.record({ ...signal, collectionEpoch: epoch }); }
  catch { /* statistics must never alter user actions */ }
}

const PRODUCT_PAGES: Readonly<Record<string, string>> = catalog.pages;
const INTERACTIONS = ["pointerdown", "keydown", "wheel"] as const;
const productPage = () => {
  const path = window.location.hash.slice(1).split("?", 1)[0];
  return Object.hasOwn(PRODUCT_PAGES, path) ? PRODUCT_PAGES[path] : null;
};

export function installProductActivityListener(): () => void {
  if (!getDesktopProductTelemetry()) return () => {};
  let attached = false;
  let lastAt = -Infinity;
  let lastDay = "";
  let lastEpoch: string | null = null;
  const onInteraction = (event: Event) => {
    const { basicEpoch, detailedEpoch } = view.settings || {};
    if (!basicEpoch || !event.isTrusted || document.visibilityState !== "visible" || !document.hasFocus()) return;
    const page = productPage();
    if (!page) return;
    if (document.querySelector(".product-telemetry-privacy[data-open]")) return;
    if (event.target instanceof Element && event.target.closest("[data-product-telemetry-exclude], .product-telemetry-privacy")) return;
    const at = performance.now();
    const day = new Date().toISOString().slice(0, 10);
    if (day !== lastDay || basicEpoch !== lastEpoch || at - lastAt >= 60_000) {
      lastAt = at;
      lastDay = day;
      lastEpoch = basicEpoch;
      emit(basicEpoch, { kind: "activity", payload: {} });
    }
    if (!detailedEpoch) return;
    if (detailDay !== day) {
      detailDay = day;
      seenPages.clear();
      seenSnapshots.clear();
      notify();
    }
    if (seenPages.has(page)) return;
    seenPages.add(page);
    emit(detailedEpoch, { kind: "page_used", payload: { page } });
  };
  const syncListeners = () => {
    const shouldAttach = !!view.settings?.basicEpoch;
    if (shouldAttach === attached) return;
    attached = shouldAttach;
    // Programmatic scrolling also emits trusted scroll events. Wheel, keyboard
    // and scrollbar pointer input cover reading without counting auto-scroll.
    for (const name of INTERACTIONS) {
      if (attached) document.addEventListener(name, onInteraction, { capture: true, passive: true });
      else document.removeEventListener(name, onInteraction, true);
    }
  };
  const unsubscribe = subscribe(syncListeners);
  const refresh = () => { void refreshSettings(); };
  window.addEventListener("focus", refresh);
  refresh();
  syncListeners();
  return () => {
    unsubscribe();
    ++request;
    window.removeEventListener("focus", refresh);
    if (attached) for (const name of INTERACTIONS) document.removeEventListener(name, onInteraction, true);
  };
}

export function backendTelemetryType(id: unknown): string {
  return typeof id === "string" && id ? (catalog.backendTypes.includes(id) ? id : "other") : "unknown";
}

export function runtimeTelemetryType(id: unknown): string {
  return typeof id === "string" && id ? (catalog.runtimeTypes.includes(id) ? id : "other") : "unknown";
}

const PROVIDER_ALIASES: Readonly<Record<string, string>> = catalog.providerAliases;
const PROVIDER_MODELS: Readonly<Record<string, string[]>> = catalog.providerModels;

export function telemetryModel(provider: unknown, model: unknown): Pick<TelemetryUsage, "providerId" | "modelId"> {
  const modelText = typeof model === "string" ? model : "";
  const slash = modelText.indexOf("/");
  const inputProvider = typeof provider === "string" && provider ? provider : slash > 0 ? modelText.slice(0, slash) : "";
  const canonical = Object.hasOwn(PROVIDER_ALIASES, inputProvider) ? PROVIDER_ALIASES[inputProvider] : inputProvider;
  const providerId = !canonical ? "unknown" : Object.hasOwn(PROVIDER_MODELS, canonical) ? canonical : "custom";
  const modelId = slash > 0 && (modelText.slice(0, slash) === inputProvider || modelText.slice(0, slash) === providerId)
    ? modelText.slice(slash + 1) : modelText;
  const publishers = providerId === "unknown" && modelId ? Object.keys(PROVIDER_MODELS)
    .filter(publisher => PROVIDER_MODELS[publisher].includes(modelId)) : [];
  return {
    providerId,
    modelId: !modelId ? "unknown" : providerId === "custom" ? "custom"
      : PROVIDER_MODELS[providerId]?.includes(modelId) ? providerId + "/" + modelId
        : publishers.length === 1 ? publishers[0] + "/" + modelId : "other",
  };
}

function errorKind(cause: unknown): string {
  const error = cause as { status?: number; code?: string; name?: string } | null | undefined;
  const status = error?.status;
  const code = typeof cause === "string" ? cause : error?.code;
  if (status === 401 || code === "AUTH_REQUIRED" || code === "UNAUTHENTICATED") return "auth_required";
  if (status === 403 || code === "FORBIDDEN" || code === "PERMISSION_DENIED") return "permission";
  if (status === 408 || status === 504 || code === "ETIMEDOUT" || code === "TIMEOUT" || error?.name === "TimeoutError") return "timeout";
  if (status === 501 || code === "UNSUPPORTED" || code === "NOT_IMPLEMENTED") return "unsupported";
  if (status === 400 || status === 422 || code === "INVALID_PARAMS" || code === "VALIDATION_ERROR") return "validation";
  if (status === 0 || code === "ECONNRESET" || code === "ECONNREFUSED" || code === "NETWORK_ERROR") return "network";
  return "unknown";
}

function activeDetailEpoch(): string | null {
  const epoch = view.settings?.detailedEpoch;
  return epoch && productPage() && document.visibilityState === "visible" && document.hasFocus()
    && detailDay === new Date().toISOString().slice(0, 10) ? epoch : null;
}

export function startTelemetryOperation(feature: TelemetryFeature, backend?: unknown): TelemetryOperation | undefined {
  const epoch = activeDetailEpoch();
  if (!epoch) return;
  try {
    const operationId = crypto.randomUUID();
    let finished = false;
    emit(epoch, { kind: "feature_start", payload: { feature, operationId, backendType: backendTelemetryType(backend) } });
    return {
      finish(outcome, cause, usage) {
        if (finished || epoch !== view.settings?.detailedEpoch) return;
        finished = true;
        let error: string | null = null;
        if (outcome === "error") {
          try { error = errorKind(cause); } catch { error = "unknown"; }
        }
        emit(epoch, { kind: "feature_end", payload: { operationId, outcome, errorKind: error, usage: usage ?? null } });
      },
    };
  } catch { return undefined; }
}

export async function measureTelemetry<T>(feature: TelemetryFeature, backend: unknown, run: () => Promise<T>,
  classify?: (result: T) => TelemetryOutcome | null): Promise<T> {
  const operation = startTelemetryOperation(feature, backend);
  let result: T;
  try { result = await run(); }
  catch (cause) {
    operation?.finish(cause instanceof Error && cause.name === "AbortError" ? "canceled" : "error", cause);
    throw cause;
  }
  if (operation) {
    try {
      const outcome = classify ? classify(result) : "success";
      if (outcome) operation.finish(outcome);
    } catch { /* outcome unavailable */ }
  }
  return result;
}

export function useTelemetryOperations() {
  const pending = useRef(new Map<string, TelemetryOperation>()).current;
  useEffect(() => {
    let epoch = view.settings?.detailedEpoch;
    const unsubscribe = subscribe(() => {
      if (epoch !== view.settings?.detailedEpoch) {
        pending.clear();
        epoch = view.settings?.detailedEpoch;
      }
    });
    return () => { unsubscribe(); pending.clear(); };
  }, [pending]);
  return pending;
}

export function retainTelemetryOperation(pending: Map<string, TelemetryOperation>, key: string,
  operation: TelemetryOperation | undefined) {
  if (!operation) return;
  if (pending.size >= 1024) pending.delete(pending.keys().next().value!);
  pending.set(key, operation);
}

export function telemetryOnboardingStep(step: TelemetryStep, epoch = activeDetailEpoch()): string | null {
  if (epoch && epoch === view.settings?.detailedEpoch) emit(epoch, { kind: "onboarding_step", payload: { step } });
  return epoch;
}

export function telemetryCount(key: string, count: number): Snapshot {
  return { [key]: Math.min(count, 1000), ...(count > 1000 ? { [key + "_capped"]: true } : {}) };
}

export function telemetryList(key: string, values: Iterable<string>): Snapshot {
  const sorted = [...new Set(values)].sort();
  return { [key]: sorted.slice(0, 64), ...(sorted.length > 64 ? { [key + "_truncated"]: true } : {}) };
}

const getDetailDay = () => detailDay;
export function useTelemetrySnapshot<T>(dimension: TelemetryDimension, source: T | null | undefined,
  project: (source: T) => Snapshot | null) {
  const day = useSyncExternalStore(subscribe, getDetailDay, getDetailDay);
  useEffect(() => {
    const epoch = activeDetailEpoch();
    if (!day || !epoch || source == null || seenSnapshots.has(dimension)) return;
    try {
      const values = project(source);
      if (!values) return;
      seenSnapshots.add(dimension);
      emit(epoch, { kind: "configuration_snapshot", payload: { dimension, values } });
    } catch { /* unreadable projection */ }
  }, [day, dimension, source, project]);
}
