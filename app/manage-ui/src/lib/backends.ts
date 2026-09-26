import { useEffect, useMemo, useState } from "react";
import { getBackendDescriptors, getConfig } from "../api/client";
import type { BackendDescriptor, UnifiedCronJob } from "../types";
import { useStickyState } from "./useStickyState";
import { invalidatePageCache } from "./usePageCache";
import releasePolicy from "../../../release-policy.json";

const isAvailableBackend = (descriptor: BackendDescriptor) =>
  !releasePolicy.disabledRuntimes.includes(descriptor.id);

export type BackendId = string;
export type ExternalBackendId = string;
export type BackendSurface = keyof BackendDescriptor["surfaces"];

const allSurfaces = (
  connectionMode: BackendDescriptor["connectionMode"],
  cron: BackendDescriptor["surfaces"]["cron"],
  kanban: BackendDescriptor["surfaces"]["kanban"],
): BackendDescriptor["surfaces"] => ({
  chat: true,
  agents: true,
  models: true,
  skills: true,
  usage: true,
  oauth: true,
  dashboardRuns: connectionMode === "builtin-service" || connectionMode === "native-runtime",
  agentHarness: connectionMode === "builtin-service" || connectionMode === "native-runtime",
  cron,
  kanban,
});

const agentLifecycle = (
  connectionMode: BackendDescriptor["connectionMode"],
): BackendDescriptor["agentLifecycle"] => {
  const native = connectionMode === "builtin-service" || connectionMode === "native-runtime";
  return native
    ? { create: true, update: true, remove: false, archive: true, restore: true, readStates: true }
    : { create: true, update: true, remove: true, archive: false, restore: false, readStates: false };
};

// First-paint/offline fallback only. The registry endpoint is authoritative and
// can add another backend without requiring changes to any page.
export const FALLBACK_BACKEND_DESCRIPTORS: readonly BackendDescriptor[] = ([
  {
    id: "openclaw",
    name: "OpenClaw",
    connectionMode: "gateway",
    disconnectable: true,
    agentLifecycle: agentLifecycle("gateway"),
    surfaces: allSurfaces("gateway", { kind: "openclaw" }, { kind: "workboard" }),
  },
  {
    id: "hermes",
    name: "Hermes",
    connectionMode: "managed-service",
    disconnectable: true,
    agentLifecycle: agentLifecycle("managed-service"),
    surfaces: allSurfaces("managed-service", { kind: "hermes" }, { kind: "hermes" }),
  },
  {
    id: "shoggoth",
    name: "Shoggoth",
    connectionMode: "builtin-service",
    disconnectable: false,
    agentLifecycle: agentLifecycle("builtin-service"),
    surfaces: { ...allSurfaces("builtin-service", { kind: "native" }, { kind: "native" }), nativeCapacity: true, runtimeBindings: true, runtimeStatus: true, sessionRuntimeSwitch: true, runtimeUsage: true },
  },
] as const).filter(isAvailableBackend);

// Compatibility exports for leaf components/tests that only need labels.
export const BACKENDS = FALLBACK_BACKEND_DESCRIPTORS.map(({ id, name }) => ({ id, label: name }));
export const SHOGGOTH_BACKEND = { id: "shoggoth", label: "Shoggoth" } as const;

// Hermes cron protocol 的 force trigger 会恢复 paused job 的后续调度。
// 页面只消费 descriptor 协议能力，不按具体 backend id 猜测该副作用。
export function cronForceRunResumesPaused(
  descriptor: BackendDescriptor | undefined,
  job: Pick<UnifiedCronJob, "state" | "stateLabel">,
): boolean {
  return descriptor?.surfaces.cron?.kind === "hermes"
    && [job.state, job.stateLabel].some((value) => value?.trim().toLowerCase() === "paused");
}

function hasSurface(descriptor: BackendDescriptor, surface?: BackendSurface): boolean {
  if (!surface) return true;
  const value = descriptor.surfaces[surface];
  return typeof value === "boolean" ? value : value !== null;
}

let cachedDescriptors: BackendDescriptor[] | null = null;
let descriptorRequest: Promise<BackendDescriptor[]> | null = null;

function loadDescriptors(): Promise<BackendDescriptor[]> {
  descriptorRequest ??= getBackendDescriptors()
    .then((items) => {
      cachedDescriptors = items.length > 0 ? items.filter(isAvailableBackend) : [...FALLBACK_BACKEND_DESCRIPTORS];
      return cachedDescriptors;
    })
    .catch(() => [...FALLBACK_BACKEND_DESCRIPTORS]);
  return descriptorRequest;
}

export function useBackendCatalog(surface?: BackendSurface): BackendDescriptor[] {
  const [descriptors, setDescriptors] = useState<BackendDescriptor[]>(
    cachedDescriptors ?? [...FALLBACK_BACKEND_DESCRIPTORS],
  );
  useEffect(() => {
    let alive = true;
    void loadDescriptors().then((items) => {
      if (alive) setDescriptors(items);
    });
    return () => {
      alive = false;
    };
  }, []);
  return useMemo(
    () => descriptors.filter((descriptor) => hasSurface(descriptor, surface)),
    [descriptors, surface],
  );
}

function readInitialDisabled(): string[] | null {
  try {
    const desktop = (window as { openclawDesktop?: { getConfig?: () => { disabledBackends?: unknown } } })
      .openclawDesktop;
    const disabled = desktop?.getConfig?.()?.disabledBackends;
    return Array.isArray(disabled) ? disabled.filter((value): value is string => typeof value === "string") : null;
  } catch {
    return null;
  }
}

let cachedDisabled: string[] | null = readInitialDisabled();
let configRequest: Promise<string[]> | null = null;
let disabledRevision = 0;
const disabledListeners = new Set<(ids: string[]) => void>();

export function applyDisabledBackends(ids: string[]): void {
  const next = [...new Set(ids)].sort();
  const changed = cachedDisabled === null || [...new Set(cachedDisabled)].sort().join(",") !== next.join(",");
  disabledRevision += 1;
  cachedDisabled = next;
  if (changed) invalidatePageCache();
  for (const listener of disabledListeners) listener(cachedDisabled);
}

function loadDisabled(): Promise<string[]> {
  if (cachedDisabled) return Promise.resolve(cachedDisabled);
  const revision = disabledRevision;
  configRequest ??= getConfig()
    .then((config) => {
      if (revision === disabledRevision) {
        applyDisabledBackends(Array.isArray(config.disabledBackends) ? config.disabledBackends : []);
      }
      return cachedDisabled ?? [];
    })
    .catch(() => []);
  return configRequest;
}

// External, native CLI and Shoggoth connections share the same disabled list.
export function useEnabledBackends(surface?: BackendSurface): BackendId[] {
  const descriptors = useBackendCatalog(surface);
  const [disabled, setDisabled] = useState<string[]>(cachedDisabled ?? []);
  useEffect(() => {
    let alive = true;
    disabledListeners.add(setDisabled);
    void loadDisabled().then((ids) => {
      if (alive) setDisabled(cachedDisabled ?? ids);
    });
    return () => {
      alive = false;
      disabledListeners.delete(setDisabled);
    };
  }, []);
  const disabledSet = useMemo(() => new Set(disabled), [disabled]);
  return useMemo(
    () => descriptors
      .filter((descriptor) => !descriptor.disconnectable || !disabledSet.has(descriptor.id))
      .map((descriptor) => descriptor.id),
    [descriptors, disabledSet],
  );
}

export function resolveBackendAlias(id: string, descriptors: readonly BackendDescriptor[]): string {
  return descriptors.find((entry) => entry.id === id || entry.aliases?.includes(id))?.id
    ?? FALLBACK_BACKEND_DESCRIPTORS.find((entry) => entry.aliases?.includes(id))?.id ?? id;
}

export function useBackendState(
  key: string,
  initial?: BackendId,
  options?: { surface?: BackendSurface },
): [BackendId, (id: BackendId) => void, BackendId[]] {
  const available = useEnabledBackends(options?.surface);
  const catalog = useBackendCatalog(options?.surface);
  const [selected, setSelected] = useStickyState<BackendId>(`backend.${key}`, "openclaw", initial);
  const resolved = resolveBackendAlias(selected, catalog);
  const backend = available.includes(resolved) ? resolved
    : resolved !== selected ? resolved : (available[0] ?? "openclaw");
  return [backend, (id) => setSelected(resolveBackendAlias(id, catalog)), available];
}
