import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { APPLE_DEVICE_CHANGE_EVENT, appleDeviceErrorKey, connectAppleDevice, getAppleDeviceStatus, openAppleDeviceSettings, saveAppleDevicePolicy, type AppleDeviceConnection, type AppleDeviceReadPolicy, type AppleDeviceWritePolicy, type AppleDeviceResource, type AppleDeviceStatus } from "../api/appleDevices";
import { listMcpSubjects, type McpSubject } from "../api/mcpConnectors";
import s from "./AppleDeviceConnectors.module.css";
import c from "../pages/ConnectorsPage.module.css";
import Modal from "./Modal";
import ConnectorTools from "./ConnectorTools";
import { useConfirm } from "./ui";
import { usePendingConnectors } from "../lib/usePendingConnectors";
import calendarIcon from "../assets/apple-app-icons/calendar.png";
import remindersIcon from "../assets/apple-app-icons/reminders.png";

const resources: AppleDeviceResource[] = ["calendar", "reminders"];
const unconnected = (id: AppleDeviceResource): AppleDeviceConnection => ({ id, authorization: "unavailable", enabled: false, readPolicy: "ask", writePolicy: "ask", disabledProfileIds: [] });

function DeviceIcon({ resource }: { resource: AppleDeviceResource }) {
  return <img className={s.icon} data-resource={resource} src={resource === "calendar" ? calendarIcon : remindersIcon} width={40} height={40} alt="" aria-hidden="true" decoding="async" />;
}

export function useAppleDeviceConnectors(refreshKey = 0) {
  const pending = usePendingConnectors();
  const [storageError, setStorageError] = useState(false);
  const [selected, setSelected] = useState<AppleDeviceResource | null>(null);
  const [status, setStatus] = useState<AppleDeviceStatus | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<AppleDeviceResource | null>(null), [actionError, setActionError] = useState("");
  const [subjects, setSubjects] = useState<McpSubject[]>([]), [subjectsError, setSubjectsError] = useState(false);
  const alive = useRef(true), busyRef = useRef(false), generation = useRef(0), subjectGeneration = useRef(0);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (busyRef.current || document.visibilityState === "hidden") return;
    const current = ++generation.current;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true);
    try {
      const value = await getAppleDeviceStatus(controller.signal);
      if (alive.current && generation.current === current) { setStatus(value); setLoadError(false); }
    } catch {
      if (alive.current && generation.current === current && !controller.signal.aborted) setLoadError(true);
    } finally {
      if (alive.current && generation.current === current) setLoading(false);
    }
  }, []);
  const refreshSubjects = useCallback(async () => {
    const current = ++subjectGeneration.current;
    try {
      const value = await listMcpSubjects();
      if (alive.current && subjectGeneration.current === current) { setSubjects(value.items); setSubjectsError(value.unavailableBackends.length > 0); }
    } catch {
      if (alive.current && subjectGeneration.current === current) setSubjectsError(true);
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const changed = () => { if (document.visibilityState !== "hidden") { void refresh(); void refreshSubjects(); } };
    window.addEventListener("focus", changed); window.addEventListener(APPLE_DEVICE_CHANGE_EVENT, changed); document.addEventListener("visibilitychange", changed);
    void refreshSubjects();
    return () => { alive.current = false; ++generation.current; ++subjectGeneration.current; request.current?.abort(); window.removeEventListener("focus", changed); window.removeEventListener(APPLE_DEVICE_CHANGE_EVENT, changed); document.removeEventListener("visibilitychange", changed); };
  }, [refresh, refreshSubjects]);
  useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const mutate = async (resource: AppleDeviceResource, operation: () => Promise<AppleDeviceStatus | { opened: true }>) => {
    if (busyRef.current) return false;
    busyRef.current = true; ++generation.current; request.current?.abort(); setLoading(false); setBusy(resource); setActionError("");
    let failed = false;
    try {
      const value = await operation();
      if (alive.current && "resources" in value) { setStatus(value); setLoadError(false); }
    } catch (error) {
      failed = true;
      if (alive.current) setActionError(appleDeviceErrorKey(error));
    } finally {
      busyRef.current = false;
      if (alive.current) { setBusy(null); if (failed) void refresh(); }
    }
    return !failed;
  };
  const policy = (resource: AppleDeviceConnection, changes: Partial<Pick<AppleDeviceConnection, "enabled" | "readPolicy" | "writePolicy" | "disabledProfileIds">>) => {
    if (!status || loadError) return;
    return mutate(resource.id, () => saveAppleDevicePolicy({ resource: resource.id, enabled: resource.enabled, readPolicy: resource.readPolicy, writePolicy: resource.writePolicy, disabledProfileIds: resource.disabledProfileIds, ...changes, expectedRevision: status.revision }));
  };
  const added = (resource: AppleDeviceConnection) => resource.enabled || pending.ids.includes(`device:${resource.id}`);
  const count = resources.filter(id => added(status?.resources.find(item => item.id === id) || unconnected(id))).length;
  return { status, loading, loadError, busy, actionError, subjects, subjectsError, refresh, refreshSubjects, mutate, policy, selected, setSelected, pending, added, storageError, setStorageError,
    count, hasRecommendations: count < resources.length };
}

type Model = ReturnType<typeof useAppleDeviceConnectors>;
const operations = {
  calendar: [["list", "listCalendars"], ["events", "readEvents"], ["get", "readEvent"], ["create", "createEvent"], ["update", "changeEvent"], ["delete", "deleteEvent"]],
  reminders: [["lists", "listReminderLists"], ["search", "readReminders"], ["get", "readReminder"], ["create", "createReminder"], ["update", "changeReminder"], ["delete", "deleteReminder"]],
};

export function AppleDeviceRows({ model, installed }: { model: Model; installed: boolean }) {
  const { t } = useTranslation(), confirm = useConfirm();
  const tr = (key: string, values?: Record<string, unknown>) => t(`appleDevices.${key}`, values);
  const { status, loading, loadError, busy, actionError, subjects, subjectsError, refresh, refreshSubjects, mutate, policy, selected, setSelected, pending, added, storageError, setStorageError } = model;
  const available = !!status?.available && !loadError;
  const stage = (id: AppleDeviceResource) => { try { pending.add(`device:${id}`); setStorageError(false); } catch { setStorageError(true); } setSelected(id); };
  const resource = selected ? status?.resources.find(item => item.id === selected) || unconnected(selected) : null;
  const name = resource ? tr(`resources.${resource.id}.name`) : "";
  const connected = available && resource?.enabled && resource.authorization === "fullAccess";
  const authorization = available ? resource?.authorization || "unavailable" : "unavailable";
  const currentState = !status && loading ? "checking" : connected ? "connected" : authorization === "fullAccess" ? "disconnected" : authorization;
  const disabled = !!busy || loading || !available, policyDisabled = !!busy || loadError || !status;
  return <>{resources.map(id => {
    const entry = status?.resources.find(item => item.id === id) || unconnected(id);
    if (added(entry) !== installed) return null;
    const entryName = tr(`resources.${id}.name`), ready = available && entry.enabled && entry.authorization === "fullAccess";
    return installed ? <li className={c.installedItem} key={id} data-device-installed={id}><button type="button" className={c.installedOpen} aria-label={`${t("mcpConnectors.manage")} ${entryName}`} onClick={() => setSelected(id)}><DeviceIcon resource={id} /><span className={c.installedLabel}><strong>{entryName}</strong>{!ready && <small className={c.connectionHint}>{t("mcpConnectors.flow.notConnected")}</small>}</span></button></li>
      : <div className={c.service} key={id} data-device-recommendation={id}><button type="button" className={c.serviceOpen} onClick={() => setSelected(id)}><DeviceIcon resource={id} /><span className={c.serviceText}><strong>{entryName}</strong><small>{tr(`resources.${id}.description`)}</small></span></button><button type="button" className={c.button} onClick={() => stage(id)}>{t("mcpConnectors.add")}</button></div>;
  })}
  {installed && resource && <Modal open title={<span className={c.dialogIdentity}><DeviceIcon resource={resource.id} />{name}</span>} onClose={() => setSelected(null)} dismissible={!busy} width={680}>
    <article className={c.detail} data-resource={resource.id} aria-label={name}>
      <span className={c.status} data-state={currentState} role="status">{added(resource) ? tr(`states.${currentState}`) : t("mcpConnectors.flow.notAdded")}</span>
      <section className={c.overview}><h3>{t("mcpConnectors.flow.capabilities")}</h3><p>{tr(`resources.${resource.id}.description`)}</p></section>
      <ConnectorTools items={operations[resource.id].map(([operation, label]) => ({ name: `apple_${resource.id}_${operation}`, description: tr(`approvalActions.${label}`) }))} />
      {!added(resource) ? <section className={c.connectionPanel}><p className={c.muted}>{t("mcpConnectors.flow.addHint")}</p><button type="button" className={c.primary} onClick={() => stage(resource.id)}>{t("mcpConnectors.add")}</button></section> : <>
        <section className={c.connectionPanel}><h3>{t(connected ? "mcpConnectors.flow.connected" : "mcpConnectors.flow.setup")}</h3><p className={c.muted}>{t("mcpConnectors.flow.deviceSetup")}</p>
          {(loadError || status && !status.available) && <p role="status" className={c.notice}>{tr("unavailable")} <button type="button" className={c.textButton} disabled={!!busy || loading} onClick={() => void refresh()}>{tr("retry")}</button></p>}
          {authorization !== "fullAccess" && authorization !== "notDetermined" && authorization !== "unavailable" && <p className={c.notice}>{tr(`hints.${authorization}`)}</p>}
          {authorization === "denied" ? <button type="button" className={c.primary} disabled={disabled} onClick={() => void mutate(resource.id, () => openAppleDeviceSettings(resource.id))}>{tr(busy === resource.id ? "working" : "settings")}</button>
            : !connected && <button type="button" className={c.primary} disabled={disabled || authorization === "restricted"} onClick={() => status && void mutate(resource.id, () => connectAppleDevice(resource.id, status.revision))}>{tr(busy === resource.id ? "working" : "connect")}</button>}
        </section>
        <section className={c.management}><h3>{tr("agents")}</h3><div className={s.policies}>
          <label className={s.policy}><span>{tr("reading")}</span><select aria-label={tr("readFor", { name })} value={resource.readPolicy} disabled={policyDisabled || !resource.enabled} onChange={event => void policy(resource, { readPolicy: event.target.value as AppleDeviceReadPolicy })}>
            <option value="allow">{tr("readPolicies.allow")}</option><option value="ask">{tr("readPolicies.ask")}</option><option value="deny">{tr("readPolicies.deny")}</option>
          </select></label>
          <label className={s.policy}><span>{tr("writing")}</span><select aria-label={tr("writeFor", { name })} value={resource.writePolicy} disabled={policyDisabled || !resource.enabled} onChange={event => void policy(resource, { writePolicy: event.target.value as AppleDeviceWritePolicy })}>
            <option value="allow">{tr("writePolicies.allow")}</option><option value="ask">{tr("writePolicies.ask")}</option><option value="deny">{tr("writePolicies.deny")}</option>
          </select></label>
        </div><p className={c.muted}>{tr(`writeHints.${resource.writePolicy}`)}</p>
        {resource.enabled && <><p className={c.muted}>{tr("agentsHint")}</p>
          {subjectsError && <p className={c.notice} role="status">{tr("agentsUnavailable")} <button type="button" className={c.textButton} disabled={!!busy} onClick={() => void refreshSubjects()}>{tr("retry")}</button></p>}
          {!subjects.length && !subjectsError && <p className={c.muted}>{tr("agentsEmpty")}</p>}
          <div className={c.choices}>{subjects.map(subject => <label className={c.choice} key={subject.profileId}><input type="checkbox" aria-label={tr("agentFor", { name, agent: subject.label })} checked={!resource.disabledProfileIds.includes(subject.profileId)} disabled={policyDisabled || !subject.enabled} onChange={event => {
            const next = new Set(resource.disabledProfileIds); if (event.target.checked) next.delete(subject.profileId); else next.add(subject.profileId); void policy(resource, { disabledProfileIds: [...next] });
          }} /><span>{subject.label}{!subject.enabled && <small>{tr("agentDisabled")}</small>}</span></label>)}</div>
        </>}
        </section>
        <div className={c.dialogFooter}><button type="button" className={c.danger} disabled={!!busy} onClick={() => void (async () => {
          if (!await confirm({ title: t("mcpConnectors.flow.remove"), message: tr("disconnectFor", { name }), confirmLabel: t("mcpConnectors.flow.remove") })) return;
          if (resource.enabled && !await policy(resource, { enabled: false })) return;
          try { pending.remove(`device:${resource.id}`); setStorageError(false); setSelected(null); } catch { setStorageError(true); }
        })()}>{t("mcpConnectors.flow.remove")}</button></div>
      </>}
      {actionError && <p className={c.error} role="alert">{tr(`errors.${actionError}`)}</p>}
      {storageError && <p className={c.error} role="alert">{t("mcpConnectors.flow.storageError")}</p>}
      <p className={c.muted}>{tr("privacy")}</p>
    </article>
  </Modal>}
  </>;
}

export default function AppleDeviceConnectors({ refreshKey = 0 }: { refreshKey?: number }) {
  const model = useAppleDeviceConnectors(refreshKey);
  return <section className={s.section}><ul className={c.installedList}><AppleDeviceRows model={model} installed /></ul><div className={c.catalog}><AppleDeviceRows model={model} installed={false} /></div></section>;
}
