// 聊天图标（Figma 6377:264 体系）——ChatPage 与 ImmersiveChat 共用的那部分。
// 抽成独立模块是为了让沉浸层复用同形状图标而不反向 import ChatPage（避免循环依赖）；
// 颜色一律 currentColor：普通模式随主题、沉浸模式按钮 color:#fff 即白色。

export function IconSend() {
  // exact Figma vector (node 6377:473 "send-diagonal")
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22.1525 3.55273L11.1772 21.0039L9.50684 12.4073L2 7.89747L22.1525 3.55273Z" />
      <path d="M9.45508 12.4431L22.1519 3.55273" />
    </svg>
  );
}
export function IconClip() {
  // exact Figma vector (node 6377:486 "attachment")
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11.9696L12.4356 19.5496C11.5089 20.4783 10.252 21 8.94145 21C7.63089 21 6.37402 20.4783 5.44732 19.5496C4.52061 18.6211 4 17.3616 4 16.0483C4 14.735 4.52061 13.4756 5.44732 12.5469L13.0117 4.96687C13.6296 4.34779 14.4675 4 15.3412 4C16.2149 4 17.0528 4.34779 17.6706 4.96687C18.2884 5.58595 18.6355 6.4256 18.6355 7.3011C18.6355 8.17662 18.2884 9.01626 17.6706 9.63534L10.0979 17.2154C9.78903 17.525 9.37007 17.6988 8.93322 17.6988C8.49637 17.6988 8.07741 17.525 7.76851 17.2154C7.45961 16.9058 7.28607 16.4861 7.28607 16.0483C7.28607 15.6106 7.45961 15.1907 7.76851 14.8812L14.7567 7.88673" />
    </svg>
  );
}
export function IconSearch() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
export function IconClock() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
export function IconArchive() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v9a1.5 1.5 0 001.5 1.5h11A1.5 1.5 0 0019 18V9M10 13h4" />
    </svg>
  );
}
export function IconMic() {
  // exact Figma vector (node 6377:476), 24×24 centred
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.9992 3C11.3172 3 10.6631 3.27092 10.1809 3.75315C9.69865 4.23539 9.42773 4.88944 9.42773 5.57143V11.5714C9.42773 12.2534 9.69865 12.9075 10.1809 13.3897C10.6631 13.8719 11.3172 14.1429 11.9992 14.1429C12.6811 14.1429 13.3352 13.8719 13.8174 13.3897C14.2997 12.9075 14.5706 12.2534 14.5706 11.5714V5.57143C14.5706 4.88944 14.2997 4.23539 13.8174 3.75315C13.3352 3.27092 12.6811 3 11.9992 3Z" />
      <path d="M18 9.85742V11.5717C18 13.163 17.3679 14.6891 16.2426 15.8143C15.1174 16.9396 13.5913 17.5717 12 17.5717C10.4087 17.5717 8.88258 16.9396 7.75736 15.8143C6.63214 14.6891 6 13.163 6 11.5717V9.85742" />
      <path d="M12 17.5713V20.1427" />
      <path d="M8.57227 20.1426H15.4294" />
    </svg>
  );
}
export function IconCommand() {
  // Figma "Commands" — rounded square with a slash (node 6377:422)
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M14 8.5l-4 7" />
    </svg>
  );
}
export function IconFast() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m13 2-10 12h9l-1 8 10-12h-9l1-8Z" />
    </svg>
  );
}
export function IconStop() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
    </svg>
  );
}
export function IconPencil() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}
export function IconBoard() {
  // 看板列（沉浸模式当前 agent 的 kanban 面板入口）
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="5.4" height="16" rx="1.6" />
      <rect x="9.3" y="4" width="5.4" height="11" rx="1.6" />
      <rect x="15.6" y="4" width="5.4" height="13.5" rx="1.6" />
    </svg>
  );
}
export function IconUser() {
  // 档案（沉浸模式当前 agent 的 profile 面板入口）
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20c1.6-3.3 4.3-5 7.5-5s5.9 1.7 7.5 5" />
    </svg>
  );
}
export function IconActivity() {
  // 勾选清单（沉浸模式「今日动态」视图切换）
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 6.5h11M10 12h11M10 17.5h11" />
      <path d="M3 6l1.5 1.5L7 5" />
      <path d="M3 11.5l1.5 1.5L7 10.5" />
      <path d="M3 17l1.5 1.5L7 16" />
    </svg>
  );
}
export function IconImmersiveExit() {
  // 四角向内收缩（IconImmersive 的反向）——沉浸模式右上角的退出按钮
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3.5V9H3.5" />
      <path d="M15 3.5V9h5.5" />
      <path d="M9 20.5V15H3.5" />
      <path d="M15 20.5V15h5.5" />
    </svg>
  );
}
