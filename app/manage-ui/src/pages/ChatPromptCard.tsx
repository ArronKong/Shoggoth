import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ChatApprovalCard from "./ChatApprovalCard";
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

// Interactive card for a blocking agent prompt (Hermes gateway approval /
// clarify / sudo / secret). Approval renders choice buttons (once/session/
// always/deny); clarify renders its choices + a free-text answer; sudo/secret
// render a single input (masked for sudo — the value is relayed verbatim to
// the local gateway, never stored here). Answering removes the card.
const inputDrafts = new Map<string, Record<string, string>>();

export default function ChatPromptCard({
  entry,
  onRespond,
  draftKey,
  compactApproval = false,
}: {
  entry: ChatPromptEntry;
  draftKey?: string;
  compactApproval?: boolean;
  onRespond: (entry: ChatPromptEntry, data: ChatPromptResponse) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
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
    if (submittingRef.current || ("interrupted" in entry && entry.interrupted)) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onRespond(entry, data);
      if (draftKey) inputDrafts.delete(draftKey);
    } catch {
      // ChatPage owns the visible error toast. Keeping the card mounted here
      // lets the user retry the same still-authoritative request.
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
      <div className="chat-prompt">
        <div className="chat-prompt__head">
          <span className="chat-prompt__badge">{t("chat.promptClarify")}</span>
        </div>
        {openClawQuestion.questions.map((question) => (
          <div key={question.questionId} className="chat-prompt__field">
            <span className="chat-prompt__q">{question.header}</span>
            <span className="chat-prompt__desc">{question.question}</span>
            {pending ? (
              <>
                {question.options.length > 0 ? (
                  <span
                    className="chat-prompt__options"
                    role={question.multiSelect ? "group" : "radiogroup"}
                    aria-label={question.header}
                  >
                    {question.options.map((option) => {
                      const selected = (questionSelections[question.questionId] ?? []).includes(option.label);
                      return (
                        <span key={option.label} className="chat-prompt__field">
                          <button
                            type="button"
                            className={selected ? "chat-prompt__btn is-primary" : "chat-prompt__btn"}
                            role={question.multiSelect ? "checkbox" : "radio"}
                            aria-checked={selected}
                            title={option.description || undefined}
                            disabled={submitting}
                            onClick={() => toggleOption(question, option.label)}
                          >
                            {option.label}
                          </button>
                        </span>
                      );
                    })}
                  </span>
                ) : null}
                {question.isOther || question.options.length === 0 ? (
                  <input
                    className="chat-prompt__input"
                    type={question.isSecret ? "password" : "text"}
                    autoComplete="off"
                    aria-label={question.header}
                    value={questionFreeText[question.questionId] ?? ""}
                    disabled={submitting}
                    placeholder={question.options.length > 0 ? t("models.other") : t("chat.promptPlaceholder")}
                    onChange={(event) => updateOther(question, event.target.value)}
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
          </div>
        ))}
        {pending ? (
          <div className="chat-prompt__row">
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
      </div>
    );
  }

  const canonical = "version" in entry && entry.version === 1 ? entry : null;
  const legacy = canonical ? null : entry as LegacyChatPromptEntry;
  const isApproval = isApprovalPrompt(entry);
  if (isApproval) return <ChatApprovalCard entry={entry} submitting={submitting} compact={compactApproval}
    onChoose={(choice) => { void respond({ choice }); }} />;
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
  return (
    <div className="chat-prompt chat-prompt--input">
      <div className="chat-prompt__head">
        <span className="chat-prompt__badge">{heading}</span>
        {legacy?.description ? <span className="chat-prompt__desc">{legacy.description}</span> : null}
      </div>
      {legacy?.command ? <pre className="chat-prompt__cmd">{legacy.command}</pre> : null}
      {(canonical?.message || legacy?.question)
        ? <div className="chat-prompt__q">{canonical?.message || legacy?.question}</div> : null}
      <>
          {legacy?.kind === "clarify" && legacy.choices?.length ? (
            <div className="chat-prompt__row">
              {legacy.choices.map((c) => (
                <button key={c} type="button" className="chat-prompt__btn" disabled={submitting} onClick={() => { void respond({ value: c }); }}>
                  {c}
                </button>
              ))}
            </div>
          ) : null}
          {needsInput && questions.length > 0 ? (
            <div className="chat-prompt__fields">
              {questions.map((question) => {
                const label = question.label;
                return (
                  <label key={question.id} className="chat-prompt__field">
                    <span className="chat-prompt__q">{label}</span>
                    {question.description ? <span className="chat-prompt__desc">{question.description}</span> : null}
                    {question.type === "choice" ? (
                      <span className="chat-prompt__options">
                        {question.options.map((option) => (
                          <span key={option.value} className="chat-prompt__field">
                            <button
                              type="button"
                              className={answers[question.id] === option.value
                                ? "chat-prompt__btn is-primary" : "chat-prompt__btn"}
                              disabled={submitting}
                              aria-pressed={answers[question.id] === option.value}
                              title={option.description || undefined}
                              onClick={() => setAnswers((previous) => ({
                                ...previous, [question.id]: option.value,
                              }))}
                            >
                              {option.label}
                            </button>
                          </span>
                        ))}
                      </span>
                    ) : (
                      <input
                        className="chat-prompt__input"
                        type={question.secret ? "password" : "text"}
                        aria-label={label}
                        value={answers[question.id] ?? ""}
                        disabled={submitting}
                        placeholder={t("chat.promptPlaceholder")}
                        onChange={(event) => {
                          const nextValue = event.target.value;
                          setAnswers((previous) => ({ ...previous, [question.id]: nextValue }));
                        }}
                      />
                    )}
                  </label>
                );
              })}
              <div className="chat-prompt__row">
                <button
                  type="button"
                  className="chat-prompt__btn is-primary"
                  disabled={submitting || !multiAnswerReady}
                  onClick={submitAnswers}
                >
                  {t("chat.promptSubmit")}
                </button>
                {canonical ? (
                  <button
                    type="button"
                    className="chat-prompt__btn is-deny"
                    disabled={submitting}
                    onClick={() => { void respond({ action: "cancel", answers: {} }); }}
                  >
                    {t("common.cancel")}
                  </button>
                ) : null}
              </div>
            </div>
          ) : needsInput ? (
            <div className="chat-prompt__row">
              <input
                className="chat-prompt__input"
                type={legacy?.kind === "sudo" ? "password" : "text"}
                value={value}
                disabled={submitting}
                placeholder={t("chat.promptPlaceholder")}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && value.trim()) void respond({ value });
                }}
              />
              <button
                type="button"
                className="chat-prompt__btn is-primary"
                disabled={submitting || !value.trim()}
                onClick={() => { void respond({ value }); }}
              >
                {t("chat.promptSubmit")}
              </button>
            </div>
          ) : null}
      </>
    </div>
  );
}
