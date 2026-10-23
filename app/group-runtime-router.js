"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { requestGroupHost } = require("./group-runtime-host-client");
const { GroupRuntimeHost } = require("./group-runtime-host");
const p = require("./group-runtime-host-protocol");

/** Routes only explicitly paired hosts; a saved remote identity cannot fall back to the App filesystem or another host. */
class GroupRuntimeRouter {
  constructor({ localRunner, registry, paths, getPeers = () => [], isLocal = () => false,
    invokeTool = null, readTerminalReceipt = null, request = requestGroupHost, allowRemote = false }) {
    this.allowRemote = allowRemote; this.localRunner = localRunner; this.registry = registry; this.paths = paths; this.getPeers = getPeers;
    this.isLocal = isLocal; this.invokeTool = invokeTool; this.request = request; this.localHosts = new Map();
    this.legacyArtifacts = new Map(); this.pollingTools = new Set(); this.closed = false;
    this.readTerminalReceipt = readTerminalReceipt;
  }
  async #local(backendId, agentId) {
    const peerId = `local-${backendId}-${crypto.createHash("sha256").update(agentId).digest("hex").slice(0, 16)}`;
    if (!this.paths || !await this.isLocal({ backendId, agentId })) return null;
    if (this.localHosts.has(peerId)) return this.localHosts.get(peerId);
    const host = new GroupRuntimeHost({ paths: { stateDir: path.join(this.paths.stateDir, "group-runtime-hosts", peerId), trustedRoot: this.paths.trustedRoot },
      registry: this.registry, agent: { backendId, agentId }, ownerToken: crypto.randomBytes(32).toString("base64url"),
      runtimeToken: crypto.randomBytes(32).toString("base64url"), readTerminalReceipt: this.readTerminalReceipt }).open();
    const peer = { id: peerId, backendId, agentId, hostId: host.hostId, local: host };
    this.localHosts.set(peerId, peer); return peer;
  }
  async #peer(input) {
    const peers = this.allowRemote ? p.normalizePeers(this.getPeers()) : [];
    if (!this.allowRemote && ((input.peerId ?? input.context?.peerId) || (input.remote && !input.remote.peerId.startsWith("local-")))) p.fail("GROUP_HOST_REMOTE_DISABLED");
    if (input.remote) {
      let peer = peers.find(value => value.id === input.remote.peerId);
      if (!peer && input.remote.peerId.startsWith("local-")) peer = await this.#local(input.backendId, input.agentId);
      if (!peer || peer.backendId !== input.backendId || peer.agentId !== input.agentId || peer.hostId !== input.remote.hostId) p.fail("GROUP_HOST_IDENTITY_MISMATCH");
      return peer;
    }
    const wanted = input.peerId ?? input.context?.peerId ?? null;
    if (wanted) {
      const peer = peers.find(value => value.id === wanted && value.backendId === input.backendId && value.agentId === input.agentId);
      if (!peer) p.fail("GROUP_HOST_IDENTITY_MISMATCH");
      return peer;
    }
    return this.#local(input.backendId, input.agentId);
  }
  async #request(peer, method, params, authority) {
    if (this.closed) p.fail("GROUP_HOST_UNAVAILABLE");
    return peer.local ? peer.local.dispatch({ version: p.VERSION, id: crypto.randomUUID(), hostId: peer.hostId, method, params, authority })
      : this.request(peer, method, params, authority);
  }
  async #tools(peer, authority) {
    if (!this.invokeTool || this.pollingTools.has(peer.id) || peer.local) return;
    this.pollingTools.add(peer.id);
    try {
      const { calls } = await this.#request(peer, "host.tools.next", {}, authority);
      for (const call of calls) {
        let result;
        try {
          result = await this.invokeTool({ ...call, identity: { backendId: peer.backendId, agentId: peer.agentId,
            execution: call.execution, hostId: peer.hostId, peerId: peer.id, ownerId: authority.ownerId, epoch: authority.epoch } });
        } catch (error) {
          if (["MCP_TOOL_FORBIDDEN", "MCP_TOOL_ARGUMENTS_INVALID"].includes(error?.code)) result = { ok: false, code: error.code };
          else continue; // A disconnected Service leaves the same call pending; its next delivery keeps the same id.
        }
        await this.#request(peer, "host.tools.result", { callId: call.callId, fingerprint: call.fingerprint, result }, authority);
      }
    } finally { this.pollingTools.delete(peer.id); }
  }
  async capabilities(input) {
    const peer = await this.#peer(input);
    if (!peer) return this.localRunner.capabilities?.(input) ?? { groupTools: false };
    const value = await this.#request(peer, "host.capabilities", { backendId: input.backendId, agentId: input.agentId }, null);
    if (value.hostId !== peer.hostId || value.backendId !== peer.backendId || value.agentId !== peer.agentId) p.fail("GROUP_HOST_IDENTITY_MISMATCH");
    return value.capabilities ?? require("./agent-service/group-capabilities").groupCapabilities({ groupTools: value.groupTools,
      workspaces: value.workspaces, artifacts: value.artifacts, source: "legacy-host" });
  }
  async testPeer(peer) {
    if (!this.allowRemote) p.fail("GROUP_HOST_REMOTE_DISABLED");
    if (!p.validPeer(peer)) p.fail("GROUP_HOST_CONFIG_INVALID");
    return this.request(peer, "host.capabilities", { backendId: peer.backendId, agentId: peer.agentId }, null);
  }
  async members() {
    if (!this.allowRemote) return { members: [] };
    return { members: await Promise.all(p.normalizePeers(this.getPeers()).map(async peer => {
      try {
        const [member, capability] = await Promise.all([this.#request(peer, "host.member", { backendId: peer.backendId, agentId: peer.agentId }, null),
          this.#request(peer, "host.capabilities", { backendId: peer.backendId, agentId: peer.agentId }, null)]);
        return { peerId: peer.id, backendId: peer.backendId, agentId: peer.agentId, name: member.agent.name, connected: true, groupTools: capability.groupTools };
      } catch { return { peerId: peer.id, backendId: peer.backendId, agentId: peer.agentId, name: peer.agentId, connected: false, groupTools: false }; }
    })) };
  }
  async member(input) {
    const peer = await this.#peer(input);
    if (!peer) p.fail("GROUP_HOST_IDENTITY_MISMATCH");
    return this.#request(peer, "host.member", { backendId: peer.backendId, agentId: peer.agentId }, null);
  }
  async models(input) {
    const peer = await this.#peer(input);
    const value = peer ? await this.#request(peer, "host.models", { backendId: peer.backendId, agentId: peer.agentId }, null)
      : await this.registry.getBackend(input.backendId).getGroupMemberModels(input.agentId);
    return require("./group-member-model").assertModelCatalog(value);
  }
  async role(input) {
    const peer = await this.#peer(input);
    if (!peer) p.fail("GROUP_HOST_IDENTITY_MISMATCH");
    return this.#request(peer, "host.role", { digest: input.digest, offset: input.offset }, null);
  }
  async prepare(input) {
    const peer = await this.#peer(input);
    if (!peer || !input.context) return this.localRunner.prepare(input);
    const { context, ...execution } = input;
    const prepared = await this.#request(peer, "host.prepare", { execution, kind: context.kind, taskId: context.taskId }, context.authority);
    return { hostId: prepared.hostId, binding: prepared.binding, isolation: prepared.isolation, resource: prepared.resource,
      remote: { peerId: peer.id, hostId: peer.hostId, ...context.authority } };
  }
  async #action(method, input) {
    const { stopGroup, ...bound } = input;
    if (!input.remote) {
      if (method === "cancel" && stopGroup) {
        const result = await this.localRunner.cancel({ ...bound, hostId: this.localRunner.hostId }, { groupDeleted: true });
        return { ...result, groupStopped: require("./external-inspiration-protocol").EXTERNAL_TERMINAL.has(result.snapshot.status) };
      }
      return this.localRunner[method](bound);
    }
    const peer = await this.#peer(input);
    const { remote, ...execution } = bound;
    const authority = { groupId: remote.groupId, ownerId: remote.ownerId, epoch: remote.epoch };
    if (method === "cancel" && stopGroup) await this.#request(peer, "host.group.stop", {}, authority);
    const wire = method === "get" ? "host.execution" : `group.external.${method}`;
    const result = await this.#request(peer, wire, execution, authority);
    if (method === "get" || method === "start") void this.#tools(peer, authority).catch(() => {});
    if (method === "cancel" && stopGroup) {
      const stopped = await this.#request(peer, "host.group.stop", {}, authority);
      return { ...result, groupStopped: stopped.pending === 0 };
    }
    return result;
  }
  start(input) { return this.#action("start", input); }
  get(input) { return this.#action("get", input); }
  respond(input) { return this.#action("respond", input); }
  cancel(input) { return this.#action("cancel", input); }
  draft(input) { return this.#action("draft", input); }
  activity(input) { return this.#action("activity", input); }
  result(input) { return this.#action("result", input); }
  metadata(input) { return this.#action("metadata", input); }
  async artifact(input) {
    if (!input.execution.remote) {
      if (!await this.isLocal(input.execution)) return { artifact: null };
      const record = this.localRunner.records?.get(input.execution.executionId);
      if (!record || ["runId", "agentId", "backendId"].some(key => record.identity[key] !== input.execution[key])
        || ["workspace", "sessionKey", "mode"].some(key => record.binding[key] !== input.execution[key])) return { artifact: null };
      const key = `${input.execution.executionId}:${input.path}:${input.digest ?? "current"}`;
      let cached = this.legacyArtifacts.get(key);
      if (!cached) {
        if (path.isAbsolute(input.path) || input.path.split(/[\\/]/u).includes("..")) return { artifact: null };
        try {
          const root = fs.realpathSync(input.execution.workspace), target = fs.realpathSync(path.resolve(root, input.path));
          if (!target.startsWith(`${root}${path.sep}`)) return { artifact: null };
          const stat = fs.statSync(target); if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return { artifact: null };
          const content = fs.readFileSync(target), digest = crypto.createHash("sha256").update(content).digest("hex");
          if (input.digest && input.digest !== digest) return { artifact: null };
          cached = { path: path.relative(root, target), digest, bytes: content.length, content };
          if (this.legacyArtifacts.size >= 32) this.legacyArtifacts.delete(this.legacyArtifacts.keys().next().value);
          this.legacyArtifacts.set(key, cached);
        } catch { return { artifact: null }; }
      }
      if (input.offset > cached.bytes) return { artifact: null };
      const end = Math.min(cached.bytes, input.offset + 16 * 1024);
      return { artifact: { path: cached.path, digest: cached.digest, bytes: cached.bytes, offset: input.offset,
        nextOffset: end === cached.bytes ? null : end, content: cached.content.subarray(input.offset, end).toString("base64") } };
    }
    const peer = await this.#peer(input.execution);
    const { remote, ...execution } = input.execution;
    return this.#request(peer, "host.artifact", { ...input, execution }, { groupId: remote.groupId, ownerId: remote.ownerId, epoch: remote.epoch });
  }
  async reset() {
    this.closed = true; this.localRunner.reset();
    await Promise.all([...this.localHosts.values()].map(peer => peer.local.close()));
    this.localHosts.clear(); this.pollingTools.clear();
  }
}

module.exports = { GroupRuntimeRouter };
