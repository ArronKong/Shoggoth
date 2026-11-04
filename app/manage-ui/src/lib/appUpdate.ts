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

export const appUpdateBridge = () => (window as unknown as {
  openclawDesktop?: { appUpdate?: DesktopAppUpdateBridge };
}).openclawDesktop?.appUpdate;
