"use strict";

// The saved value is a policy, not a copy of the Agent's default. Provider is
// part of identity: equal model ids on different endpoints are not equivalent.
const text = value => typeof value === "string" && value.length > 0 && value.isWellFormed()
  && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.byteLength(value) <= 512;
const exact = (value, fields) => !!value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const validModelSelection = value => value === null || exact(value, ["model", "provider"])
  && text(value.model) && (value.provider === null || text(value.provider));
const sameModel = (choice, selection) => !!selection && choice.id === selection.model
  && (choice.provider ?? null) === selection.provider;
const validModelCatalog = value => exact(value, ["models", "defaultModel"])
  && (value.defaultModel === null || text(value.defaultModel)) && Array.isArray(value.models)
  && value.models.length <= 512 && value.models.every(item => exact(item, ["id", "name", "provider"])
    && text(item.id) && text(item.name) && (item.provider === null || text(item.provider)))
  && new Set(value.models.map(item => JSON.stringify([item.provider, item.id]))).size === value.models.length
  // Catalogs cross the 64 KiB private federation frame as well as native IPC.
  && Buffer.byteLength(JSON.stringify(value)) <= 48 * 1024;
const modelError = (code = "GROUP_CHAT_MODEL_UNAVAILABLE") => Object.assign(new Error(code), { code });
const isModelError = code => code === "GROUP_CHAT_MODEL_UNAVAILABLE" || code === "GROUP_CHAT_MODEL_CATALOG_UNAVAILABLE";
function assertModelCatalog(catalog) {
  if (!validModelCatalog(catalog)) throw modelError("GROUP_CHAT_MODEL_CATALOG_UNAVAILABLE");
  return catalog;
}
function assertModelSelection(catalog, selection) {
  if (!validModelSelection(selection)) throw modelError("GROUP_CHAT_INVALID");
  if (selection !== null && !assertModelCatalog(catalog).models.some(item => sameModel(item, selection))) throw modelError();
  return selection;
}

module.exports = { validModelSelection, validModelCatalog, sameModel, modelError, isModelError, assertModelCatalog, assertModelSelection };
