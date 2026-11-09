import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { listMcpConnectors, searchMcpRegistry, type McpRegistryItem, type McpServer } from "../api/mcpConnectors";
import { usePendingConnectors } from "../lib/usePendingConnectors";
import { useMcpConnectorRefresh } from "../lib/useMcpConnectorRefresh";
import McpApprovalInbox from "../components/McpApprovalInbox";
import { AppleDeviceRows, useAppleDeviceConnectors } from "../components/AppleDeviceConnectors";
import ConnectorAddButton from "../components/ConnectorAddButton";
import McpConnectorIcon from "../components/McpConnectorIcon";
import { ConnectorInfo } from "../components/ConnectorDetails";
import { PageHead } from "../components/PageHead";
import Modal from "../components/Modal";
import { usePageCache } from "../lib/usePageCache";
import { useRegisterPageLoading, useRegisterPageRefresh } from "../lib/page-refresh";
import McpConnectorDialog from "./McpConnectorDialog";
import LarkCliDialog, { LarkCliInstalledRow, LarkCliRecommendation, useLarkCliConnector } from "./LarkCliConnector";
import OfficialSkillDialog, { OfficialSkillInstalledRows, OfficialSkillRecommendation, officialConnectorDefinitions, useOfficialSkillConnectors, type OfficialConnectorDefinition } from "./OfficialSkillConnectors";
import type { OfficialConnectorId } from "../api/officialSkillConnectors";
import { FIGMA_REGISTRY_NAME, isFigmaDesktopConnector, mcpAvailableUpdate, mcpRecommendationText, mcpRecommendationMatchesServer, mcpRecommendationForTarget, mcpServiceGroupEndpoints, mcpServiceGroupSummary, type McpRecommendation } from "../lib/mcpConnectorUi";
import { mcpBrandId, mcpConnectorDeveloper, mcpConnectorName, mcpOfficialSkillBrand, mcpRecommendationRank, mcpRecommendationVisibleInLocale, mcpRegistrySummary } from "../lib/mcpRecommendationCatalog";
import featuredServers from "../../../agent-service/data/mcp-featured-servers.json";
import featuredPresets from "../../../agent-service/data/mcp-featured-presets.json";
import s from "./ConnectorsPage.module.css";

type RecommendationCard = { id: string; kind: "lark" } | { id: string; kind: "official"; definition: OfficialConnectorDefinition } | { id: string; kind: "registry"; item: McpRegistryItem } | { id: string; kind: "preset"; recommendation: McpRecommendation };

const recommendations = featuredPresets as McpRecommendation[];
// Keep all presets for existing connections; recommendations only expose usable setup flows.
const hiddenRecommendations = recommendations.filter(value => value.hidden || value.supersededBy || value.setup === "oauth-client" || value.setup === "restricted" || value.requiresOAuthApp);
const directRecommendations = recommendations.filter(value => !value.registryName && !hiddenRecommendations.includes(value));
const hiddenRegistryNames = new Set(hiddenRecommendations.map(value => value.registryName));

export default function ConnectorsPage() {
  const { t, i18n } = useTranslation(); const tr = (key: string) => t(`mcpConnectors.${key}`); const location = useLocation();
  const language = i18n?.resolvedLanguage || i18n?.language || "en";
  const pending = usePendingConnectors();
  const installed = usePageCache("mcp-connectors", () => listMcpConnectors());
  const lark = useLarkCliConnector();
  const [larkDialog, setLarkDialog] = useState(false);
  const official = useOfficialSkillConnectors();
  const [officialDialog, setOfficialDialog] = useState<OfficialConnectorId | null>(null);
  const officialServerIds = new Set(official.data?.items.flatMap(item => item.serverId ? [item.serverId] : []) || []);
  const unmanagedServers = installed.data?.servers.filter(server => !officialServerIds.has(server.id));
  const installedRows = (unmanagedServers || []).filter((server, index, all) => {
    const group = recommendations.find(value => mcpServiceGroupEndpoints(value).length && mcpRecommendationMatchesServer(value, server));
    return !group || all.findIndex(value => mcpRecommendationMatchesServer(group, value)) === index;
  });
  const featuredNames = featuredServers;
  const recommended = usePageCache(`mcp-recommended:${featuredNames.join(",")}`, async () => {
    const results = await Promise.allSettled(featuredNames.map(async name => (await searchMcpRegistry(name)).items.find(item => item.registryName === name)));
    const items = results.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []);
    if (!items.length && results.some(result => result.status === "rejected")) throw new Error("MCP_REGISTRY_UNAVAILABLE");
    return items;
  }, { enabled: featuredNames.length > 0, staleTime: 300000 });
  const [dialog, setDialog] = useState<{ server?: McpServer; item?: McpRegistryItem; latest?: McpRegistryItem; recommendation?: McpRecommendation; pendingKey?: string; autoAdd?: boolean } | null>(null);
  const [checkedUpdates, setCheckedUpdates] = useState<McpRegistryItem[]>([]);
  const [unavailableDialog, setUnavailableDialog] = useState<string | null>(null);
  const [deviceRefresh, setDeviceRefresh] = useState(0);
  const devices = useAppleDeviceConnectors(deviceRefresh);
  useMcpConnectorRefresh(installed.refresh);
  useRegisterPageRefresh("/connectors", () => { void installed.refresh(); void lark.refresh(); if (lark.data?.state === "installed") void lark.setup.refresh(); void official.refresh(); if (featuredNames.length) void recommended.refresh(); setDeviceRefresh(value => value + 1); }); useRegisterPageLoading("/connectors", installed.loading || recommended.loading || lark.loading || official.loading);
  const featured = recommended.data || [];
  const iconItems = new Map([...featured, ...checkedUpdates].map(item => [item.registryName, item]));
  const updateFor = (server: McpServer) => mcpAvailableUpdate(server, [...featured, ...checkedUpdates]);
  const desktopFigma = installed.data?.servers.find(isFigmaDesktopConnector);
  const cards: RecommendationCard[] = [
    { id: "lark-cli", kind: "lark" },
    ...officialConnectorDefinitions.map(definition => ({ id: definition.id, kind: "official" as const, definition })),
    ...featured.filter(item => !hiddenRegistryNames.has(item.registryName)).map(item => ({ id: mcpBrandId(item.registryName), kind: "registry" as const, item })),
    ...directRecommendations.map(recommendation => ({ id: recommendation.id, kind: "preset" as const, recommendation })),
  ];
  cards.sort((a, b) => mcpRecommendationRank(a.id) - mcpRecommendationRank(b.id) || a.id.localeCompare(b.id));
  const keyFor = (card: RecommendationCard) => card.kind === "registry" ? `registry:${card.item.registryName}` : card.kind === "preset" ? `preset:${card.recommendation.id}` : card.id;
  const serverFor = (card: RecommendationCard) => card.kind === "registry"
    ? installed.data?.servers.find(server => server.source.kind === "registry" && server.source.registryName === card.item.registryName)
      || (card.item.registryName === FIGMA_REGISTRY_NAME ? desktopFigma : undefined)
    : card.kind === "preset" ? installed.data?.servers.find(server => mcpRecommendationMatchesServer(card.recommendation, server))
    : card.kind === "official" ? installed.data?.servers.find(server => mcpOfficialSkillBrand(server) === card.definition.id) : undefined;
  const openCard = (card: RecommendationCard, autoAdd = false) => {
    if (card.kind === "lark") { setLarkDialog(true); if (autoAdd) void lark.change("install"); return; }
    if (card.kind === "official") { setOfficialDialog(card.definition.id); if (autoAdd && !serverFor(card) && !official.data?.items.find(item => item.id === card.definition.id)?.canRemove) void official.change(card.definition.id, "install"); return; }
    const server = serverFor(card);
    setDialog({ ...(card.kind === "registry" ? { item: card.item, recommendation: mcpRecommendationForTarget(recommendations, { registryName: card.item.registryName, catalogId: card.id }) } : { recommendation: card.recommendation }),
      server, pendingKey: keyFor(card), autoAdd });
  };
  const pendingCards = cards.filter(card => ["registry", "preset"].includes(card.kind) && pending.ids.includes(keyFor(card)) && !serverFor(card));
  // An offline Registry lookup must not make a pending entry disappear.
  const unavailablePending = pending.ids.filter(id => id.startsWith("registry:") && !cards.some(card => keyFor(card) === id)
    && !installed.data?.servers.some(server => server.source.kind === "registry" && `registry:${server.source.registryName}` === id));
  const recommendedCards = cards
    .filter(card => mcpRecommendationVisibleInLocale(card.id, language))
    .filter(card => card.kind === "lark" ? !lark.data?.canRemove
      : card.kind === "official" ? !official.data?.items.find(item => item.id === card.definition.id)?.canRemove && !serverFor(card)
      : !serverFor(card) && !pending.ids.includes(keyFor(card)));
  const cardContent = (card: Extract<RecommendationCard, { kind: "registry" | "preset" }>) => {
    const recommendation = card.kind === "preset" ? card.recommendation : mcpRecommendationForTarget(recommendations, { registryName: card.item.registryName, catalogId: card.id });
    const summary = card.kind === "registry" ? mcpRegistrySummary(card.item.registryName) : undefined;
    const name = mcpConnectorName(recommendation?.id || (card.kind === "registry" ? card.item.registryName : card.id), recommendation?.name || summary?.name || (card.kind === "registry" ? card.item.name : card.id));
    const description = recommendation?.description || summary?.description;
    return { name, description: description ? mcpRecommendationText(description, language) : card.kind === "registry" ? card.item.description || card.item.registryName : "",
      icon: <McpConnectorIcon name={name} identity={card.kind === "registry" ? card.item.registryName : card.recommendation.url || card.id} iconId={recommendation?.id} icons={card.kind === "registry" ? card.item.icons : undefined} /> };
  };
  const rows = <div className={s.catalog}>{recommendedCards.map(card => {
    if (card.kind === "lark") return <LarkCliRecommendation key={card.id} model={lark} onOpen={() => openCard(card)} onAdd={() => openCard(card, true)} />;
    if (card.kind === "official") return <OfficialSkillRecommendation key={card.id} definition={card.definition} model={official} onOpen={() => openCard(card)} onAdd={() => openCard(card, true)} />;
    const content = cardContent(card);
    return <div className={s.service} key={card.id}>
      <button type="button" className={s.serviceOpen} onClick={() => openCard(card)}>{content.icon}<span className={s.serviceText}><strong>{content.name}</strong><small>{content.description}</small></span></button>
      <ConnectorAddButton name={content.name} onClick={() => openCard(card, true)} />
    </div>;
  })}</div>;

  const error = (message: string | null, retry: () => void) => message && <p className={s.error} role="alert">{tr("loadFailed")} <button type="button" className={s.textButton} onClick={retry}>{tr("retry")}</button></p>;
  const unavailableName = (id: string) => mcpConnectorName(id.slice(9), mcpRegistrySummary(id.slice(9))?.name || id.slice(9));
  return <div className={`page management-page management-page--scroll-card ${s.page}`}><PageHead title={tr("title")} subtitle={tr("subtitle")} />
    <div className={`management-page__scroll-card ${s.contentCard}`}>
    {new URLSearchParams(location.search).has("legacy") && <p className={s.notice}>{tr("retired")}</p>}
    <McpApprovalInbox embedded />
    <section className={s.section}><div className={s.sectionHeading}><h2>{tr("installed")}</h2>{(installed.data || lark.data || official.data) && <span className={s.count}>{devices.count + installedRows.length + pendingCards.length + unavailablePending.length + Number(Boolean(lark.data?.canRemove)) + (official.data?.items.filter(item => item.canRemove).length || 0)}</span>}</div>
      {error(installed.error, () => void installed.refresh())}
      {lark.error && <p className={s.error} role="alert">{t("larkCli.loadFailed")} <button type="button" className={s.textButton} onClick={() => void lark.refresh()}>{tr("retry")}</button></p>}
      {official.error && <p className={s.error} role="alert">{t("officialConnectors.loadFailed")} <button type="button" className={s.textButton} onClick={() => void official.refresh()}>{tr("retry")}</button></p>}
      {installed.loading && !installed.data && <p className={s.muted} role="status">{tr("loading")}</p>}
      <ul className={s.installedList}><AppleDeviceRows model={devices} installed /><LarkCliInstalledRow model={lark} onOpen={() => setLarkDialog(true)} /><OfficialSkillInstalledRows model={official} servers={installed.data?.servers} onOpen={setOfficialDialog} />{installedRows.map(server => {
        const local = isFigmaDesktopConnector(server);
        const identity = local ? FIGMA_REGISTRY_NAME : server.source.kind === "registry" ? server.source.registryName : server.id;
        const recommendation = mcpRecommendationForTarget(recommendations, { server, catalogId: server.source.kind === "registry" ? mcpBrandId(server.source.registryName) : undefined });
        const group = recommendation && mcpServiceGroupEndpoints(recommendation).length ? mcpServiceGroupSummary(recommendation, unmanagedServers || []) : undefined;
        const officialDefinition = officialConnectorDefinitions.find(value => value.id === mcpOfficialSkillBrand(server));
        const name = mcpConnectorName(local ? "figma" : officialDefinition?.id || recommendation?.id || identity, group ? recommendation!.name : server.name);
        const ready = group ? group.ready === group.total : server.status === "ready";
        return <li key={group ? recommendation!.id : server.id} className={s.installedItem}>
          <button type="button" className={s.installedOpen} aria-label={`${tr("manage")} ${name}`} onClick={() => setDialog({ server, latest: updateFor(server), recommendation })}>
            <McpConnectorIcon name={name} identity={identity} iconId={officialDefinition?.id || recommendation?.id} icons={iconItems.get(identity)?.icons} />
            <span className={s.installedLabel}><strong>{name}</strong>{!ready && <small className={s.connectionHint}>{tr("flow.notConnected")}</small>}</span>
          </button>
        </li>;
      })}{pendingCards.map(card => {
        if (card.kind !== "registry" && card.kind !== "preset") return null;
        const content = cardContent(card);
        return <li className={s.installedItem} key={keyFor(card)}><button type="button" className={s.installedOpen} aria-label={`${tr("manage")} ${content.name}`} onClick={() => openCard(card)}>{content.icon}<span className={s.installedLabel}><strong>{content.name}</strong><small className={s.connectionHint}>{tr("flow.notConnected")}</small></span></button></li>;
      })}{unavailablePending.map(id => <li className={s.installedItem} key={id}><button type="button" className={s.installedOpen} aria-label={`${tr("manage")} ${unavailableName(id)}`} onClick={() => setUnavailableDialog(id)}><McpConnectorIcon name={unavailableName(id)} identity={id.slice(9)} /><span className={s.installedLabel}><strong>{unavailableName(id)}</strong><small className={s.connectionHint}>{tr("flow.notConnected")}</small></span></button></li>)}</ul>
      {!installed.loading && !installed.error && !installed.data?.servers.length && !devices.count && !pendingCards.length && !unavailablePending.length && lark.data && !lark.data.canRemove && official.data && !official.data.items.some(item => item.canRemove) && <p className={s.muted}>{tr("empty")}</p>}
    </section>
    <section className={s.section}><div className={s.sectionHeading}><h2>{tr("recommended")}</h2></div>{error(recommended.error, () => void recommended.refresh())}{rows}{devices.hasRecommendations && <><div className={s.sectionHeading}><h2>{t("appleDevices.title")}</h2></div><div className={s.catalog}><AppleDeviceRows model={devices} installed={false} /></div></>}{recommended.loading && !recommended.data && <p className={s.muted} role="status">{tr("loading")}</p>}</section>
    </div>
    {unavailableDialog && <Modal open title={<span className={s.dialogIdentity}><McpConnectorIcon name={unavailableName(unavailableDialog)} identity={unavailableDialog.slice(9)} />{unavailableName(unavailableDialog)}</span>} onClose={() => setUnavailableDialog(null)} width={640} variant="connector" footer={<div className={s.flowFooter}><p>{tr("flow.pending")}</p><div className={s.flowFooterActions}>
        <button type="button" className="btn-dark btn-sm" onClick={() => { void recommended.refresh(); setUnavailableDialog(null); }}>{tr("retry")}</button>
        <button type="button" className="btn-danger btn-sm" onClick={() => { pending.remove(unavailableDialog); setUnavailableDialog(null); }}>{tr("flow.remove")}</button>
      </div></div>}>
      <div className={s.detail}><section className={s.connectionPanel}><p>{tr("flow.unavailableEntry")}</p></section><ConnectorInfo developer={mcpConnectorDeveloper(unavailableDialog.slice(9))} /></div>
    </Modal>}
    {dialog && <McpConnectorDialog {...dialog} catalogEntry={!!dialog.pendingKey} pending={!!dialog.pendingKey && pending.ids.includes(dialog.pendingKey)} onStage={dialog.pendingKey ? () => pending.add(dialog.pendingKey!) : undefined} onUnstage={dialog.pendingKey ? () => pending.remove(dialog.pendingKey!) : undefined} allowFigmaDesktop onLatest={item => setCheckedUpdates(previous => [...previous.filter(value => value.registryName !== item.registryName), item])} onClose={() => setDialog(null)} onChanged={() => void installed.refresh()} />}
    {larkDialog && <LarkCliDialog model={lark} onClose={() => setLarkDialog(false)} />}
    {officialDialog && <OfficialSkillDialog key={officialDialog} id={officialDialog} model={official} onClose={() => setOfficialDialog(null)} onChanged={() => { void installed.refresh(); void official.refresh(); }} />}
  </div>;
}
