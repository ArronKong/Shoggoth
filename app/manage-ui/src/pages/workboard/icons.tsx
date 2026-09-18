// Lucide / Feather icon paths: ISC and MIT. Copyright notices and full terms:
// resources/legal/licenses/source/LUCIDE-FEATHER.txt
// 工作板内联图标（对应官方 lucide 图标集的子集），随文字色。
import type { ReactNode } from "react";

function I({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={`wb-icon${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IcClock = () => (
  <I><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></I>
);
export const IcPlay = () => <I><path d="m6 4 14 8-14 8z" /></I>;
export const IcPen = () => (
  <I><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></I>
);
export const IcEdit = () => (
  <I><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z" /></I>
);
export const IcArchive = () => (
  <I><rect x="2" y="4" width="20" height="5" rx="1" /><path d="M4 9v11h16V9" /><path d="M10 13h4" /></I>
);
export const IcArchiveRestore = () => (
  <I><rect x="2" y="4" width="20" height="5" rx="1" /><path d="M4 9v11h16V9" /><path d="m9 15 3-3 3 3" /><path d="M12 12v6" /></I>
);
export const IcTrash = () => (
  <I><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></I>
);
export const IcMessage = () => (
  <I><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></I>
);
export const IcStop = () => <I><rect x="5" y="5" width="14" height="14" rx="2" /></I>;
export const IcPanelRight = () => (
  <I><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /><path d="m8 9 3 3-3 3" /></I>
);
export const IcZap = () => <I><path d="M13 2 3 14h7l-1 8 10-12h-7z" /></I>;
export const IcPlus = () => <I><path d="M12 5v14" /><path d="M5 12h14" /></I>;
export const IcEye = () => (
  <I><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></I>
);
export const IcEyeOff = () => (
  <I><path d="M9.9 4.2A10.6 10.6 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-2.2 3.2" /><path d="M6.6 6.6A18.5 18.5 0 0 0 2 12s3.5 8 10 8a10.7 10.7 0 0 0 5.4-1.4" /><path d="M2 2l20 20" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></I>
);
export const IcCornerDownRight = () => (
  <I><path d="m15 10 5 5-5 5" /><path d="M4 4v7a4 4 0 0 0 4 4h12" /></I>
);
export const IcAlert = () => (
  <I><path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></I>
);
export const IcX = () => <I><path d="M18 6 6 18" /><path d="m6 6 12 12" /></I>;
// 官方 layoutCompact/layoutComfortable 双档密度图标。
export const IcLayoutCompact = () => (
  <I><rect x="3" y="4" width="18" height="4" rx="1" /><rect x="3" y="10" width="18" height="4" rx="1" /><rect x="3" y="16" width="18" height="4" rx="1" /></I>
);
export const IcLayoutComfortable = () => (
  <I><rect x="3" y="4" width="18" height="7" rx="1" /><rect x="3" y="14" width="18" height="7" rx="1" /></I>
);
