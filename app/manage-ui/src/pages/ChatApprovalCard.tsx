import "../i18n/promptCardResources";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChatPromptEntry } from "./ChatPromptCard";
import ChatPromptChoices from "./ChatPromptChoices";
import { approvalChoiceLabel, approvalOptionHint, approvalOptionIsVisible, approvalOptionsNeedSelection } from "../lib/approvalOptions";
import { approvalPermissionSummary } from "../lib/approvalPermissions";
import { approvalHeadline, describeApproval, pathOutside, productToolOf } from "../lib/approvalPhrase";

function inputObject(value?: string): Record<string, unknown> {
  if (!value) return {};
  try {
    let parsed = JSON.parse(value);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export default function ChatApprovalCard({ entry, submitting, onChoose, compact = false, agentName }: {
  entry: ChatPromptEntry;
  submitting: boolean;
  onChoose: (choice: string) => void;
  compact?: boolean;
  /** Who is asking, e.g. "Antigravity"; falls back to a generic subject. */
  agentName?: string;
}) {
  const { t, i18n } = useTranslation();
  const [selection, setSelection] = useState<{ id: string; choice: string } | null>(null);
  const canonical = "version" in entry && entry.version === 1 ? entry : null;
  const interrupted = canonical?.interrupted === true;
  const legacy = canonical ? null : entry as {
    kind: string; command?: string; description?: string; question?: string; choices?: string[];
  };
  const choices = [...new Set(canonical ? canonical.approvalChoices
    : legacy?.choices?.length ? legacy.choices : ["once", "deny"])].filter((choice) => {
      const option = canonical?.approvalOptions?.find((item) => item.choice === choice);
      return !option || approvalOptionIsVisible(option);
    });
  const nativeOptions = canonical?.approvalOptions?.filter((option) => choices.includes(option.choice));
  const canAllowChoice = (choice: string) => ["once", "session", "always"].includes(choice)
    || nativeOptions?.some((option) => option.choice === choice && option.kind.startsWith("allow_"));
  const canAllow = choices.some(canAllowChoice);
  const details = canAllow ? canonical?.approvalDetails : undefined;
  const permissions = details?.kind === "permissions" ? approvalPermissionSummary(details.permissions, t) : undefined;
  const rawMessage = canonical?.message || legacy?.description || legacy?.question || "";
  const command = details?.command || (canAllow ? legacy?.command : undefined);
  const toolName = details?.toolName || [rawMessage, command].find((text) =>
    text && /^(?:mcp__)?shoggoth__[a-z0-9_]+$/u.test(text));
  const knownAction = Boolean(productToolOf({ ...details, toolName }));
  const phrase = canAllow && !permissions ? describeApproval({ ...details, toolName, command }) : null;
  const agent = agentName || t("chat.approvalAgentFallback");
  const action = permissions ? permissions.title
    : phrase ? approvalHeadline(phrase, agent, t, i18n?.language)
      : details?.kind === "file_change" ? t("chat.promptChangeFiles")
        : toolName || (command ? t("chat.promptRunCommand") : "");
  const unavailable = canonical?.kind === "runtime_approval" && !canAllow;
  const title = unavailable ? t("chat.promptDetailsUnavailable")
    : canonical?.kind === "mcp_permission" || legacy?.kind === "mcp_tool_approval"
      ? t("chat.promptToolApproval") : t("chat.promptNeedsApproval");
  const genericMessage = !rawMessage || ["需要用户授权", "需要授权", toolName, command].includes(rawMessage);
  // Runtime-written text is shown as the agent's own words, apart from the facts.
  // An MCP permission's message stays visible: it names the app behind the tool.
  const message = unavailable ? t("chat.promptUnavailableHint")
    : genericMessage ? "" : phrase || permissions ? t("chat.approvalSays", { reason: rawMessage }) : rawMessage;
  const input = inputObject(details?.input);
  const summary: Array<[string, string]> = [];
  if (!phrase || phrase.key === "product") {
    for (const key of ["boardName", "boardId", "title", "body", "cardId", "path", "file_path", "url"]) {
      if (key === "boardId" && typeof input.boardName === "string") continue;
      if (typeof input[key] === "string" && input[key]) {
        summary.push([t(`chat.promptFields.${key}`), input[key] as string]);
      }
    }
  }
  if (permissions) {
    summary.push(...permissions.rows);
    if (details?.cwd) summary.push([t("chat.promptPermissions.cwd"), details.cwd]);
  }
  const visible = choices.filter((choice) => choice !== "cancel" || canonical?.kind !== "runtime_approval");
  // "Allow" first and the only primary action; other allow scopes next, deny last.
  const firstAllow = visible.find((choice) => choice === "once"
    || nativeOptions?.some((option) => option.choice === choice && option.kind === "allow_once"))
    ?? visible.find(canAllowChoice);
  const visibleChoices = [
    ...(firstAllow ? [firstAllow] : []),
    ...visible.filter((choice) => choice !== firstAllow && canAllowChoice(choice)),
    ...visible.filter((choice) => choice !== firstAllow && !canAllowChoice(choice)),
  ];
  const selectionMode = approvalOptionsNeedSelection(nativeOptions || []);
  const selected = selection?.id === entry.id && visibleChoices.includes(selection.choice) ? selection.choice : "";
  const offersAlways = nativeOptions?.some((option) => option.kind === "allow_always") || visible.includes("always");
  const unscopedAlways = nativeOptions?.some((option) => option.kind === "allow_always" && !option.scope)
    || visible.includes("always");
  const root = details?.cwd || details?.grantRoot;
  const risks = [
    ...(phrase?.web ? [t("chat.approvalRisk.web")] : []),
    ...(phrase?.web && offersAlways ? [t("chat.approvalRisk.alwaysWeb")] : []),
    ...(details?.networkHost ? [t("chat.approvalRisk.network", { host: details.networkHost })] : []),
    ...(phrase?.target?.kind === "path" && pathOutside(phrase.target.text, root) ? [t("chat.approvalRisk.outside")] : []),
  ];
  const legacyHint = (choice: string) => choice === "session" ? t("chat.promptSessionScopeHint")
    : choice === "always" ? t("chat.promptAlwaysScopeHint")
      : choice === "deny" ? t("chat.promptDenyHint") : undefined;
  const label = (choice: string) => approvalChoiceLabel(choice, t, nativeOptions, details?.kind === "permissions");
  const hint = (choice: string) => {
    const option = nativeOptions?.find((item) => item.choice === choice);
    return option ? approvalOptionHint(option, t) : legacyHint(choice);
  };
  const content = <>
      <div className="chat-prompt__head">
        <span className="chat-prompt__badge">{interrupted ? t("chat.promptInterruptedApproval")
          : selectionMode ? t("chat.promptChooseOption") : title}</span>
      </div>
      {action && !unavailable ? <h3 className="chat-prompt__action">{action}</h3> : null}
      {phrase?.target ? <pre className="chat-prompt__cmd">{phrase.target.text}</pre> : null}
      {phrase?.target?.kind === "command" && details?.cwd
        ? <div className="chat-prompt__desc">{t("chat.approvalRunsIn", { cwd: details.cwd })}</div> : null}
      {message ? <div className="chat-prompt__q">{message}</div> : null}
      {phrase?.readOnly && !phrase.web ? <div className="chat-prompt__desc">{t("chat.approvalReadOnly")}</div> : null}
      {risks.map((risk) => <div key={risk} className="chat-prompt__risk">{risk}</div>)}
      {unscopedAlways ? <div className="chat-prompt__desc">{t("chat.promptAlwaysScopeHint")}</div> : null}
      {summary.length > 0 ? <dl className="chat-prompt__summary">
        {summary.map(([name, value], index) => <div key={index}>
          <dt>{name}</dt><dd>{value}</dd>
        </div>)}
      </dl> : null}
      {!phrase && command && command !== toolName && !knownAction
        ? <pre className="chat-prompt__cmd">{command}</pre> : null}
      {phrase?.technical && phrase.key !== "product"
        ? <div className="chat-prompt__technical">{t("chat.approvalTechnical", { detail: phrase.technical })}</div> : null}
      {selectionMode && !interrupted ? <ChatPromptChoices label={action || title}
        options={visibleChoices.filter(canAllowChoice).map((choice) => ({
          value: choice, label: label(choice), description: hint(choice) === label(choice) ? undefined : hint(choice),
        }))} selected={selected ? [selected] : []} disabled={submitting}
        onChoose={(choice) => setSelection({ id: entry.id, choice })} /> : null}
    </>;
  return (
    <section className={`chat-prompt chat-prompt--approval${selectionMode ? " chat-prompt--selection" : ""}${details?.kind === "file_change" ? " chat-prompt--file-change" : ""}`} aria-busy={submitting}>
      {compact ? <div className="chat-prompt__content">{content}</div> : content}
      {interrupted ? <div className="chat-prompt__desc" role="status">{t("chat.promptInterruptedApprovalHint")}</div>
        : <div className="chat-prompt__row chat-prompt__actions">
        {selectionMode ? <button type="button" className="chat-prompt__btn is-primary" disabled={submitting || !selected}
          onClick={() => { if (selected) onChoose(selected); }}>{t("chat.promptConfirmChoice")}</button> : null}
        {visibleChoices.filter((choice) => !selectionMode || !canAllowChoice(choice)).map((choice) =>
          <button key={choice} type="button" className={choice === firstAllow
            ? "chat-prompt__btn is-primary" : "chat-prompt__btn"} disabled={submitting}
            title={hint(choice)}
            onClick={() => onChoose(choice)}>{label(choice)}</button>)}
      </div>}
    </section>
  );
}
