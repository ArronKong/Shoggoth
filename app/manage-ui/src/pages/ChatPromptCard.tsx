import "../i18n/promptCardResources";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import ChatApprovalCard from "./ChatApprovalCard";
import ChatPromptChoices from "./ChatPromptChoices";
import "./ChatPromptCard.css";
import type {
  InteractiveFieldV1,
  InteractiveRequestV1,
  OpenClawQuestion,
  OpenClawQuestionPromptEntry,
} from "../types";

// A blocking agent request (Hermes gateway approval/clarify/sudo/secret) —
// rendered as an interactive card on the pending bubble; answered via the
// proxy's `chat.respond`. Shared by the normal thread and the immersive
// overlay (pure move out of ChatPage in the immersive parity pass — keep the
// component self-contained: no ChatPage state, global `chat-prompt*` classes).
interface LegacyChatPromptEntry {
  id: string; // client-local identity (dismiss/replace)
  kind: "approval" | "clarify" | "sudo" | "secret" | string;
  requestId?: string;
  question?: string;
  command?: string;
  description?: string;
  choices?: string[];
  questions?: Array<{
    id: string;
    title?: string;
    header?: string;
    question?: string;
    description?: string;
    required?: boolean;
  }>;
}

export type ChatPromptEntry =
  | LegacyChatPromptEntry
  | (InteractiveRequestV1 & { id: string; interrupted?: boolean })
  | OpenClawQuestionPromptEntry;

export type ChatPromptAttention = "approval" | "input";

export function isApprovalPrompt(entry: ChatPromptEntry): boolean {
  if ("version" in entry && entry.version === 1) return entry.fields.length === 0;
  return entry.kind === "approval" || entry.kind === "mcp_tool_approval";
}

export function chatPromptAttentionOf(entries: ChatPromptEntry[]): ChatPromptAttention | null {
  const pending = entries.filter(entry => !("interrupted" in entry && entry.interrupted));
  if (!pending.length) return null;
  return pending.some(isApprovalPrompt) ? "approval" : "input";
}

export function interruptedApprovalEntry(value: unknown): ChatPromptEntry | null {
  if (!value || typeof value !== "object") return null;
  const request = value as InteractiveRequestV1;
  if (request.version !== 1 || !["runtime_approval", "mcp_permission", "product_confirmation"].includes(request.kind)
    || typeof request.requestId !== "string" || typeof request.runId !== "string"
    || typeof request.message !== "string" || !Array.isArray(request.fields) || request.fields.length !== 0
    || !Array.isArray(request.approvalChoices)) return null;
  return { ...request, id: `interrupted-${request.runId}-${request.requestId}`, interrupted: true };
}

export interface ChatPromptResponse {
  choice?: string;
  value?: string;
  action?: "submit" | "cancel";
  answers?: Record<string, string>;
  questionAnswers?: Record<string, string[]>;
}

function isOpenClawQuestionPromptEntry(entry: ChatPromptEntry): entry is OpenClawQuestionPromptEntry {
  return entry.kind === "openclaw_question"
    && "status" in entry
    && "expiresAtMs" in entry
    && Array.isArray(entry.questions);
}

function confirmationOptionLabel(label: string): string {
  return label.replace(/\s*[（(](?:recommended|推荐)[）)]\s*$/iu, "").trim();
}

function isCancelOption(label: string): boolean {
  return /^(?:cancel|取消)$/iu.test(confirmationOptionLabel(label));
}

// A single two-way choice with an explicit Cancel is already a complete
// confirmation. This only changes presentation: every click submits the
// original option value, including Cancel, through the input protocol.
function directConfirmationField(request: InteractiveRequestV1 | null): InteractiveFieldV1 | null {
  if (request?.fields.length !== 1) return null;
  const field = request.fields[0];
  return field.type === "choice" && !field.secret && field.options.length === 2
    && field.options.filter((option) => isCancelOption(option.label)).length === 1
    ? field : null;
}

function PromptAnswerInput({ secret, label, value, disabled, placeholder, onChange, onSubmit }: {
  secret?: boolean; label: string; value: string; disabled: boolean; placeholder: string;
  onChange: (value: string) => void; onSubmit?: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing && (secret || event.metaKey || event.ctrlKey) && onSubmit) {
      event.preventDefault(); onSubmit();
    }
  };
  const props = { className: "chat-prompt__input", "aria-label": label, value, disabled, placeholder,
    autoComplete: "off", onKeyDown };
  return secret ? <input {...props} type="password" onChange={(event) => onChange(event.target.value)} />
    : <textarea {...props} rows={3} onChange={(event) => onChange(event.target.value)} />;
}

// Choices remain editable until explicit submission; secret answers stay masked
// and are excluded from persisted drafts.
const inputDrafts = new Map<string, Record<string, string>>();

export default function ChatPromptCard({
  entry,
  onRespond,
  draftKey,
  compactApproval = false,
  agentName,
  compactInput = false,
}: {
  entry: ChatPromptEntry;
  draftKey?: string;
  compactApproval?: boolean;
  agentName?: string;
  compactInput?: boolean;
  onRespond: (entry: ChatPromptEntry, data: ChatPromptResponse) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [legacySelection, setLegacySelection] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>(() => draftKey ? inputDrafts.get(draftKey) || {} : {});
  useEffect(() => {
    if (!draftKey || !("version" in entry) || entry.version !== 1) return;
    const safeAnswers = Object.fromEntries(entry.fields.filter((field) => !field.secret && answers[field.id] !== undefined).map((field) => [field.id, answers[field.id]]));
    inputDrafts.delete(draftKey); inputDrafts.set(draftKey, safeAnswers);
    while (inputDrafts.size > 128) inputDrafts.delete(inputDrafts.keys().next().value!);
  }, [answers, draftKey, entry]);
  const [questionSelections, setQuestionSelections] = useState<Record<string, string[]>>({});
  const [questionFreeText, setQuestionFreeText] = useState<Record<string, string>>({});
  const [expiredQuestionId, setExpiredQuestionId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dismissedApprovalId, setDismissedApprovalId] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const openClawQuestion = isOpenClawQuestionPromptEntry(entry) ? entry : null;
  useEffect(() => {
    if (!openClawQuestion) return;
    const clearDrafts = () => {
      setQuestionSelections({});
      setQuestionFreeText({});
    };
    if (openClawQuestion.status !== "pending") {
      clearDrafts();
      return;
    }
    const remainingMs = openClawQuestion.expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      setExpiredQuestionId(openClawQuestion.id);
      clearDrafts();
      return;
    }
    const timer = window.setTimeout(
      () => {
        setExpiredQuestionId(openClawQuestion.id);
        clearDrafts();
      },
      Math.min(remainingMs, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [openClawQuestion?.expiresAtMs, openClawQuestion?.id, openClawQuestion?.status]);
  const respond = async (data: ChatPromptResponse) => {
    if (submittingRef.current || dismissedApprovalId === entry.id || ("interrupted" in entry && entry.interrupted)) return;
    submittingRef.current = true;
    setSubmitting(true);
    // Hide approvals on click; keep the request until its owner acknowledges it.
    // Retain dismissal after success so a delayed projection cannot flash it back.
    if (isApprovalPrompt(entry)) setDismissedApprovalId(entry.id);
    try {
      await onRespond(entry, data);
      if (draftKey) inputDrafts.delete(draftKey);
    } catch {
      // The owner shows the error; restore the same request for an explicit retry.
      setDismissedApprovalId(current => current === entry.id ? null : current);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (openClawQuestion) {
    const expired = openClawQuestion.status === "expired"
      || openClawQuestion.expiresAtMs <= Date.now()
      || expiredQuestionId === openClawQuestion.id;
    const pending = openClawQuestion.status === "pending" && !expired;
    const answerValues = (question: OpenClawQuestion) => {
      const selected = questionSelections[question.questionId] ?? [];
      const rawOther = questionFreeText[question.questionId] ?? "";
      const other = question.isSecret ? rawOther : rawOther.trim();
      return other ? [...selected, other] : selected;
    };
    const ready = openClawQuestion.questions.length > 0
      && openClawQuestion.questions.every((question) => answerValues(question).length > 0);
    const toggleOption = (question: OpenClawQuestion, label: string) => {
      setQuestionSelections((previous) => {
        const selected = previous[question.questionId] ?? [];
        const next = question.multiSelect
          ? selected.includes(label)
            ? selected.filter((value) => value !== label)
            : [...selected, label]
          : [label];
        return { ...previous, [question.questionId]: next };
      });
      if (!question.multiSelect) {
        setQuestionFreeText((previous) => ({ ...previous, [question.questionId]: "" }));
      }
    };
    const updateOther = (question: OpenClawQuestion, nextValue: string) => {
      setQuestionFreeText((previous) => ({ ...previous, [question.questionId]: nextValue }));
      if (!question.multiSelect && (question.isSecret ? nextValue.length > 0 : nextValue.trim().length > 0)) {
        setQuestionSelections((previous) => ({ ...previous, [question.questionId]: [] }));
      }
    };
    const submitQuestionAnswers = () => {
      const submitted: Record<string, string[]> = {};
      for (const question of openClawQuestion.questions) {
        Object.defineProperty(submitted, question.questionId, {
          configurable: true,
          enumerable: true,
          value: answerValues(question),
          writable: true,
        });
      }
      void respond({ action: "submit", questionAnswers: submitted });
    };
    return (
      <section className="chat-prompt chat-prompt--input" aria-busy={submitting}>
        <div className="chat-prompt__content">
        <div className="chat-prompt__head">
          <span className="chat-prompt__badge">{t("chat.promptClarify")}</span>
        </div>
        {openClawQuestion.questions.map((question) => (
          <fieldset key={question.questionId} className="chat-prompt__field">
            <legend className="chat-prompt__field-label">{question.header}</legend>
            <span className="chat-prompt__desc">{question.question}</span>
            {pending ? (
              <>
                {question.options.length > 0 ? (
                  <ChatPromptChoices label={question.header} multiple={question.multiSelect}
                    options={question.options.map((option) => ({ ...option, value: option.label }))}
                    selected={questionSelections[question.questionId] ?? []} disabled={submitting}
                    onChoose={(label) => toggleOption(question, label)} />
                ) : null}
                {question.isOther || question.options.length === 0 ? (
                  <PromptAnswerInput
                    secret={question.isSecret}
                    label={question.options.length > 0 ? `${question.header} · ${t("models.other")}` : question.header}
                    value={questionFreeText[question.questionId] ?? ""}
                    disabled={submitting}
                    placeholder={question.options.length > 0 ? t("models.other") : t("chat.promptPlaceholder")}
                    onChange={(nextValue) => updateOther(question, nextValue)}
                  />
                ) : null}
                {question.secretStore ? (
                  <span className="chat-prompt__desc">
                    {question.secretStore.name} · {question.secretStore.kind}
                    {question.secretStore.reason ? ` — ${question.secretStore.reason}` : ""}
                    {question.secretStore.allowedHosts?.length
                      ? ` · ${t("chat.promptSecretHosts", { hosts: question.secretStore.allowedHosts.join(", ") })}`
                      : ""}
                    {question.secretStoreExisting
                      ? ` · ${t("chat.promptSecretExisting", {
                        time: new Date(question.secretStoreExisting.updatedAtMs).toLocaleString(),
                      })}`
                      : ""}
                  </span>
                ) : null}
              </>
            ) : null}
          </fieldset>
        ))}
        </div>
        {pending ? (
          <div className="chat-prompt__row chat-prompt__actions">
            <button
              type="button"
              className="chat-prompt__btn is-primary"
              disabled={submitting || !ready}
              onClick={submitQuestionAnswers}
            >
              {t("chat.promptSubmit")}
            </button>
            <button
              type="button"
              className="chat-prompt__btn is-deny"
              disabled={submitting}
              onClick={() => { void respond({ action: "cancel" }); }}
            >
              {t("setup.skip")}
            </button>
          </div>
        ) : (
          <div className="chat-prompt__desc" role="status">
            {expired ? t("dashboard.expired") : openClawQuestion.status}
          </div>
        )}
      </section>
    );
  }

  const canonical = "version" in entry && entry.version === 1 ? entry : null;
  const legacy = canonical ? null : entry as LegacyChatPromptEntry;
  const isApproval = isApprovalPrompt(entry);
  if (isApproval) return dismissedApprovalId === entry.id ? null : <ChatApprovalCard entry={entry} submitting={submitting} compact={compactApproval}
    agentName={agentName} onChoose={(choice) => { void respond({ choice }); }} />;
  const heading =
    (canonical?.kind === "product_confirmation" ? t("chat.promptProductConfirmation")
      : canonical?.kind === "user_input" ? t("chat.promptNeedsInput") : canonical?.title)
      || (legacy?.kind === "approval"
      ? t("chat.promptApproval")
      : legacy?.kind === "mcp_tool_approval"
        ? t("chat.promptToolApproval")
      : legacy?.kind === "clarify"
        ? t("chat.promptClarify")
        : legacy?.kind === "sudo"
          ? t("chat.promptSudo")
          : legacy?.kind === "secret"
            ? t("chat.promptSecret")
            : legacy?.kind || "");
  const needsInput = !isApproval;
  const questions: InteractiveFieldV1[] = canonical
    ? canonical.fields
    : legacy?.questions?.length && legacy.questions.length > 1
      ? legacy.questions.map((question) => ({
        id: question.id,
        type: "text" as const,
        label: question.title || question.header || question.question || question.id,
        description: question.description || "",
        required: question.required !== false,
        secret: false,
        options: [],
      }))
      : [];
  const confirmation = directConfirmationField(canonical);
  if (confirmation && canonical) {
    const message = canonical.message.trim();
    const description = confirmation.description.trim();
    const sameDescription = message.replace(/\s+/gu, " ") === description.replace(/\s+/gu, " ");
    return (
      <div className="chat-prompt chat-prompt--confirmation" aria-busy={submitting}>
        <div className="chat-prompt__head">
          <span className="chat-prompt__badge">{confirmation.label || heading}</span>
        </div>
        {message ? <div className="chat-prompt__q">{message}</div> : null}
        {description && !sameDescription ? <div className="chat-prompt__q">{description}</div> : null}
        <div className="chat-prompt__row chat-prompt__actions">
          {confirmation.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`chat-prompt__btn ${isCancelOption(option.label) ? "is-deny" : "is-primary"}`}
              title={option.description || undefined}
              disabled={submitting}
              onClick={() => { void respond({ action: "submit", answers: { [confirmation.id]: option.value } }); }}
            >
              {confirmationOptionLabel(option.label)}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const multiAnswerReady = questions.every((question) => question.required === false
    || (answers[question.id] ?? "").trim().length > 0);
  const submitAnswers = () => {
    const submitted: Record<string, string> = {};
    for (const question of questions) {
      const answer = answers[question.id] ?? "";
      if (question.required !== false || answer.length > 0) {
        Object.defineProperty(submitted, question.id, {
          configurable: true,
          enumerable: true,
          value: answer,
          writable: true,
        });
      }
    }
    void respond(canonical
      ? { action: "submit", answers: submitted }
      : { answers: submitted });
  };
  const legacyAnswer = legacySelection || value;
  const questionActions = <div className="chat-prompt__row chat-prompt__actions">
    <button type="button" className="chat-prompt__btn is-primary"
      disabled={submitting || (questions.length > 0 ? !multiAnswerReady : !legacyAnswer.trim())}
      onClick={() => { if (questions.length > 0) submitAnswers(); else void respond({ value: legacyAnswer }); }}>
      {t("chat.promptSubmit")}
    </button>
    {canonical ? <button type="button" className="chat-prompt__btn is-deny" disabled={submitting}
      onClick={() => { void respond({ action: "cancel", answers: {} }); }}>{t("common.cancel")}</button> : null}
  </div>;
  return (
    <section className={`chat-prompt chat-prompt--input${compactInput ? " chat-prompt--compact" : ""}`} aria-busy={submitting}>
      <div className="chat-prompt__content">
        <div className="chat-prompt__head">
          <span className="chat-prompt__badge">{heading}</span>
          {legacy?.description ? <span className="chat-prompt__desc">{legacy.description}</span> : null}
        </div>
        {legacy?.command ? <pre className="chat-prompt__cmd">{legacy.command}</pre> : null}
        {(canonical?.message || legacy?.question)
          ? <div className="chat-prompt__q">{canonical?.message || legacy?.question}</div> : null}
        {legacy?.kind === "clarify" && legacy.choices?.length ? (
          <ChatPromptChoices label={legacy.question || heading}
            options={legacy.choices.map((choice) => ({ value: choice, label: choice }))}
            selected={legacySelection ? [legacySelection] : []} disabled={submitting}
            onChoose={(choice) => { setLegacySelection(choice); setValue(""); }} />
        ) : null}
        {questions.length > 0 ? (
          <div className="chat-prompt__fields">
            {questions.map((question) => (
              <fieldset key={question.id} className="chat-prompt__field">
                <legend className="chat-prompt__field-label">{question.label}
                  {question.required === false ? <span className="chat-prompt__optional">{t("chat.promptOptional")}</span> : null}
                </legend>
                {question.description ? <span className="chat-prompt__desc">{question.description}</span> : null}
                {question.type === "choice" ? (
                  <ChatPromptChoices label={question.label} options={question.options}
                    selected={answers[question.id] === undefined ? [] : [answers[question.id]]} disabled={submitting}
                    onChoose={(choice) => setAnswers((previous) => ({ ...previous, [question.id]: choice }))} />
                ) : (
                  <PromptAnswerInput secret={question.secret} label={question.label} value={answers[question.id] ?? ""}
                    disabled={submitting} placeholder={t("chat.promptPlaceholder")}
                    onChange={(nextValue) => setAnswers((previous) => ({ ...previous, [question.id]: nextValue }))} />
                )}
              </fieldset>
            ))}
          </div>
        ) : needsInput ? (
          <PromptAnswerInput secret={legacy?.kind === "sudo" || legacy?.kind === "secret"}
            label={legacy?.choices?.length ? t("models.other") : legacy?.question || heading}
            value={value} disabled={submitting}
            placeholder={legacy?.choices?.length ? t("chat.promptOtherPlaceholder") : t("chat.promptPlaceholder")}
            onChange={(nextValue) => { setValue(nextValue); setLegacySelection(""); }}
            onSubmit={legacyAnswer.trim() ? () => { void respond({ value: legacyAnswer }); } : undefined} />
        ) : null}
      </div>
      {questionActions}
    </section>
  );
}
