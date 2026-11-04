import { ChatIcon } from "../../components/NavIcons";

// Small line icons for Settings rows. Decorative only: every row keeps its text label.
const paths = {
  language: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5Z" /></>,
  shortcut: <><rect x="3" y="6" width="18" height="12" rx="2.5" /><path d="M7 10h.01M10.5 10h.01M14 10h.01M17 10h.01M7.5 14h9" /></>,
  update: <><path d="M12 3.5v10" /><path d="m8.5 10.5 3.5 3.5 3.5-3.5" /><path d="M4.5 15.5v1.75A2.75 2.75 0 0 0 7.25 20h9.5a2.75 2.75 0 0 0 2.75-2.75V15.5" /></>,
  schedule: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  task: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  appIcon: <><rect x="4" y="4" width="16" height="16" rx="4.5" /><circle cx="12" cy="12" r="3.5" /></>,
  notification: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" /><path d="M10 21h4" /></>,
  connection: <><path d="m9 15 6-6m-6 9-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m-2 8a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1" /></>,
  computer: <><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></>,
  project: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16" /></>,
} as const;

export type SettingsIconName = keyof typeof paths | "chat";

export function SettingsIcon({ name }: { name: SettingsIconName }) {
  return <span className="settings-row-icon" aria-hidden="true">
    {name === "chat" ? <ChatIcon className="settings-chat-icon" />
      : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
          strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>}
  </span>;
}
