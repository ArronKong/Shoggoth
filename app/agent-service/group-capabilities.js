"use strict";

const CAPABILITY_VERSION = 2;
const FLAGS = ["collaborationSupport", "collaborationBootstrap", "collaborationActions", "groupTools", "discussion", "isolatedSession", "formalTasks", "workspaces", "artifacts",
  "textEvents", "toolEvents", "interactive", "preciseCancel", "statusQuery", "restartRecovery", "steer", "attachments"];
function groupCapabilities(value = {}) {
  return { protocolVersion: Number.isSafeInteger(value.protocolVersion) && value.protocolVersion >= 1
      && value.protocolVersion <= CAPABILITY_VERSION ? value.protocolVersion : 1,
    ...Object.fromEntries(FLAGS.map(key => [key, key === "collaborationBootstrap"
      ? value.collaborationSupport === true && value.collaborationActions !== true : value[key] === true])),
    usage: ["exact", "estimated"].includes(value.usage) ? value.usage : "unknown",
    availability: ["available", "unavailable"].includes(value.availability) ? value.availability : "unknown",
    source: ["native-binding", "external-binding", "legacy-host"].includes(value.source) ? value.source : "unavailable",
    mode: typeof value.mode === "string" ? value.mode : null,
    checkedAt: Number.isSafeInteger(value.checkedAt) && value.checkedAt >= 0 ? value.checkedAt : null };
}
function validGroupCapabilities(value) {
  const keys = ["protocolVersion", ...FLAGS, "usage", "availability", "source", "mode", "checkedAt"];
  return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key)) && Number.isSafeInteger(value.protocolVersion)
    && value.protocolVersion >= 1 && value.protocolVersion <= CAPABILITY_VERSION
    && FLAGS.every(key => typeof value[key] === "boolean") && ["exact", "estimated", "unknown"].includes(value.usage)
    && ["available", "unavailable", "unknown"].includes(value.availability)
    && ["native-binding", "external-binding", "legacy-host", "unavailable"].includes(value.source)
    && (value.mode === null || typeof value.mode === "string" && value.mode.length <= 64)
    && (value.checkedAt === null || Number.isSafeInteger(value.checkedAt) && value.checkedAt >= 0)
    && (!value.collaborationActions || value.groupTools && value.protocolVersion === CAPABILITY_VERSION)
    && value.collaborationBootstrap === (value.collaborationSupport && !value.collaborationActions);
}
function nativeCapabilities(caps, toolProof, { checkedAt = Date.now(), available = true, mode = null } = {}) {
  const isolatedSession = caps?.["session.start"] === true && caps?.["session.resume"] === true;
  const discussion = isolatedSession && caps?.["turn.start"] === true;
  const groupTools = toolProof?.groupTools === true;
  const collaborationActions = groupTools && toolProof?.protocolVersion === CAPABILITY_VERSION
    && toolProof?.collaborationActions === true;
  return groupCapabilities({ protocolVersion: toolProof?.protocolVersion === CAPABILITY_VERSION ? CAPABILITY_VERSION : 1,
    groupTools, collaborationActions, discussion, isolatedSession,
    collaborationSupport: discussion && toolProof?.collaborationSupport === true,
    formalTasks: discussion && groupTools, workspaces: isolatedSession, artifacts: isolatedSession,
    textEvents: caps?.events === true, toolEvents: caps?.events === true,
    interactive: caps?.serverRequests === true, preciseCancel: caps?.["turn.interrupt"] === true,
    statusQuery: caps?.["session.read"] === true, restartRecovery: caps?.["session.read"] === true && isolatedSession,
    steer: caps?.["turn.steer"] === true, attachments: toolProof?.attachments === true,
    usage: caps?.["context.usage.exact"] ? "exact" : caps?.["context.usage.estimated"] ? "estimated" : "unknown",
    availability: available ? "available" : "unavailable", source: "native-binding", mode, checkedAt });
}
// Bootstrap/configuration allows an ordinary first reply, not a report-required
// delegation. Every assigned owner must prove the actual collaboration tools.
function canAssignCollaboration(value) {
  return value?.availability !== "unavailable" && value?.discussion === true && value?.isolatedSession === true
    && value.collaborationActions === true && value.groupTools === true && value.protocolVersion === CAPABILITY_VERSION;
}
function needsCollaborationReport(opportunity) {
  return (opportunity.collaborationItemIds ?? []).some(id => {
    const item = opportunity.collaborationSnapshot?.items.find(value => value.id === id);
    return !item || item.kind !== "request" && !item.directAuthorization;
  });
}
module.exports = { canAssignCollaboration, needsCollaborationReport, CAPABILITY_VERSION, groupCapabilities, nativeCapabilities, validGroupCapabilities };
