import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "../../components/Field";
import { getGroupChatDiagnostics } from "../../api/client";
import type { AppConfig, GroupChatDiagnostics } from "../../types";
import s from "./SettingsGroupChat.module.css";

const sum = (counts: Record<string, number> | undefined, keys: string[]) =>
  keys.reduce((total, key) => total + (counts?.[key] ?? 0), 0);

/** 多 Agent 群聊的开关与运行诊断：关闭只隐藏入口并停止群活动，群和历史都保留。 */
export default function SettingsGroupChat({ cfg, onChange, disabled }: {
  cfg: AppConfig; onChange: (patch: Partial<AppConfig>) => void; disabled: boolean;
}) {
  const { t } = useTranslation();
  const enabled = cfg.groupChatEnabled !== false;
  const [info, setInfo] = useState<GroupChatDiagnostics | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    try { setInfo(await getGroupChatDiagnostics()); setFailed(false); }
    catch { setInfo(null); setFailed(true); }
    finally { setBusy(false); }
  }, []);
  // 开关的保存与「停掉进行中的群活动」都是异步的：切换后稍等再读一次，读数才是切换后的状态。
  useEffect(() => {
    void refresh();
    const timer = setTimeout(() => void refresh(), 1500);
    return () => clearTimeout(timer);
  }, [refresh, enabled]);

  return <section className="settings-section" id="settings-group-chat" aria-labelledby="settings-group-chat-title">
    <header className="settings-section-head">
      <h3 className="settings-h" id="settings-group-chat-title">{t("settings.groupChat.title")}</h3>
      <p className="settings-sech">{t("settings.groupChat.description")}</p>
    </header>
    <div className="settings-card settings-list-card">
      <div className="settings-list-row">
        <Switch checked={enabled} disabled={disabled} onChange={(value) => onChange({ groupChatEnabled: value })}
          label={<span className={s.copy}>
            <span>{t("settings.groupChat.enable")}</span><small>{t("settings.groupChat.enableHint")}</small>
          </span>} />
      </div>
      <div className={s.footer}>
        <div className={s.statusRow}>
          <p className="ui-hint" role="status">
            {failed ? t("settings.groupChat.unavailable") : !info ? t("settings.groupChat.checking")
              : t("settings.groupChat.summary", {
                groups: info.groups.active ?? 0, archived: info.groups.archived ?? 0,
                turns: sum(info.turns, ["running", "waiting", "queued"]),
              })}
          </p>
          <button type="button" className="ui-cbtn ui-cbtn--sm" disabled={busy} onClick={() => void refresh()}>
            {busy ? t("settings.serviceWorking") : t("settings.groupChat.refresh")}
          </button>
        </div>
        {info && <span className={s.detail}>{t("settings.groupChat.detail", {
          version: info.schemaVersion, messages: info.messages, sessions: info.internalSessions,
          external: info.externalTurns, driver: t(info.driverRunning ? "settings.groupChat.driverOn" : "settings.groupChat.driverOff"),
        })}</span>}
      </div>
    </div>
  </section>;
}
