"use strict";

// This fixture retains the production Service, Backend, private App-host socket,
// management REST and runtime binding. Only Apple native data is synthetic.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { startInspirationFixture } = require("./inspiration-service-fixture.cjs");
const { createFederationHostServer } = require("../../app/federation-host-server");
const { createAppleDeviceHost } = require("../../app/apple-device-host");
const { AgentBackend } = require("../../app/core/agent-backend");
const { requestService, readClientToken } = require("../../app/agent-service/client");
const { PROTOCOL_VERSION } = require("../../app/agent-service/server");

const copy = value => JSON.parse(JSON.stringify(value));
const error = code => Object.assign(new Error("Synthetic device " + code), { code });
class ControlledDeviceBackend extends AgentBackend {
  constructor(id, agentId) { super(); this.backendId = id; this.agents = [{ id: agentId, name: "Device fixture " + id, enabled: true }]; this.connected = true; }
  get id() { return this.backendId; }
  get name() { return "Device fixture " + this.id; }
  async getStatus() { return { id: this.id, name: this.name, connected: this.connected, info: {} }; }
  async listAgents() { return copy(this.agents); }
  async getAgent(id) { const agent = this.agents.find(a => a.id === id); if (!agent) throw error("AGENT_NOT_FOUND"); return copy(agent); }
}

function createSyntheticAppleNative() {
  const calls = [], openedSettings = [], events = new Map(), reminders = new Map();
  const authorization = { calendar: "notDetermined", reminders: "notDetermined" };
  let sequence = 0;
  const revise = record => ({ ...record, revision: crypto.createHash("sha256").update(JSON.stringify([++sequence, record])).digest("hex") });
  const calendars = [{ id: "calendar/device-fixture", title: "Fixture calendar", allowsModifications: true, isDefault: true }];
  const lists = [{ id: "list/device-fixture", title: "Fixture reminders", allowsModifications: true, isDefault: true }];
  const addEvent = input => {
    const event = revise({ id: "event/device-fixture/" + (sequence + 1), calendarId: input.calendarId || calendars[0].id,
      title: input.title, start: input.start, end: input.end, allDay: input.allDay ?? false,
      timeZone: input.timeZone || "Asia/Shanghai", notes: input.notes || "", location: input.location || "", recurring: false });
    events.set(event.id, event); return copy(event);
  };
  const addReminder = input => {
    const reminder = revise({ id: "reminder/device-fixture/" + (sequence + 1), listId: input.listId || lists[0].id,
      title: input.title, notes: input.notes || "", due: input.due ?? null, priority: input.priority ?? 0, completed: false });
    reminders.set(reminder.id, reminder); return copy(reminder);
  };
  addEvent({ title: "Initial fixture meeting", start: "2026-10-27T09:00:00+08:00", end: "2026-10-27T10:00:00+08:00" });
  addReminder({ title: "Initial fixture reminder" });
  const state = { calls, openedSettings, events, reminders, authorization, unknownNextWrite: false, queueNextWrite: null,
    count(operation) { return calls.filter(call => call.operation === operation).length; },
    native: { async invoke(operation, params, options = {}) {
      calls.push({ operation, params: copy(params) });
      if (operation === "status") return copy(authorization);
      if (operation === "requestAccess") { authorization[params.resource] = "fullAccess"; return copy(authorization); }
      const resource = operation.split(".")[0];
      if (authorization[resource] !== "fullAccess") throw error("APPLE_DEVICE_PERMISSION_REQUIRED");
      if (/\.(create|update|delete)$/u.test(operation) && state.queueNextWrite) {
        const gate = state.queueNextWrite; state.queueNextWrite = null; gate.signal = options.signal; gate.arrived.resolve();
        await gate.release.promise;
        if (options.signal?.aborted) throw error("APPLE_DEVICE_CANCELED");
      }
      if (options.signal?.aborted) throw error("APPLE_DEVICE_CANCELED");
      if (operation === "calendar.list") return { calendars: copy(calendars) };
      if (operation === "reminders.lists") return { lists: copy(lists) };
      if (operation === "calendar.events") {
        const all = [...events.values()].filter(event => Date.parse(event.end) > Date.parse(params.start) && Date.parse(event.start) < Date.parse(params.end)
          && (!params.calendarIds || params.calendarIds.includes(event.calendarId)));
        return { events: copy(all.slice(0, params.limit || 100)), truncated: all.length > (params.limit || 100) };
      }
      if (operation === "reminders.search") {
        const all = [...reminders.values()].filter(reminder => (params.completed === undefined || reminder.completed === params.completed)
          && (!params.listIds || params.listIds.includes(reminder.listId)));
        return { reminders: copy(all.slice(0, params.limit || 100)), truncated: all.length > (params.limit || 100) };
      }
      const calendar = resource === "calendar", store = calendar ? events : reminders, key = calendar ? "event" : "reminder";
      if (operation.endsWith(".get")) { const record = store.get(params.id); if (!record) throw error("APPLE_DEVICE_NOT_FOUND"); return { [key]: copy(record) }; }
      let result;
      if (operation.endsWith(".create")) result = { [key]: calendar ? addEvent(params) : addReminder(params) };
      else {
        const current = store.get(params.id); if (!current) throw error("APPLE_DEVICE_NOT_FOUND");
        if (current.revision !== params.expectedRevision) throw error("APPLE_DEVICE_CONFLICT");
        if (operation.endsWith(".delete")) { store.delete(params.id); result = { id: params.id, deleted: true }; }
        else if (operation.endsWith(".update")) { const changed = revise({ ...current, ...params.patch }); store.set(params.id, changed); result = { [key]: copy(changed) }; }
        else assert.fail("Unsupported synthetic operation " + operation);
      }
      if (state.unknownNextWrite) { state.unknownNextWrite = false; throw error("APPLE_DEVICE_FAILED"); }
      return result;
    } },
  };
  return state;
}

async function startAppleDeviceServiceFixture() {
  const openclaw = new ControlledDeviceBackend("openclaw", "oc-device-fixture");
  const hermes = new ControlledDeviceBackend("hermes", "hermes-device-fixture");
  const synthetic = createSyntheticAppleNative();
  // The reused fixture creates its root synchronously, before its first await.
  // Capture that exact identity so startup rejection can clean only this run.
  let fixtureRoot, starting;
  const mkdtemp = fs.mkdtempSync;
  fs.mkdtempSync = function (prefix, ...args) { const result = mkdtemp.call(fs, prefix, ...args); if (String(prefix).endsWith("shg-insp-")) fixtureRoot = result; return result; };
  try {
    starting = startInspirationFixture({ groupControlledRuntime: true, extraBackends: [openclaw, hermes], serviceOptions: {
      prewarmMcpAuth: false, autoSparkNotes: false, setCronTimer: () => 1, clearCronTimer() {}, setProactiveTimer: () => 1, clearProactiveTimer() {},
    } });
  } finally { fs.mkdtempSync = mkdtemp; }
  let f;
  try { f = await starting; }
  catch (error) { if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true }); throw error; }
  await f.desktopHost.stop();
  const deviceHost = createFederationHostServer({ paths: f.paths, registry: f.registry,
    appleDeviceHost: createAppleDeviceHost({ native: synthetic.native, openExternal: async url => { synthetic.openedSettings.push(url); } }) });
  try { await deviceHost.start(); }
  catch (error) { await f.close(); throw error; }
  const ipc = (method, params) => requestService(f.paths, { id: crypto.randomUUID(), token: readClientToken(f.paths), version: PROTOCOL_VERSION, method, params });
  let closed = false;
  return { ...f, ipc, synthetic, controlled: { openclaw, hermes },
    async restart() { await f.backend.stop(); await f.service.stop(); await f.service.start(); assert.equal(await f.backend.start(), true); },
    async close() { if (closed) return; closed = true; await deviceHost.stop(); await f.close(); } };
}
module.exports = { startAppleDeviceServiceFixture, createSyntheticAppleNative };
