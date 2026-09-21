export type AppUpdateStatus =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error"
  | "installing";

export type AppUpdateState = {
  supported: boolean;
  reason: string | null;
  status: AppUpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  releaseName: string | null;
  releaseDate: string | null;
  progress: number | null;
  canCheck: boolean;
  canInstall: boolean;
};

export type DesktopAppUpdateBridge = {
  getState: () => Promise<AppUpdateState | null>;
  check: () => Promise<AppUpdateState>;
  install: () => Promise<boolean>;
  onState: (listener: (state: AppUpdateState) => void) => () => void;
};

export const appUpdateBridge = () => (window as unknown as {
  openclawDesktop?: { appUpdate?: DesktopAppUpdateBridge };
}).openclawDesktop?.appUpdate;
