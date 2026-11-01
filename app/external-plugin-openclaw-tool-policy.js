"use strict";

const MAX_LIST = 1024;
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,127}$/u;

function invalid(message) {
  throw new Error(`OpenClaw tool grant snapshot invalid: ${message}`);
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) invalid(label);
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).some(key => typeof key !== "string"
    || !Object.hasOwn(fields[key], "value") || !fields[key].enumerable)) invalid(label);
  return value;
}

function jsonValue(value, depth = 0) {
  if (depth > 32) invalid("roster depth");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid("roster number");
    return;
  }
  if (typeof value === "string") {
    if (!value.isWellFormed() || value.includes("\0")) invalid("roster string");
    return;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1) invalid("roster array");
    for (let index = 0; index < value.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (!entry || !Object.hasOwn(entry, "value") || !entry.enumerable) invalid("roster array");
      jsonValue(entry.value, depth + 1);
    }
    return;
  }
  record(value, "roster object");
  for (const child of Object.values(value)) jsonValue(child, depth + 1);
}

function list(value, label) {
  if (!Array.isArray(value) || value.length > MAX_LIST) invalid(label);
  jsonValue(value);
  if (value.some(item => typeof item !== "string" || !item.trim() || item.length > 128)) invalid(label);
  return value;
}

function append(existing, names) {
  const next = [...existing];
  for (const name of names) if (!next.includes(name)) next.push(name);
  if (next.length > MAX_LIST) invalid("grant list capacity");
  return next;
}

/**
 * Plan additive official-CLI writes; the caller must apply and verify each CAS.
 * An Agent's own alsoAllow (including []) shadows the global profile grant.
 * Keep absent overrides absent, and replace a changed roster atomically rather
 * than writing an array index whose Agent may have changed since discovery.
 */
function planOpenClawToolGrants(options) {
  record(options, "options");
  const { globalAlsoAllow, agentEntries, agentList, toolNames } = options;
  list(toolNames, "tool names");
  if (toolNames.length === 0 || toolNames.some(name => !TOOL_NAME.test(name))) invalid("tool names");
  if (agentEntries !== undefined && agentList !== undefined) invalid("ambiguous Agent roster");
  if (globalAlsoAllow !== undefined) list(globalAlsoAllow, "global alsoAllow");

  const operations = [];
  const previousGlobal = globalAlsoAllow ?? [];
  const nextGlobal = append(previousGlobal, toolNames);
  if (JSON.stringify(nextGlobal) !== JSON.stringify(previousGlobal)) operations.push({
    path: "tools.alsoAllow", value: nextGlobal,
    ...(globalAlsoAllow === undefined ? { expectAbsent: true } : { expectedValue: [...globalAlsoAllow] }),
    replace: false,
  });

  const roster = agentEntries !== undefined ? agentEntries : agentList;
  if (roster === undefined) return operations;
  jsonValue(roster);
  const entries = agentEntries !== undefined
    ? Object.entries(record(agentEntries, "agents.entries"))
    : Array.isArray(agentList) ? agentList.map(entry => [entry?.id, entry]) : invalid("agents.list");
  if (entries.length > MAX_LIST) invalid("Agent roster capacity");
  const seen = new Set();
  for (const [id, entry] of entries) {
    if (typeof id !== "string" || !AGENT_ID.test(id) || seen.has(id)) invalid("Agent id");
    seen.add(id);
    record(entry, "Agent entry");
    if (Object.hasOwn(entry, "id") && entry.id !== id) invalid("Agent id differs from key");
    if (!Object.hasOwn(entry, "tools")) continue;
    record(entry.tools, "Agent tools");
    if (Object.hasOwn(entry.tools, "alsoAllow")) list(entry.tools.alsoAllow, "Agent alsoAllow");
  }

  const nextRoster = JSON.parse(JSON.stringify(roster));
  let changed = false;
  for (const [id, entry] of entries) {
    if (!entry.tools || !Object.hasOwn(entry.tools, "alsoAllow")) continue;
    const next = append(entry.tools.alsoAllow, toolNames);
    if (JSON.stringify(next) === JSON.stringify(entry.tools.alsoAllow)) continue;
    const target = agentEntries !== undefined ? nextRoster[id] : nextRoster.find(item => item.id === id);
    target.tools.alsoAllow = next;
    changed = true;
  }
  if (changed) operations.push({
    path: agentEntries !== undefined ? "agents.entries" : "agents.list",
    value: nextRoster, expectedValue: JSON.parse(JSON.stringify(roster)), replace: true,
  });
  return operations;
}

module.exports = { planOpenClawToolGrants };
