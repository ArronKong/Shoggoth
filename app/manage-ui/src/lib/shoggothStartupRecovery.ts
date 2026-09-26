import type {
  ShoggothProductStatus,
  ShoggothProviderSnapshot,
} from "../types";

const STARTUP_RETRY_DELAYS_MS = [
  250, 500, 1_000, 2_000, 3_000,
  5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 5_000,
] as const;

type Wait = (delayMs: number) => Promise<void>;
type IsCurrent = () => boolean;

function waitFor(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export function shouldRecoverShoggothStartup(status: ShoggothProductStatus | null): boolean {
  if (!status || status.service.healthy || status.background.supported !== true
    || status.background.needsRepair !== false) return false;
  // A clean install can be sampled before the plist is written or during any
  // install/enable/bootstrap transition. This recovery only observes status,
  // so bounded polling of an explicitly stopped agent cannot start it again.
  return true;
}

export async function recoverShoggothStartup(options: {
  initialStatus: ShoggothProductStatus;
  getStatus: () => Promise<ShoggothProductStatus>;
  getProviders?: () => Promise<ShoggothProviderSnapshot>;
  onStatus: (status: ShoggothProductStatus) => void;
  onProviders?: (providers: ShoggothProviderSnapshot | null) => void;
  isCurrent?: IsCurrent;
  retryDelaysMs?: readonly number[];
  wait?: Wait;
}): Promise<"recovered" | "not-needed" | "stopped" | "canceled" | "exhausted"> {
  if (!shouldRecoverShoggothStartup(options.initialStatus)) return "not-needed";
  const isCurrent = options.isCurrent || (() => true);
  const wait = options.wait || waitFor;
  for (const delayMs of options.retryDelaysMs || STARTUP_RETRY_DELAYS_MS) {
    await wait(delayMs);
    if (!isCurrent()) return "canceled";
    let status: ShoggothProductStatus;
    try {
      status = await options.getStatus();
    } catch {
      continue;
    }
    if (!isCurrent()) return "canceled";
    if (status.service.healthy) {
      if (!options.getProviders) {
        options.onStatus(status);
        return "recovered";
      }
      let providers: ShoggothProviderSnapshot;
      try { providers = await options.getProviders(); } catch {
        if (!isCurrent()) return "canceled";
        options.onStatus(status);
        return "recovered";
      }
      if (!isCurrent()) return "canceled";
      // Publish the healthy status and its provider snapshot together. In React,
      // publishing healthy first tears down the recovery effect before the
      // provider request can commit, leaving a stale "missing provider" card.
      options.onStatus(status);
      options.onProviders?.(providers);
      return "recovered";
    }
    options.onStatus(status);
    if (!shouldRecoverShoggothStartup(status)) return "stopped";
  }
  return "exhausted";
}
