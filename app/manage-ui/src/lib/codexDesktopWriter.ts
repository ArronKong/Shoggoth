export interface CodexDesktopWriterState {
  state: "available" | "busy" | "unknown";
  owner: "codex-desktop" | "codex-client" | "shoggoth" | null;
  checkedAt: number;
}

export function codexDesktopWriterLabelKey(writer?: CodexDesktopWriterState): string | null {
  if (!writer || writer.state === "unknown") return "chat.codexWriterUnknown";
  if (writer.state !== "busy") return null;
  return writer.owner === "codex-desktop" ? "chat.codexDesktopWriterBusy" : "chat.codexClientWriterBusy";
}

export function codexDesktopWriterHintKey(writer?: CodexDesktopWriterState): string | null {
  const label = codexDesktopWriterLabelKey(writer);
  return label ? label + "Hint" : null;
}
