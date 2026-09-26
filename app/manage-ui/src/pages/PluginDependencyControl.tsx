import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, changePluginDependency, getPluginDependencyState, type PluginDependencyState } from "../api/client";

export function PluginDependencyControl({ installationId, componentId, revision, enabled, disabled }: {
  installationId: string; componentId: string; revision: number; enabled: boolean; disabled: boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<PluginDependencyState | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setState(null); setError(false); setUnsupported(false); setBusy(false);
    void getPluginDependencyState(installationId, componentId).then(value => {
      if (generation.current === current) setState(value);
    }).catch(failure => {
      if (generation.current !== current) return;
      if (failure instanceof ApiError && failure.code === "DEPENDENCY_INTERPRETER_UNSUPPORTED") setUnsupported(true);
      else setError(true);
    });
    return () => { generation.current += 1; };
  }, [installationId, componentId, revision]);
  const change = async (action: "prepare" | "revoke") => {
    const current = generation.current;
    setBusy(true); setError(false);
    try {
      const result = await changePluginDependency({ action, installationId, componentId,
        expectedRevision: revision, operationId: crypto.randomUUID() });
      if (generation.current === current && result.receipt) setState(result.receipt);
    } catch {
      if (generation.current === current) {
        setError(true);
        // Reading the persisted state resolves a lost response without rerunning
        // the selected binary or replaying an unconfirmed preparation.
        try {
          const value = await getPluginDependencyState(installationId, componentId);
          if (generation.current === current) setState(value);
        } catch { /* Keep the failure visible. */ }
      }
    } finally { if (generation.current === current) setBusy(false); }
  };
  if (unsupported) return null;
  return <>
    {state && <span>{state.status === "ready" ? `${state.interpreter} ${state.version} · ${t("plugins.dependencyReady")}`
      : t("plugins.dependencyNeeded")}</span>}
    {enabled && <span>{t("plugins.dependencyDisableFirst")}</span>}
    <button className="btn-secondary" type="button" disabled={enabled || disabled || busy} onClick={() => void change("prepare")}>
      {t("plugins.dependencyPrepare")}
    </button>
    {state && state.revision > 0 && state.status !== "revoked" && <button className="btn-secondary" type="button"
      disabled={enabled || disabled || busy} onClick={() => void change("revoke")}>{t("plugins.dependencyRevoke")}</button>}
    {error && <span role="alert">{t("plugins.dependencyFailed")}</span>}
  </>;
}
