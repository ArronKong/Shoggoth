"use strict";

const crypto = require("node:crypto");
const { hasSecret } = require("./memory-engine");
const { createDefaultDocuments } = require("./agent-definition-defaults");
const { isRuntimeAvailable: defaultIsRuntimeAvailable } = require("../runtime-availability");
const { resultPage } = require("../group-result-content");
const { groupCapabilities } = require("./group-capabilities");

// 群成员目录：公开设定的确定性提取与版本快照。
// 原生 Agent 的角色写在 IDENTITY.md（角色 / 默认定位），协作风格写在 SOUL.md；两份文件经
// 共享前过滤后才进入成员卡或被同伴读取。USER.md、AGENTS.md、记忆与会话永不导出。
const EXTRACTOR_VERSION = 3;
const MAX_ROLE_CHARS = 60;
const MAX_SPECIALTY_CHARS = 40;
const MAX_SPECIALTIES = 5;
const MAX_STYLE_CHARS = 160;
const DISCLOSURE_POLICY_REVISION = 1;
const EXTERNAL_SOURCE_TTL_MS = 60_000;
const REDACTED_LINE = "[已隐去]";
const ROLE_LINE = /^\s*[-*]\s*(?:角色|role)\s*[:：]\s*(.+?)\s*$/imu;
const POSITION_LINE = /^\s*[-*]\s*(?:默认定位|定位|position)\s*[:：]\s*(.+?)\s*$/imu;
const SPECIALTY_HEADING = /专长|擅长|职责|技能|能力|负责|expertise|skills?|responsibilit|strengths?/iu;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/u;

const DEFAULTS = createDefaultDocuments("default");
const DEFAULT_ROLE = ROLE_LINE.exec(DEFAULTS.IDENTITY)?.[1] ?? null;

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function truncate(value, maxChars) {
  const chars = [...value.trim()];
  return chars.length <= maxChars ? chars.join("") : `${chars.slice(0, maxChars - 1).join("")}…`;
}

function normalizeText(value) {
  return String(value ?? "").replace(/\r\n?/gu, "\n").replace(/[ \t]+$/gmu, "").trim();
}

// 共享前过滤：HTML 注释视为私密备注不共享；含凭据的行整行隐去。处理过即标记 redacted。
function filterForSharing(document) {
  if (typeof document !== "string" || document.trim() === "") return { text: null, redacted: false };
  let redacted = !document.isWellFormed() || document.includes("\0");
  document = document.toWellFormed().replace(/\0/gu, "\ufffd");
  const withoutComments = document.replace(/<!--[\s\S]*?(?:-->|$)/gu, () => { redacted = true; return ""; });
  const lines = withoutComments.split(/\r?\n/u).map((line) => {
    if (line.trim() && hasSecret(line)) { redacted = true; return REDACTED_LINE; }
    return line;
  });
  return { text: normalizeText(lines.join("\n")), redacted };
}

function exportRoleDocuments({ identity, soul }) {
  const sourceDigest = sha256(JSON.stringify([identity ?? null, soul ?? null]));
  const sharedIdentity = filterForSharing(identity);
  const sharedSoul = filterForSharing(soul);
  // 文件自带「# IDENTITY.md」标题时不再重复加。
  const titled = (name, text) => (new RegExp(`^#{1,6}\\s*${name.replace(".", "\\.")}\\b`, "iu").test(text)
    ? text : `## ${name}\n\n${text}`);
  const sections = [];
  if (sharedIdentity.text) sections.push(titled("IDENTITY.md", sharedIdentity.text));
  if (sharedSoul.text) sections.push(titled("SOUL.md", sharedSoul.text));
  const full = sections.join("\n\n");
  const text = full;
  return {
    identity: sharedIdentity.text,
    soul: sharedSoul.text,
    text,
    truncated: false,
    disclosure: sharedIdentity.redacted || sharedSoul.redacted ? "redacted" : "verbatim",
    sourceDigest,
    exportDigest: sha256(text),
  };
}

// 中文行之间不加空格，其他语言按空格连接。
function joinLines(lines) {
  return lines.reduce((text, line) => (!text ? line
    : /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]$/u.test(text) ? `${text}${line}` : `${text} ${line}`), "");
}

function paragraphs(markdown) {
  const result = [];
  let current = [];
  let fenced = false;
  for (const line of String(markdown ?? "").split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const isBreak = line.trim() === "" || /^\s*#/u.test(line) || LIST_ITEM.test(line);
    if (isBreak) {
      if (current.length) result.push(joinLines(current));
      current = [];
      continue;
    }
    current.push(line.trim());
  }
  if (current.length) result.push(joinLines(current));
  return result.filter((text) => text !== REDACTED_LINE);
}

function consultWhenOf(...documents) {
  const items = [];
  for (const document of documents) {
    let active = false;
    for (const line of String(document ?? "").split("\n")) {
      const heading = /^\s*#{1,6}\s+(.+?)\s*$/u.exec(line);
      if (heading) { active = /适合请教|何时请教|参与时机|协作边界|when.*consult|consult.*when/iu.test(heading[1]); continue; }
      const item = active ? LIST_ITEM.exec(line) : null;
      if (item && item[1] !== REDACTED_LINE && items.length < MAX_SPECIALTIES) items.push(truncate(item[1], MAX_STYLE_CHARS));
    }
  }
  return items;
}

function specialtiesOf(...documents) {
  const items = [];
  for (const document of documents) {
    let inSection = false;
    for (const line of String(document ?? "").split("\n")) {
      const heading = /^\s*#{1,6}\s+(.+?)\s*$/u.exec(line);
      if (heading) { inSection = SPECIALTY_HEADING.test(heading[1]); continue; }
      const item = inSection ? LIST_ITEM.exec(line) : null;
      if (item && item[1] !== REDACTED_LINE && items.length < MAX_SPECIALTIES) {
        items.push(truncate(item[1], MAX_SPECIALTY_CHARS));
      }
    }
  }
  return items;
}

// OpenClaw 新建 Agent 自带的模板：还留着这两句说明就是没填过，模板文字不能当成角色或风格。
const OPENCLAW_IDENTITY_UNFILLED = /_Fill this in during your first conversation\./u;
const OPENCLAW_SOUL_TEMPLATE = /_You're not a chatbot\. You're becoming someone\._/u;

/** 只提取原文有依据的内容；缺失返回 null，不从名字推断。 */
function extractCard(exported) {
  const identity = exported.identity ?? "";
  const roleLine = ROLE_LINE.exec(identity)?.[1] ?? null;
  const templateIdentity = roleLine === null && OPENCLAW_IDENTITY_UNFILLED.test(identity);
  const usesDefaultStyle = exported.soul !== null && (normalizeText(exported.soul) === normalizeText(DEFAULTS.SOUL)
    || OPENCLAW_SOUL_TEMPLATE.test(exported.soul));
  const firstIdentityParagraph = templateIdentity ? null : paragraphs(identity)[0] ?? null;
  // 没有 IDENTITY（如 Hermes 只有 SOUL.md）或 IDENTITY 还是没填过的模板时，角色退回 SOUL 第一段的第一句。
  const roleSource = firstIdentityParagraph ?? (exported.identity === null || templateIdentity
    ? (usesDefaultStyle ? null : paragraphs(exported.soul)[0] ?? null) : null);
  const usesDefaultRole = (roleLine !== null && normalizeText(roleLine) === normalizeText(DEFAULT_ROLE))
    || (templateIdentity && roleSource === null);
  const role = usesDefaultRole ? null
    : roleLine ? truncate(roleLine, MAX_ROLE_CHARS)
      : roleSource ? truncate(roleSource.split(/(?<=[。.!！?？])/u)[0], MAX_ROLE_CHARS) : null;
  const position = usesDefaultRole ? null : POSITION_LINE.exec(identity)?.[1] ?? null;
  const style = usesDefaultStyle ? null : paragraphs(exported.soul)[0] ?? null;
  return {
    role,
    position: position ? truncate(position, MAX_STYLE_CHARS) : null,
    specialties: specialtiesOf(exported.identity, exported.soul),
    consultWhen: consultWhenOf(exported.identity, exported.soul),
    workingStyle: style ? truncate(style, MAX_STYLE_CHARS) : null,
    usesDefaultRole,
    usesDefaultStyle,
    missing: exported.identity === null && exported.soul === null,
  };
}

class GroupMemberDirectory {
  constructor({ store, productStore, definitionStore, isRuntimeAvailable = defaultIsRuntimeAvailable,
    getFederationClient = () => null, now = Date.now, onChanged = () => {},
    disclosurePolicyRevision = DISCLOSURE_POLICY_REVISION, groupToolsAvailable = () => false,
    getGroupToolCapability = () => null, probeNative = null }) {
    this.groupToolsAvailable = groupToolsAvailable;
    this.getGroupToolCapability = getGroupToolCapability;
    this.probeNative = probeNative; this.nativeCapabilities = new Map();
    this.store = store;
    this.productStore = productStore;
    this.definitionStore = definitionStore;
    this.isRuntimeAvailable = isRuntimeAvailable;
    this.getFederationClient = getFederationClient;
    this.now = now;
    this.onChanged = onChanged;
    this.extractions = 0;
    this.externalSources = new Map();
    this.refreshGenerations = new Map();
    this.disclosurePolicyRevision = disclosurePolicyRevision;
  }

  stop() { this.refreshGenerations.clear(); }
  cancelGroup(groupId) {
    this.refreshGenerations.set(groupId, (this.refreshGenerations.get(groupId) ?? 0) + 1);
  }

  #snapshot(groupId, memberId, source, exported) {
    return this.store.saveRoleSnapshot({ groupId, memberId, text: exported.text,
      sourceRevision: source.revision, sourceDigest: exported.sourceDigest, exportDigest: exported.exportDigest,
      disclosurePolicyRevision: this.disclosurePolicyRevision, disclosure: exported.disclosure });
  }

  // 原生成员：本机定义库；外部成员（Hermes / OpenClaw）：经 App 私有桥读取其 IDENTITY.md / SOUL.md，
  // 短时缓存，避免每轮一次远端读取。读不到时视为离线，保留上一张卡。
  async #source(member, fresh = false) {
    if (member.profileId) {
      const profile = this.productStore.getAgentProfile(member.profileId) ?? null;
      const definition = profile ? this.definitionStore.get(profile.id) : null;
      const key = JSON.stringify([profile?.id, profile?.selectedBindingId, profile?.runtime, profile?.runtimeProfileId,
        profile?.runtimeAccountId, profile?.updatedAt, profile?.enabled]);
      let capability = this.nativeCapabilities.get(key);
      if (!capability || fresh || this.now() - capability.at >= EXTERNAL_SOURCE_TTL_MS) {
        let value = groupCapabilities({ groupTools: true, source: "native-binding", checkedAt: this.now() });
        if (profile?.enabled && this.probeNative) {
          try { value = await this.probeNative({ member, onCapabilitiesChanged: () => {
            this.nativeCapabilities.delete(key);
            if (typeof member.groupId === "string") void this.refresh(member.groupId)
              .then(result => { if (result?.changed) this.onChanged(member.groupId); }).catch(() => {});
          } }) ?? value; }
          catch { value = groupCapabilities({ availability: "unavailable", checkedAt: this.now() }); }
        }
        capability = { at: this.now(), value }; this.nativeCapabilities.set(key, capability);
        if (this.nativeCapabilities.size > 256) this.nativeCapabilities.delete(this.nativeCapabilities.keys().next().value);
      }
      return {
        name: profile?.name ?? null,
        online: Boolean(profile?.enabled && this.isRuntimeAvailable(profile.runtime)),
        runtime: profile?.runtime ?? null,
        model: profile?.defaultModel ?? null,
        revision: definition?.manifest?.revision ?? null,
        identity: definition?.documents?.IDENTITY ?? null,
        soul: definition?.documents?.SOUL ?? null,
        readable: Boolean(profile),
        groupTools: capability.value.groupTools,
        capabilities: capability.value,
      };
    }
    const key = `${member.backendId}\0${member.peerId ?? ""}\0${member.agentId}`;
    const cached = this.externalSources.get(key);
    if (!fresh && cached && this.now() - cached.at < EXTERNAL_SOURCE_TTL_MS) return cached.source;
    const client = this.getFederationClient();
    let source = { name: null, online: false, runtime: member.backendId, model: null, revision: null,
      identity: null, soul: null, readable: false, groupTools: false,
      capabilities: groupCapabilities({ availability: "unavailable", checkedAt: this.now() }) };
    if (client) {
      try {
        const ref = { backendId: member.backendId, agentId: member.agentId, ...(member.peerId ? { peerId: member.peerId } : {}) };
        const { agent, document } = await client.request(member.peerId ? "group.external.member" : "agent.get", ref);
        let peerDocuments = null;
        if (member.peerId) {
          let offset = 0; const chunks = [];
          do {
            const { page } = await client.request("group.external.role", { ...ref, offset, digest: document.digest });
            if (page.offset !== offset || page.digest !== document.digest || page.totalBytes !== document.bytes
              || page.totalBytes > 16 * 1024 * 1024) throw new Error("role snapshot mismatch");
            chunks.push(page.text); offset = page.nextOffset;
          } while (offset !== null);
          const full = chunks.join("");
          if (sha256(full) !== document.digest || Buffer.byteLength(full) !== document.bytes) throw new Error("role digest mismatch");
          peerDocuments = JSON.parse(full);
          if (!peerDocuments || Object.keys(peerDocuments).sort().join(",") !== "identity,soul"
            || [peerDocuments.identity, peerDocuments.soul].some(value => value !== null && typeof value !== "string")) throw new Error("role document invalid");
        }
        const read = async (file) => {
          if (peerDocuments) return { available: true, text: peerDocuments[file === "IDENTITY.md" ? "identity" : "soul"] };
          if (member.backendId === "hermes" && file === "IDENTITY.md") return { available: true, text: null };
          try {
            const result = await client.request("agent.file.read",
              { backendId: member.backendId, agentId: member.agentId, file });
            return { available: true, text: result.file.missing || !result.file.content.trim() ? null : result.file.content };
          } catch { return { available: false, text: null }; }
        };
        // 群工具通道（D2）：App 按 shoggoth MCP 的实际注册结果回答；问不到就按只能文字讨论。
        const tools = async () => {
          let value = groupCapabilities({ source: "legacy-host", checkedAt: this.now() });
          try {
            let result;
            try { result = await client.request("group.external.capabilities", { ...ref, protocolVersion: 2 }); }
            catch (error) {
              if (!["APP_HOST_INVALID_REQUEST", "INVALID_PARAMS", "APP_HOST_REQUEST_INVALID"].includes(error?.code)) throw error;
              result = await client.request("group.external.capabilities", ref);
            }
            value = groupCapabilities({ ...result, source: result.source ?? "legacy-host", checkedAt: this.now() });
          } catch { /* Offline capability reads never retain old actions. */ }
          const proof = !member.peerId ? this.getGroupToolCapability(member) : null;
          const groupTools = value.groupTools || !member.peerId && this.groupToolsAvailable(member) === true || proof?.groupTools === true;
          const actions = value.collaborationActions || proof?.protocolVersion === 2 && proof?.collaborationActions === true;
          return groupCapabilities({ ...value, groupTools, collaborationActions: groupTools && actions,
            protocolVersion: actions ? 2 : value.protocolVersion });
        };
        const [identity, soul, capabilities] = await Promise.all([read("IDENTITY.md"), read("SOUL.md"), tools()]);
        source = { name: agent.name || null, online: true, runtime: member.backendId, model: agent.model || null,
          revision: null, identity, soul, readable: true, groupTools: capabilities.groupTools, capabilities };
        source.identity = identity.text; source.soul = soul.text; source.readable = identity.available && soul.available;
      } catch { /* 后端未连接或 Agent 不存在：离线 */ }
    }
    this.externalSources.set(key, { at: this.now(), source });
    return source;
  }

  /**
   * 回合边界刷新：内容摘要不变就沿用上一张卡，不重新提取；任一卡变化时群目录版本 +1。
   * 同步执行，不会有乱序返回的旧结果覆盖新卡。
   */
  async refresh(groupId, { fresh = false } = {}) {
    const generation = (this.refreshGenerations.get(groupId) ?? 0) + 1;
    this.refreshGenerations.set(groupId, generation);
    const view = this.store.getGroup(groupId);
    if (view.group.status !== "active") return { groupId, changed: false };
    const cards = this.store.getMemberCards(groupId);
    const updates = [];
    const active = view.members.filter((item) => item.state === "active");
    const sources = await Promise.all(active.map((member) => this.#source(member, fresh)));
    if (this.refreshGenerations.get(groupId) !== generation || this.store.groupLifecycle(groupId) !== "active") return { groupId, changed: false };
    for (const [index, member] of active.entries()) {
      const source = sources[index];
      // 外部后端暂时读不到时沿用上一张卡的内容，只把可用状态标为离线。
      if (!source.readable && cards.get(member.id) && !member.profileId
        && cards.get(member.id).disclosurePolicyRevision === this.disclosurePolicyRevision) {
        updates.push({ memberId: member.id, displayName: member.displayName,
          card: { ...cards.get(member.id), availability: source.online ? "online" : "offline", freshness: "stale",
            groupTools: source.groupTools, capabilities: source.capabilities } });
        continue;
      }
      if (!source.readable && !member.profileId) {
        const empty = exportRoleDocuments({ identity: null, soul: null });
        updates.push({ memberId: member.id, displayName: member.displayName, card: { ...extractCard(empty),
          sourceDigest: empty.sourceDigest, exportDigest: empty.exportDigest, disclosure: "verbatim", extractorVersion: EXTRACTOR_VERSION,
          roleSnapshotId: null, disclosurePolicyRevision: this.disclosurePolicyRevision, freshness: "missing",
          availability: source.online ? "online" : "offline", runtime: source.runtime, model: source.model,
          sourceRevision: null, groupTools: source.groupTools, capabilities: source.capabilities } });
        continue;
      }
      const prior = cards.get(member.id);
      const exported = exportRoleDocuments(source);
      const sourceDigest = exported.sourceDigest;
      const snapshot = this.#snapshot(groupId, member.id, source, exported);
      if (!snapshot) continue;
      let content;
      if (prior && prior.sourceDigest === sourceDigest && prior.exportDigest === exported.exportDigest
        && prior.disclosurePolicyRevision === this.disclosurePolicyRevision && prior.extractorVersion === EXTRACTOR_VERSION) {
        const { availability: _a, runtime: _r, model: _m, sourceRevision: _s, cardRevision: _c, groupTools: _g,
          capabilities: _capabilities, ...kept } = prior;
        content = kept;
      } else {
        this.extractions += 1;
        content = { ...extractCard(exported), sourceDigest: exported.sourceDigest,
          exportDigest: exported.exportDigest, disclosure: exported.disclosure, extractorVersion: EXTRACTOR_VERSION };
      }
      if (content.summarySourceDigest !== sourceDigest) content = { ...content, ...extractCard(exported),
        consultWhen: [], summaryMethod: "deterministic", summarySourceDigest: sourceDigest };
      content = { ...content, roleSnapshotId: snapshot.id, disclosurePolicyRevision: this.disclosurePolicyRevision,
        freshness: content.missing ? "missing" : "current" };
      updates.push({
        memberId: member.id,
        displayName: source.name || member.displayName,
        card: {
          ...content,
          availability: source.online ? "online" : "offline",
          runtime: source.runtime,
          model: source.model,
          sourceRevision: source.revision,
          groupTools: source.groupTools,
          capabilities: source.capabilities,
        },
      });
    }
    return this.store.applyMemberCards({ groupId, updates });
  }

  /** seen / latest / 历史读取。游标固定导出快照，续页重查成员关系与当前共享策略。 */
  async readRole(groupId, memberId, options = {}) {
    const view = this.store.getGroup(groupId);
    const member = view.members.find((item) => item.id === memberId);
    if (!member) return { ok: false, code: "member_not_found" };
    if (member.state !== "active") return { ok: false, code: "access_revoked" };
    let snapshot, offset = 0;
    if (options.cursor) {
      const cursor = this.store.roleCursor(null, options.cursor);
      if (!cursor || cursor.groupId !== groupId || cursor.memberId !== memberId
        || cursor.policy !== this.disclosurePolicyRevision || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0
        || (options.revision === "seen" && !options.seenSnapshotId)
        || (options.revision === "seen" && options.seenSnapshotId && cursor.id !== options.seenSnapshotId)
        || (options.revision && !["seen", "latest"].includes(options.revision)
          && cursor.id !== options.revision && String(cursor.sourceRevision) !== options.revision)) {
        return { ok: false, code: "invalid_cursor" };
      }
      snapshot = this.store.getRoleSnapshot({ groupId, memberId, id: cursor.id }); offset = cursor.offset;
      if (!snapshot || snapshot.exportDigest !== cursor.digest) return { ok: false, code: "invalid_cursor" };
    } else if (options.revision === "seen") {
      if (!options.seenSnapshotId) return { ok: false, code: "revision_unavailable" };
      snapshot = this.store.getRoleSnapshot({ groupId, memberId, id: options.seenSnapshotId });
    } else if (options.revision && options.revision !== "latest") {
      snapshot = this.store.getRoleSnapshot({ groupId, memberId, id: options.revision });
      // 原生定义库可以取回入群前的确切版本；外部后端仅使用已经观测并保存的版本。
      if (!snapshot && member.profileId && /^[1-9][0-9]{0,8}$/u.test(options.revision)) {
        const old = this.definitionStore.readRevision?.(member.profileId, Number(options.revision));
        if (old) snapshot = this.#snapshot(groupId, memberId, { revision: old.manifest.revision },
          exportRoleDocuments({ identity: old.documents.IDENTITY, soul: old.documents.SOUL }));
      }
    } else {
      const source = await this.#source(member, true);
      if (!source.readable) return { ok: false, code: "source_unavailable" };
      snapshot = this.#snapshot(groupId, memberId, source, exportRoleDocuments(source));
    }
    if (!snapshot || snapshot.disclosurePolicyRevision !== this.disclosurePolicyRevision) return { ok: false, code: "revision_unavailable" };
    let page;
    try { page = resultPage(snapshot.text, { offset, digest: snapshot.exportDigest }); }
    catch { return { ok: false, code: options.cursor ? "invalid_cursor" : "revision_unavailable" }; }
    const nextCursor = page.nextOffset === null ? null : this.store.roleCursor({ groupId, memberId, id: snapshot.id,
      digest: snapshot.exportDigest, sourceRevision: snapshot.sourceRevision,
      policy: this.disclosurePolicyRevision, offset: page.nextOffset });
    return {
      ok: true,
      memberId: member.id,
      handle: member.handle,
      displayName: member.displayName,
      sourceType: "peer_role_document",
      sourceRevision: snapshot.sourceRevision, sourceDigest: snapshot.sourceDigest, exportDigest: snapshot.exportDigest,
      disclosure: snapshot.disclosure, disclosurePolicyRevision: snapshot.disclosurePolicyRevision,
      revisionId: snapshot.id, changedSinceSeen: Boolean(options.seenSnapshotId && options.seenSnapshotId !== snapshot.id),
      truncated: page.nextOffset !== null, text: page.text, nextCursor, offset: page.offset, totalBytes: page.totalBytes,
    };
  }

  async history(groupId, memberId, query) {
    const view = this.store.getGroup(groupId);
    const member = view.members.find(item => item.id === memberId && item.state === "active");
    if (!member) return { snapshots: [], hasMore: false, nextCursor: null };
    await this.readRole(groupId, memberId, { revision: "latest" });
    return this.store.listRoleSnapshots({ groupId, memberId, ...query });
  }
}

module.exports = { EXTRACTOR_VERSION, GroupMemberDirectory, exportRoleDocuments, extractCard };
