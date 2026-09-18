import { useTranslation } from "react-i18next";
import type { ChatPromptEntry } from "./ChatPromptCard";
import { approvalOptionHint, approvalOptionIsVisible, approvalOptionLabel } from "../lib/approvalOptions";
import { approvalPermissionSummary } from "../lib/approvalPermissions";

const PRODUCT_ACTIONS = new Set([
  "kanban_card_create", "kanban_card_update", "kanban_card_delete",
  "kanban_board_create", "kanban_board_update", "system_open_url", "system_open_folder",
]);

function inputObject(value?: string): Record<string, unknown> {
  if (!value) return {};
  try {
    let parsed = JSON.parse(value);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export default function ChatApprovalCard({ entry, submitting, onChoose, compact = false }: {
  entry: ChatPromptEntry;
  submitting: boolean;
  onChoose: (choice: string) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
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
  const productTool = toolName?.replace(/^(?:mcp__)?shoggoth__/u, "");
  const knownAction = productTool && PRODUCT_ACTIONS.has(productTool)
    && (toolName !== productTool || details?.serverName === "shoggoth");
  const action = knownAction ? t(`chat.promptActions.${productTool}`)
    : permissions ? permissions.title
      : details?.kind === "file_change" ? t("chat.promptChangeFiles")
        : toolName === "Bash" ? t("chat.promptRunCommand")
          : toolName || (command ? t("chat.promptRunCommand") : "");
  const unavailable = canonical?.kind === "runtime_approval" && !canAllow;
  const title = unavailable ? t("chat.promptDetailsUnavailable")
    : canonical?.kind === "mcp_permission" || legacy?.kind === "mcp_tool_approval"
      ? t("chat.promptToolApproval") : t("chat.promptNeedsApproval");
  const genericMessage = !rawMessage || ["需要用户授权", "需要授权", toolName, command].includes(rawMessage);
  const message = unavailable ? t("chat.promptUnavailableHint")
    : canonical?.kind === "mcp_permission" && details?.serverName
      ? t("chat.promptMcpPermissionHint", { server: details.serverName })
      : genericMessage ? "" : rawMessage;
  const input = inputObject(details?.input);
  const summary: Array<[string, string]> = [];
  for (const key of ["boardName", "boardId", "title", "body", "cardId", "path", "file_path", "url"]) {
    if (key === "boardId" && typeof input.boardName === "string") continue;
    if (typeof input[key] === "string" && input[key]) {
      summary.push([t(`chat.promptFields.${key}`), input[key] as string]);
    }
  }
  if (permissions) {
    summary.push(...permissions.rows);
    if (details?.cwd) summary.push([t("chat.promptPermissions.cwd"), details.cwd]);
  }
  const visibleChoices = choices.filter((choice) => choice !== "cancel" || canonical?.kind !== "runtime_approval");
  const legacyLabel = (choice: string) => choice === "once"
    ? t(details?.kind === "permissions" ? "chat.promptAllowTurn" : "chat.promptAllowOnce")
    : choice === "session" ? t("chat.promptAllowSession")
      : choice === "always" ? t("chat.promptAllowAlways")
        : choice === "deny" ? t("chat.promptDenyOperation")
          : choice === "cancel" ? t("common.cancel") : choice;
  const legacyHint = (choice: string) => choice === "session" ? t("chat.promptSessionScopeHint")
    : choice === "always" ? t("chat.promptAlwaysScopeHint")
      : choice === "deny" ? t("chat.promptDenyHint") : undefined;
  const label = (choice: string) => {
    const option = nativeOptions?.find((item) => item.choice === choice);
    return option ? approvalOptionLabel(option, t, nativeOptions) : legacyLabel(choice);
  };
  const hint = (choice: string) => {
    const option = nativeOptions?.find((item) => item.choice === choice);
    return option ? approvalOptionHint(option, t) : legacyHint(choice);
  };
  const content = <>
      <div className="chat-prompt__head">
        <span className="chat-prompt__badge">{interrupted ? t("chat.promptInterruptedApproval") : title}</span>
      </div>
      {action && !unavailable ? <h3 className="chat-prompt__action">{action}</h3> : null}
      {message ? <div className="chat-prompt__q">{message}</div> : null}
      {summary.length > 0 ? <dl className="chat-prompt__summary">
        {summary.map(([name, value], index) => <div key={index}>
          <dt>{name}</dt><dd>{value}</dd>
        </div>)}
      </dl> : null}
      {command && command !== toolName && !knownAction
        ? <pre className="chat-prompt__cmd">{command}</pre> : null}
    </>;
  return (
    <section className={`chat-prompt chat-prompt--approval${details?.kind === "file_change" ? " chat-prompt--file-change" : ""}`} aria-busy={submitting}>
      {compact ? <div className="chat-prompt__content">{content}</div> : content}
      {interrupted ? <div className="chat-prompt__desc" role="status">{t("chat.promptInterruptedApprovalHint")}</div>
        : <div className="chat-prompt__row chat-prompt__actions">
        {visibleChoices.map((choice) =>
          <button key={choice} type="button" className={canAllowChoice(choice)
            ? "chat-prompt__btn is-primary" : "chat-prompt__btn"} disabled={submitting}
            title={hint(choice)}
            onClick={() => onChoose(choice)}>{label(choice)}</button>)}
        {submitting ? <span className="chat-prompt__status" role="status">{t("chat.promptSubmitting")}</span> : null}
      </div>}
    </section>
  );
}
