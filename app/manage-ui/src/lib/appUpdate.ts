export type AppUpdateStatus =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "preparing"
  | "recovering"
  | "up-to-date"
  | "error"
  | "installing";

export type AppUpdateState = {
  supported: boolean;
  reason: string | null;
  status: AppUpdateStatus;
  currentVersion: string;
  automaticUpdates: boolean;
  availableVersion: string | null;
  releaseName: string | null;
  releaseDate: string | null;
  progress: number | null;
  canCheck: boolean;
  canInstall: boolean;
  installBlockReason: string | null;
};

export type DesktopAppUpdateBridge = {
  getState: () => Promise<AppUpdateState | null>;
  check: () => Promise<AppUpdateState>;
  setAutomatic: (enabled: boolean) => Promise<AppUpdateState | null>;
  install: () => Promise<boolean>;
  onState: (listener: (state: AppUpdateState) => void) => () => void;
};

export const APP_UPDATE_SECTION_ID = "settings-app-update";

export const appUpdateBridge = () => (window as unknown as {
  openclawDesktop?: { appUpdate?: DesktopAppUpdateBridge };
}).openclawDesktop?.appUpdate;

export function observeAppUpdateState(
  bridge: DesktopAppUpdateBridge,
  onState: (state: AppUpdateState | null) => void,
  onReadError?: () => void,
) {
  let active = true;
  let receivedEvent = false;
  const dispose = bridge.onState((state) => {
    if (!active) return;
    receivedEvent = true;
    onState(state);
  });
  // A push received while the initial snapshot is in flight is already newer.
  void bridge.getState().then(
    (state) => { if (active && !receivedEvent) onState(state); },
    () => { if (active && !receivedEvent) onReadError?.(); },
  );
  return () => { active = false; dispose(); };
}
