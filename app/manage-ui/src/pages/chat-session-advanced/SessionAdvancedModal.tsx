import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Modal, { DetailRow, ModalSection } from "../../components/Modal";
import {
  describeSession,
  listEnvironments,
  listSessionBranches,
} from "../../api/client";
import type {
  AdvancedSessionMethodMap,
  EnvironmentInventory,
  SessionAdvancedDescription,
  SessionBranchesResult,
} from "../../types";
import { EMPTY_ADVANCED_SESSION_METHODS } from "./sessionAdvancedModel";
import styles from "./SessionAdvancedModal.module.css";

type LoadState<T> =
  | { status: "idle" | "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: string };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function dateTime(value: number | string | undefined, locale: string): string {
  if (value === undefined) return "—";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString(locale) : String(value);
}

function yesNo(value: boolean | undefined, yes: string, no: string): string {
  return value === undefined ? "—" : value ? yes : no;
}

export default function SessionAdvancedModal({
  open,
  backendId,
  agentId,
  sessionKey,
  initialDescription,
  onClose,
}: {
  open: boolean;
  backendId: string;
  agentId: string;
  sessionKey: string;
  initialDescription: SessionAdvancedDescription | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [reload, setReload] = useState(0);
  const [methods, setMethods] = useState<AdvancedSessionMethodMap>(
    initialDescription?.methods ?? EMPTY_ADVANCED_SESSION_METHODS,
  );
  const [description, setDescription] = useState<LoadState<SessionAdvancedDescription>>(
    initialDescription ? { status: "ready", value: initialDescription } : { status: "idle" },
  );
  const [environments, setEnvironments] = useState<LoadState<EnvironmentInventory>>({ status: "idle" });
  const [branches, setBranches] = useState<LoadState<SessionBranchesResult>>({ status: "idle" });
  const requestEpochRef = useRef(0);

  useEffect(() => {
    if (!open || !backendId || !agentId || !sessionKey) return;
    const epoch = ++requestEpochRef.current;
    const controller = new AbortController();
    const isCurrent = () => requestEpochRef.current === epoch && !controller.signal.aborted;

    const load = async () => {
      let nextDescription = initialDescription;
      let nextMethods = initialDescription?.methods ?? EMPTY_ADVANCED_SESSION_METHODS;
      if (!initialDescription || nextMethods["sessions.describe"]) {
        setDescription(initialDescription
          ? { status: "ready", value: initialDescription }
          : { status: "loading" });
        try {
          nextDescription = await describeSession(backendId, agentId, sessionKey, controller.signal);
          if (!isCurrent()) return;
          nextMethods = nextDescription.methods;
          setMethods(nextMethods);
          setDescription({ status: "ready", value: nextDescription });
        } catch (error) {
          if (!isCurrent()) return;
          setDescription({ status: "error", error: errorText(error) });
        }
      } else {
        setMethods(nextMethods);
        setDescription({ status: "ready", value: initialDescription });
      }

      if (!isCurrent()) return;
      if (nextMethods["environments.list"]) {
        setEnvironments({ status: "loading" });
        void listEnvironments(backendId, controller.signal)
          .then((value) => {
            if (isCurrent()) setEnvironments({ status: "ready", value });
          })
          .catch((error) => {
            if (isCurrent()) setEnvironments({ status: "error", error: errorText(error) });
          });
      } else {
        setEnvironments({ status: "idle" });
      }
      if (nextMethods["sessions.branches.list"]) {
        setBranches({ status: "loading" });
        void listSessionBranches(backendId, agentId, sessionKey, controller.signal)
          .then((value) => {
            if (isCurrent()) setBranches({ status: "ready", value });
          })
          .catch((error) => {
            if (isCurrent()) setBranches({ status: "error", error: errorText(error) });
          });
      } else {
        setBranches({ status: "idle" });
      }
    };

    void load();
    return () => {
      controller.abort();
      requestEpochRef.current += 1;
    };
  }, [agentId, backendId, initialDescription, open, reload, sessionKey]);

  const session = description.status === "ready" ? description.value.session : null;
  const placement = session?.placement;
  const environmentItems = environments.status === "ready"
    ? [...environments.value.environments]
      .sort((left, right) => Number(right.id === placement?.environmentId) - Number(left.id === placement?.environmentId))
      .slice(0, 50)
    : [];
  const hasError = description.status === "error"
    || environments.status === "error"
    || branches.status === "error";
  const loading = description.status === "loading"
    || environments.status === "loading"
    || branches.status === "loading";

  return (
    <Modal
      open={open}
      title={t("chat.advanced.title")}
      subtitle={sessionKey}
      onClose={onClose}
      width={760}
      footer={
        <button type="button" className="ui-cbtn" onClick={() => setReload((value) => value + 1)} disabled={loading}>
          {t("chat.advanced.refresh")}
        </button>
      }
    >
      {loading ? <div className={styles.note}>{t("chat.advanced.loading")}</div> : null}
      {hasError ? (
        <div className={styles.error}>
          {t("chat.advanced.loadFailed")}
          {description.status === "error" ? <span>{description.error}</span> : null}
          {environments.status === "error" ? <span>{environments.error}</span> : null}
          {branches.status === "error" ? <span>{branches.error}</span> : null}
        </div>
      ) : null}

      {methods["sessions.describe"] ? (
        <ModalSection title={t("chat.advanced.sessionSection")}>
          {session ? (
            <>
              <DetailRow label={t("chat.advanced.name")}>{session.displayName || session.derivedTitle || session.label || "—"}</DetailRow>
              <DetailRow label={t("chat.advanced.state")}>{session.status || "—"}</DetailRow>
              <DetailRow label={t("chat.advanced.kind")}>{session.kind || "—"}</DetailRow>
              <DetailRow label={t("chat.advanced.model")}>{[session.modelProvider, session.model].filter(Boolean).join(" · ") || "—"}</DetailRow>
              <DetailRow label={t("chat.advanced.archived")}>
                {yesNo(session.archived, t("chat.advanced.yes"), t("chat.advanced.no"))}
              </DetailRow>
              <DetailRow label={t("chat.advanced.createdAt")}>{dateTime(session.createdAt, i18n.language)}</DetailRow>
              <DetailRow label={t("chat.advanced.updatedAt")}>{dateTime(session.updatedAt, i18n.language)}</DetailRow>
              {session.parentSessionKey ? <DetailRow label={t("chat.advanced.parent")}>{session.parentSessionKey}</DetailRow> : null}
              {session.forkSource ? (
                <DetailRow label={t("chat.advanced.forkSource")}>
                  {session.forkSource.sessionKey} · {session.forkSource.entryId}
                </DetailRow>
              ) : null}
              {session.lastMessagePreview ? (
                <div className={styles.preview}>{session.lastMessagePreview}</div>
              ) : null}
            </>
          ) : description.status === "ready" ? (
            <div className={styles.note}>{t("chat.advanced.sessionUnavailable")}</div>
          ) : null}
        </ModalSection>
      ) : null}

      {placement ? (
        <ModalSection title={t("chat.advanced.placementSection")}>
          <DetailRow label={t("chat.advanced.state")}>{placement.state || "—"}</DetailRow>
          <DetailRow label={t("chat.advanced.environment")}>{placement.environmentId || "—"}</DetailRow>
          <DetailRow label={t("chat.advanced.provider")}>{placement.providerId || "—"}</DetailRow>
          <DetailRow label={t("chat.advanced.profile")}>{placement.profileId || "—"}</DetailRow>
          {placement.generation !== undefined ? <DetailRow label={t("chat.advanced.generation")}>{placement.generation}</DetailRow> : null}
          {placement.stateChangedAtMs !== undefined ? (
            <DetailRow label={t("chat.advanced.stateChangedAt")}>{dateTime(placement.stateChangedAtMs, i18n.language)}</DetailRow>
          ) : null}
          {placement.terminalReason ? <DetailRow label={t("chat.advanced.terminalReason")}>{placement.terminalReason}</DetailRow> : null}
        </ModalSection>
      ) : null}

      {methods["environments.list"] ? (
        <ModalSection title={t("chat.advanced.environmentSection")}>
          {environmentItems.length ? (
            <div className={styles.environments}>
              {environmentItems.map((environment) => {
                const isPlaced = environment.id === placement?.environmentId;
                return (
                  <div className={isPlaced ? `${styles.card} ${styles.placed}` : styles.card} key={environment.id}>
                    <div className={styles.cardHead}>
                      <strong>{environment.label || environment.id}</strong>
                      <span className={styles.badge}>
                        {isPlaced ? `${t("chat.advanced.currentPlacement")} · ` : ""}{environment.status}
                      </span>
                    </div>
                    <div className={styles.cardMeta}>
                      {[environment.type, environment.platform, environment.trust].filter(Boolean).join(" · ")}
                    </div>
                    {environment.workerSlots ? (
                      <div className={styles.cardMeta}>
                        {t("chat.advanced.workerSlots", {
                          available: environment.workerSlots.available,
                          total: environment.workerSlots.total,
                        })}
                      </div>
                    ) : null}
                    {environment.worker ? (
                      <div className={styles.cardMeta}>
                        {environment.worker.providerId} · {environment.worker.state}
                        {environment.worker.attachedSessionCount !== undefined
                          ? ` · ${t("chat.advanced.attachedSessions", { count: environment.worker.attachedSessionCount })}`
                          : ""}
                      </div>
                    ) : null}
                    {environment.issues?.map((issue) => (
                      <div className={styles.issue} key={`${issue.code}:${issue.action}`}>{issue.code} · {issue.action}</div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : environments.status === "ready" ? (
            <div className={styles.note}>{t("chat.advanced.noEnvironments")}</div>
          ) : null}
          {environments.status === "ready" && environments.value.profiles.length ? (
            <div className={styles.profiles}>
              {environments.value.profiles.map((profile) => (
                <span className={styles.profile} key={profile.id}>
                  {profile.id} · {profile.providerId}
                  {profile.executionMode ? ` · ${profile.executionMode}` : ""}
                </span>
              ))}
            </div>
          ) : null}
        </ModalSection>
      ) : null}

      {methods["sessions.branches.list"] ? (
        <ModalSection title={t("chat.advanced.branchesSection")}>
          {branches.status === "ready" && branches.value.branches.length ? (
            <div className={styles.branches}>
              {branches.value.branches.map((branch) => (
                <div className={branch.active ? `${styles.branch} ${styles.active}` : styles.branch} key={branch.leafEntryId}>
                  <div className={styles.cardHead}>
                    <strong>{branch.headline || t("chat.advanced.untitledBranch")}</strong>
                    {branch.active ? <span className={styles.badge}>{t("chat.advanced.activeBranch")}</span> : null}
                  </div>
                  <div className={styles.cardMeta}>
                    {t("chat.advanced.messageCount", { count: branch.messageCount })}
                    {branch.updatedAt ? ` · ${dateTime(branch.updatedAt, i18n.language)}` : ""}
                  </div>
                </div>
              ))}
            </div>
          ) : branches.status === "ready" ? (
            <div className={styles.note}>{t("chat.advanced.noBranches")}</div>
          ) : null}
        </ModalSection>
      ) : null}
    </Modal>
  );
}
