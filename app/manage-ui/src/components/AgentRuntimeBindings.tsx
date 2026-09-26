import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { addAgentRuntimeBinding, getAgentRuntimeBindings, getRuntimeAccounts, removeAgentRuntimeBinding,
  setAgentDefaultBinding, updateAgentRuntimeBinding } from "../api/client";
import type { AgentRuntimeBinding, AgentRuntimeBindingMutation } from "../types";
import { usePageCache } from "../lib/usePageCache";
import { isVisibleRuntime } from "../lib/runtimeVisibility";
import { Field, Option, Select, Switch, TextInput } from "./Field";
import { useConfirm, useToast } from "./ui";
import styles from "./AgentRuntimeBindings.module.css";
import AgentRuntimePolicy from "./AgentRuntimePolicy";

export default function AgentRuntimeBindings({ backend, agentId, onChanged }: {
  backend: string; agentId: string; onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const confirm = useConfirm();
  const cache = usePageCache(`agent:bindings:${backend}:${agentId}`, () => getAgentRuntimeBindings(backend, agentId));
  const accounts = usePageCache("runtime-accounts:binding-picker", getRuntimeAccounts);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const mounted = useRef(true);
  const [adding, setAdding] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const addOperation = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const snapshot = cache.data;
  const visibleBindings = snapshot?.bindings.filter((binding) => isVisibleRuntime(binding.runtime)) ?? [];
  const knownAccounts = accounts.data?.accounts ?? [];
  const blocked = pending || cache.loading || !!cache.error;
  const mutate = async (action: () => Promise<AgentRuntimeBindingMutation>, after?: () => void) => {
    if (pendingRef.current) return;
    pendingRef.current = true; setPending(true);
    try {
      const result = await action();
      const { binding: _binding, ...next } = result;
      cache.replace(next);
      if (mounted.current) { after?.(); onChanged?.(); }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      await cache.refresh();
    } finally { pendingRef.current = false; if (mounted.current) setPending(false); }
  };
  const add = () => {
    const account = knownAccounts.find((entry) => entry.id === accountId);
    if (!account || !snapshot?.canAdd || blocked) return;
    const spec = { runtime: account.runtime, runtimeAccountId: account.id, label: label.trim() || null };
    const key = JSON.stringify(spec);
    if (addOperation.current?.key !== key) addOperation.current = { key, id: `binding-add-${crypto.randomUUID()}` };
    void mutate(() => addAgentRuntimeBinding(backend, agentId, spec,
      { revision: snapshot.revision, operationId: addOperation.current!.id }), () => {
      setAdding(false); setLabel(""); addOperation.current = null;
    });
  };
  const remove = async (binding: AgentRuntimeBinding) => {
    if (!snapshot || blocked || binding.id === snapshot.defaultBindingId) return;
    if (!await confirm({ title: t("agents.bindingRemove"), message: t("agents.bindingRemoveConfirm", { name: binding.label || binding.runtime }),
      confirmLabel: t("common.delete"), danger: true })) return;
    void mutate(() => removeAgentRuntimeBinding(backend, agentId, binding.id, { revision: snapshot.revision }));
  };
  return <section className={styles.card} aria-busy={pending}>
    <header className={styles.header}><div><h3>{t("agents.bindingsTitle")}</h3><p>{t("agents.bindingsHint")}</p></div>
      {snapshot?.canAdd && <button className="ui-cbtn ui-cbtn--sm" disabled={blocked || !!accounts.error || !knownAccounts.length}
        onClick={() => { setAdding(!adding); setAccountId(knownAccounts[0]?.id || ""); }}>{t("agents.bindingAdd")}</button>}
    </header>
    {cache.error && <div className={styles.error} role="alert">{cache.error} <button className="ui-cbtn ui-cbtn--sm" onClick={() => void cache.refresh()}>{t("settings.retry")}</button></div>}
    {!snapshot ? <p className="ui-hint">{t("common.loading")}</p> : <>
      {!snapshot.canAdd && <p className="ui-hint">{t("agents.bindingAddUnavailable")}</p>}
      {accounts.error && <p className={styles.error}>{t("agents.bindingAccountsUnavailable")}</p>}
      <ul className={styles.list}>{visibleBindings.map((binding) => {
        const isDefault = binding.id === snapshot.defaultBindingId;
        const account = knownAccounts.find((entry) => entry.id === binding.runtimeAccountId && entry.runtime === binding.runtime);
        const matchingAccounts = knownAccounts.filter((entry) => entry.runtime === binding.runtime);
        const availability = snapshot.availability?.find((entry) => entry.bindingId === binding.id);
        return <li key={binding.id} className={styles.item} data-binding-id={binding.id}>
          <div className={styles.identity}><strong>{binding.label || binding.runtime}</strong><span className={styles.tag}>{binding.runtime}</span>
            {isDefault && <span className={styles.tag}>{t("agents.default")}</span>}</div>
          <div className={styles.account}><span>{t("agents.bindingAccount")}</span>
            <Select value={binding.runtimeAccountId} disabled={blocked || !!accounts.error || !matchingAccounts.length}
              title={t("agents.bindingAccount")} onChange={(runtimeAccountId) => {
                if (runtimeAccountId !== binding.runtimeAccountId) void mutate(() => updateAgentRuntimeBinding(backend, agentId, binding.id,
                  { runtimeAccountId }, { revision: snapshot.revision }));
              }}>
              {!account && <Option value={binding.runtimeAccountId}>{binding.runtimeAccountId}</Option>}
              {matchingAccounts.map((entry) => <Option key={entry.id} value={entry.id}>{entry.id}</Option>)}
            </Select>
          </div>
          {!binding.enabled && <p className="ui-hint">{t("agents.bindingDisabled")}</p>}
          {availability?.available === false && <p className={styles.error}>{t(availability.reason === "runtime-disabled"
            ? "agents.bindingRuntimeDisabled" : "agents.bindingRuntimeUnavailable")}</p>}
          {accounts.data && !account && <p className={styles.error}>{t("agents.bindingAccountMissing")}</p>}
          {editing === binding.id && <div className={styles.editor}>
            <TextInput aria-label={t("agents.bindingLabel")} value={editLabel} maxLength={256} disabled={blocked} onChange={(event) => setEditLabel(event.target.value)} />
            <button className="ui-cbtn ui-cbtn--sm" disabled={blocked} onClick={() => void mutate(() => updateAgentRuntimeBinding(backend, agentId,
              binding.id, { label: editLabel.trim() || null }, { revision: snapshot.revision }), () => setEditing(null))}>{t("common.save")}</button>
            <button className="ui-cbtn ui-cbtn--sm" disabled={blocked} onClick={() => setEditing(null)}>{t("common.cancel")}</button>
          </div>}
          <div className={styles.actions}>
            <Switch checked={binding.enabled} disabled={blocked || isDefault} label={t("agents.bindingEnabled")}
              onChange={(enabled) => void mutate(() => updateAgentRuntimeBinding(backend, agentId, binding.id, { enabled }, { revision: snapshot.revision }))} />
            <button className="ui-cbtn ui-cbtn--sm" disabled={blocked} onClick={() => { setEditing(binding.id); setEditLabel(binding.label || ""); }}>{t("agents.bindingRename")}</button>
            {!isDefault && <button className="ui-cbtn ui-cbtn--sm" disabled={blocked || !binding.enabled || !account || availability?.available === false}
              onClick={() => void mutate(() => setAgentDefaultBinding(backend, agentId, binding.id, { revision: snapshot.revision }))}>{t("agents.bindingSetDefault")}</button>}
            {!isDefault && <button className="ui-cbtn ui-cbtn--sm" disabled={blocked} onClick={() => void remove(binding)}>{t("common.delete")}</button>}
          </div>
        </li>;
      })}</ul>
      {adding && snapshot.canAdd && <div className={styles.add}>
        <Field label={t("agents.bindingAccount")} hint={t("agents.bindingAccountHint")}>
          <Select value={accountId} title={t("agents.bindingAccount")} disabled={blocked} onChange={setAccountId}>
            {knownAccounts.map((account) => <Option key={account.id} value={account.id}>{account.runtime} · {account.id}</Option>)}
          </Select>
        </Field>
        <Field label={t("agents.bindingLabel")}><TextInput value={label} maxLength={256} disabled={blocked} onChange={(event) => setLabel(event.target.value)} /></Field>
        <div className={styles.actions}><button className="ui-cbtn ui-cbtn--sm" disabled={blocked || !accountId} onClick={add}>{t("agents.bindingAdd")}</button>
          <button className="ui-cbtn ui-cbtn--sm" disabled={blocked} onClick={() => setAdding(false)}>{t("common.cancel")}</button></div>
      </div>}
      <AgentRuntimePolicy backend={backend} agentId={agentId} bindings={visibleBindings} checkpointBindingIds={snapshot.checkpointBindingIds || []} />
    </>}
  </section>;
}
