"use strict";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === "string" && UUID.test(value);
function validAuthority(value) {
  return exact(value, ["groupId", "ownerId", "epoch"]) && uuid(value.groupId) && uuid(value.ownerId)
    && Number.isSafeInteger(value.epoch) && value.epoch > 0;
}
function validRemoteBinding(value) {
  return exact(value, ["peerId", "hostId", "groupId", "ownerId", "epoch"])
    && typeof value.peerId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.peerId)
    && uuid(value.hostId) && validAuthority({ groupId: value.groupId, ownerId: value.ownerId, epoch: value.epoch });
}
function validPreparationContext(value) {
  return exact(value, ["authority", "kind", "taskId", ...(Object.hasOwn(value ?? {}, "peerId") ? ["peerId"] : [])])
    && (value.peerId === undefined || value.peerId === null || typeof value.peerId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.peerId)) && validAuthority(value.authority)
    && ["turn", "task"].includes(value.kind) && (value.kind === "turn" ? value.taskId === null : uuid(value.taskId));
}
function validIsolation(value) {
  if (value === null) return true;
  const fields = ["repoRoot", "dir", "branch", "base", "workspace", "relativeDir", "sealed", "committed", "commit", "changedFiles", "failed", "error"];
  return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => fields.includes(key))
    && ["repoRoot", "dir", "workspace", "base", "relativeDir"].every(key => typeof value[key] === "string"
      && value[key].isWellFormed() && !value[key].includes("\0") && value[key].length <= 4096)
    && (value.branch === null || typeof value.branch === "string" && /^shoggoth-group\/[A-Za-z0-9-]+$/u.test(value.branch))
    && (value.commit === undefined || value.commit === null || /^[a-f0-9]{40,64}$/u.test(value.commit))
    && (value.sealed === undefined || typeof value.sealed === "boolean") && (value.failed === undefined || typeof value.failed === "boolean");
}

function validResource(value) {
  return value === null || exact(value, ["key", "isolation"]) && typeof value.key === "string" && /^[a-f0-9]{64}$/u.test(value.key)
    && typeof value.isolation === "boolean";
}

module.exports = { validResource, validAuthority, validRemoteBinding, validPreparationContext, validIsolation };
