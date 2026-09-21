export type DesktopPrinterGeometry = { top: number; center: number; tray: { x: number; y: number }; presentationId?: number };
export type DesktopShortcutState = { accelerator: string; registered: boolean };
export type DesktopInspirationBridge = {
  surface?: boolean;
  ready?: () => Promise<DesktopPrinterGeometry>;
  reveal?: (presentationId: number) => Promise<boolean>;
  conceal?: (presentationId: number) => Promise<boolean>;
  dismiss?: () => Promise<boolean>;
  setInteractive?: (value: boolean) => void;
  setBusy?: (value: boolean) => void;
  trayTarget?: () => Promise<{ x: number; y: number }>;
  onShow?: (callback: (geometry: DesktopPrinterGeometry) => void) => () => void;
  onHide?: (callback: (presentationId: number) => void) => () => void;
  onHidden?: (callback: () => void) => () => void;
  onGeometry?: (callback: (geometry: DesktopPrinterGeometry) => void) => () => void;
  getPreferences?: () => Promise<DesktopShortcutState>;
  captureShortcut?: (value: boolean) => Promise<DesktopShortcutState>;
  setShortcut?: (accelerator: string) => Promise<DesktopShortcutState & { ok: boolean; error?: string }>;
};
export const desktopInspirationBridge = () => (window as unknown as { openclawDesktop?: {
  desktopInspiration?: DesktopInspirationBridge;
} }).openclawDesktop?.desktopInspiration;
