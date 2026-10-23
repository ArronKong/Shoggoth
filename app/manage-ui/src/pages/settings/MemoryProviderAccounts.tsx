import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getMemoryProviderOwners, applyMemoryProviderOwner, recoverMemoryProviderOwner } from "../../api/client";
import type { MemoryProviderOwnerApi, MemoryProviderOwnerContext, MemoryProviderOwnerMetadata, MemoryProviderOwnerMutation } from "../../types";
import { Field, Option, Select, TextInput } from "../../components/Field";
import { useNavigationGuard } from "../../lib/navigation-guard";

let pendingAccountWrite: Promise<unknown> = Promise.resolve();
const providerApis: Record<string, MemoryProviderOwnerApi> = { openai: "openai-completions", voyage: "openai-completions",
  mistral: "openai-completions", ollama: "openai-completions", gemini: "google-generative-ai" };
const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  && !["__proto__", "prototype", "constructor", "none", "auto", "local", "llama-cpp", "shoggoth-e5"].includes(value);
const validEndpoint = (value: string) => {
  try { const url = new URL(value); return value === value.trim() && !/[\s\u0000-\u001f\u007f]/u.test(value)
    && ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.search && !url.hash; }
  catch { return false; }
};
const failureCode = (value: unknown) => {
  const code = (value as { code?: string })?.code;
  return code && /^MEMORY_OWNER_[A-Z_]+$/u.test(code) ? code : "unavailable";
};
export type MemoryAccountContext = { profileId: string; context: MemoryProviderOwnerContext };
export default function MemoryProviderAccounts({ profileId, disabled, onContext, onStatus }: {
  profileId: string; disabled: boolean;
  onContext: (value: MemoryAccountContext | null) => void;
  onStatus: (value: { dirty: boolean; busy: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<MemoryProviderOwnerContext | null>(null);
  const [editing, setEditing] = useState<MemoryProviderOwnerMetadata | null>(null);
  const [provider, setProvider] = useState("openai"), [api, setApi] = useState<MemoryProviderOwnerApi>("openai-completions");
  const [label, setLabel] = useState(""), [baseUrl, setBaseUrl] = useState(""), [secret, setSecret] = useState("");
  const [secretAction, setSecretAction] = useState<"set" | "preserve" | "clear">("set");
  const [recoverySecret, setRecoverySecret] = useState("");
  const [busy, setBusy] = useState(false), [needsReload, setNeedsReload] = useState(false), [error, setError] = useState("");
  const generation = useRef(0), inFlight = useRef(false);
  const dirty = api !== "openai-completions" || !!editing || !!label || !!baseUrl || !!secret || !!recoverySecret || provider !== "openai" || secretAction !== "set";
  const resetEditor = useCallback(() => {
    setEditing(null); setProvider("openai"); setApi("openai-completions"); setLabel(""); setBaseUrl(""); setSecret(""); setSecretAction("set"); setRecoverySecret("");
  }, []);
  useNavigationGuard({ dirty, busy, onDiscard: resetEditor });
  useEffect(() => { onStatus({ dirty, busy }); }, [dirty, busy, onStatus]);
  useEffect(() => () => { generation.current++; onStatus({ dirty: false, busy: false }); }, [onStatus]);
  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    const current = ++generation.current; onContext(null);
    try {
      await pendingAccountWrite.catch(() => {});
      if (generation.current !== current) return;
      const next = await getMemoryProviderOwners(profileId || undefined);
      if (generation.current !== current) return;
      setSnapshot(next); onContext({ profileId, context: next }); setNeedsReload(false);
    } catch (failure) { if (generation.current === current) { setSnapshot(null); setError(failureCode(failure)); } }
    finally { if (generation.current === current) { inFlight.current = false; setBusy(false); } }
  }, [profileId, onContext]);
  useEffect(() => {
    resetEditor(); setSnapshot(null); setNeedsReload(false); void load();
    return () => { generation.current++; inFlight.current = false; };
  }, [load, resetEditor]);
  const blocked = disabled || busy || needsReload || !snapshot;
  const valid = validId(provider) && !!label.trim() && label.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(label)
    && validEndpoint(baseUrl) && (secretAction !== "preserve" || new URL(baseUrl).href.replace(/\/$/u, "") === editing?.baseUrl) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(label)
    && (secretAction !== "set" || !!secret && !secret.includes("\0")
      && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(secret) && new TextEncoder().encode(secret).length <= 16384);
  const execute = async (action: () => Promise<unknown>) => {
    if (inFlight.current || disabled || needsReload || !snapshot) return;
    inFlight.current = true; setBusy(true); setError(""); const current = generation.current;
    const writing = pendingAccountWrite.then(action); pendingAccountWrite = writing.catch(() => {});
    try {
      await writing;
      if (generation.current !== current) return;
      setSecret(""); setRecoverySecret("");
      const next = await getMemoryProviderOwners(profileId || undefined);
      if (generation.current !== current) return;
      resetEditor(); setSnapshot(next); onContext({ profileId, context: next });
    } catch (failure) {
      if (generation.current !== current) return;
      setError(failureCode(failure)); setNeedsReload(true); onContext(null);
    } finally {
      if (generation.current === current) { setSecret(""); setRecoverySecret(""); inFlight.current = false; setBusy(false); }
    }
  };
  const apply = () => {
    if (!valid || blocked || !snapshot) return;
    const credentials = secretAction === "set" ? { secretAction, secret } as const : { secretAction };
    const request: MemoryProviderOwnerMutation = { operationId: crypto.randomUUID(), expectedCatalogRevision: snapshot.catalogRevision,
      ...(editing ? { action: "update", ownerRef: editing.ownerRef, expectedOwnerRevision: editing.revision }
        : { action: "create", scope: profileId ? { kind: "profile", profileId } : { kind: "global" }, providerId: provider, api: providerApis[provider] || api }),
      label, baseUrl, ...credentials };
    void execute(() => applyMemoryProviderOwner(request));
  };
  const edit = (row: MemoryProviderOwnerMetadata) => {
    if (blocked) return;
    setEditing(row); setProvider(row.providerId); setApi(row.api); setLabel(row.label); setBaseUrl(row.baseUrl); setSecret(""); setSecretAction("preserve"); setError("");
  };
  return <details className="settings-memory-extra">
    <summary>{t("memoryAccounts.title")}</summary>
    <p className="ui-hint">{t("memoryAccounts.description")}</p>
    {error && <p className="field-error" role="alert">{t(`memoryAccounts.errors.${error}`, { defaultValue: t("memoryAccounts.errors.unavailable") })}</p>}
    {(needsReload || !snapshot) && <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={busy || disabled}
      onClick={() => { resetEditor(); void load(); }}>{t("memoryAccounts.discardReload")}</button>}
    {snapshot && <>
      <div className="settings-memory-accounts">{snapshot.owners.map(row => <div key={row.ownerRef} className="settings-memory-path">
        <div><strong>{row.label}</strong><p className="ui-hint">{row.providerId} · {row.scope.kind === "global" ? t("memoryAccounts.global") : t("memoryAccounts.profile")}
          {" · "}{t(row.status === "revoked" ? "memoryAccounts.revoked" : row.hasCredential ? "memoryAccounts.keyStored" : "memoryAccounts.noKey")}</p>
          <p className="ui-hint">{row.baseUrl}</p></div>
        {row.status === "active" && <><button type="button" className="ui-cbtn ui-cbtn--sm" disabled={blocked || dirty} onClick={() => edit(row)}>{t("common.edit")}</button>
          <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={blocked || dirty} onClick={() => void execute(() => applyMemoryProviderOwner({
            action: "revoke", operationId: crypto.randomUUID(), expectedCatalogRevision: snapshot.catalogRevision, ownerRef: row.ownerRef, expectedOwnerRevision: row.revision }))}>{t("memoryAccounts.revoke")}</button></>}
      </div>)}</div>
      <div className="settings-memory-grid" onKeyDown={event => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
        <Field label={t("memoryAccounts.provider")}><TextInput disabled={blocked || !!editing} maxLength={128} value={provider} onChange={event => setProvider(event.target.value)} /></Field>
        <Field label={t("memoryAccounts.label")}><TextInput disabled={blocked} maxLength={128} value={label} onChange={event => setLabel(event.target.value)} /></Field>
        {!Object.hasOwn(providerApis, provider) && <Field label={t("memoryAccounts.api")}><Select disabled={blocked || !!editing} title={t("memoryAccounts.api")} value={api} onChange={value => setApi(value as MemoryProviderOwnerApi)}>
          <Option value="openai-completions">OpenAI Completions</Option><Option value="openai-responses">OpenAI Responses</Option>
        </Select></Field>}
        <Field label={t("memoryAccounts.endpoint")} hint={t("memoryAccounts.endpointHint")}><TextInput disabled={blocked} maxLength={4096} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></Field>
        <Field label={t("memoryAccounts.credential")}><Select disabled={blocked} title={t("memoryAccounts.credential")} value={secretAction} onChange={value => setSecretAction(value as typeof secretAction)}>
          {editing && <Option value="preserve">{t("memoryAccounts.preserve")}</Option>}
          <Option value="set">{t("memoryAccounts.setKey")}</Option><Option value="clear">{t("memoryAccounts.clearKey")}</Option>
        </Select></Field>
        {secretAction === "set" && <Field label={t("memoryAccounts.apiKey")}><TextInput type="password" autoComplete="new-password" spellCheck={false} disabled={blocked}
          value={secret} maxLength={16384} onChange={event => setSecret(event.target.value)} /></Field>}
      </div>
      <div className="settings-memory-actions"><button type="button" className="ui-cbtn ui-cbtn--sm" disabled={blocked || !valid} onClick={apply}>{t(editing ? "memoryAccounts.update" : "memoryAccounts.create")}</button>
        {dirty && <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={busy} onClick={resetEditor}>{t("common.cancel")}</button>}</div>
      {!!snapshot.pendingOperations.length && <div className="settings-memory-extra"><strong>{t("memoryAccounts.pending")}</strong>
        <p className="ui-hint">{t("memoryAccounts.pendingHint")}</p>
        <Field label={t("memoryAccounts.recoveryKey")}><TextInput type="password" autoComplete="new-password" spellCheck={false} disabled={blocked} value={recoverySecret} onChange={event => setRecoverySecret(event.target.value)} /></Field>
        {snapshot.pendingOperations.map(operation => <div className="settings-memory-actions" key={operation.operationId}>
          <span>{operation.operationId} · {operation.phase}</span>
          <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={blocked} onClick={() => void execute(() => recoverMemoryProviderOwner({ operationId: operation.operationId, mode: "resume", ...(recoverySecret ? { secret: recoverySecret } : {}) }))}>{t("memoryAccounts.resume")}</button>
          <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={blocked || ["published", "retired"].includes(operation.phase)} onClick={() => void execute(() => recoverMemoryProviderOwner({ operationId: operation.operationId, mode: "cancel", ...(recoverySecret ? { secret: recoverySecret } : {}) }))}>{t("memoryAccounts.cancelPending")}</button>
        </div>)}</div>}
    </>}
  </details>;
}
