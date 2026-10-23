"use strict";

// Shoggoth-owned, deliberately narrow Graph reads. These are not Codex
// managed-connector contracts and do not imply compatibility with connector_*.
const { serviceError } = require("./security");

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const MAIL_SELECT = "id,subject,receivedDateTime,sender,isRead";
const TOP = 20;
const MAX_RESULT_BYTES = 40 * 1024;
const MAX_ITEM_FIELDS_BYTES = 8 * 1024;
const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9.,_-]{0,319}$/u;
const LIST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const SHAREPOINT_ITEMS_TOOL = "sharepoint_list_items";
const SHAREPOINT_ITEM_FIELDS_TOOL = "sharepoint_item_fields";
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;
const PLAIN = value => value !== null && typeof value === "object"
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const pathSegment = (value, pattern) => typeof value === "string"
  && value !== "." && value !== ".." && pattern.test(value);

const CAPABILITIES = Object.freeze({
  "outlook-email": Object.freeze({
    scope: "Mail.ReadBasic", toolName: "outlook_email_list",
    description: "List recent mail metadata, without message bodies or attachments.",
    account: "work-school-or-personal",
    docs: "https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0",
  }),
  sharepoint: Object.freeze({
    scope: "Sites.Read.All", toolName: "sharepoint_site_lists",
    description: "List metadata for lists in a specified SharePoint site.",
    account: "work-school-only",
    docs: "https://learn.microsoft.com/en-us/graph/api/list-list?view=graph-rest-1.0",
  }),
  teams: Object.freeze({
    scope: "Chat.ReadBasic", toolName: "teams_chats_list",
    description: "List the signed-in user's Teams chat metadata, without messages.",
    account: "work-school-only",
    docs: "https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0",
  }),
});

function fail(code = "MICROSOFT_GRAPH_INPUT_INVALID") {
  throw serviceError(code, "Microsoft Graph 只读能力请求无效或未授权");
}

function capabilityFor(packageId) {
  const capability = CAPABILITIES[packageId];
  if (!capability || !Object.hasOwn(CAPABILITIES, packageId)) fail();
  return capability;
}

function text(value, max = 512) {
  return typeof value === "string" && value.length <= max && !CONTROL.test(value) ? value : null;
}

function operationFor(packageId, toolName) {
  const capability = capabilityFor(packageId);
  if (toolName === undefined || toolName === capability.toolName) return "collection";
  if (packageId === "sharepoint" && toolName === SHAREPOINT_ITEMS_TOOL) return "items";
  if (packageId === "sharepoint" && toolName === SHAREPOINT_ITEM_FIELDS_TOOL) return "fields";
  fail();
}

function listRequest(packageId, input, toolName) {
  const operation = operationFor(packageId, toolName);
  if (!PLAIN(input)) fail();
  const keys = Reflect.ownKeys(input);
  let pathname;
  const query = new URLSearchParams();
  if (packageId === "sharepoint") {
    const expectedKeys = operation === "fields"
      ? ["siteId", "listId", "itemId", "fieldNames"]
      : operation === "items" ? ["siteId", "listId"] : ["siteId"];
    // The IDs are emitted as URL path segments. A dot-only segment would be
    // normalized by URL(), so reject it even though the character is allowed.
    if (!pathSegment(input.siteId, SITE_ID)
      || keys.length !== expectedKeys.length
      || keys.some(key => !expectedKeys.includes(key))) fail();
    if (operation !== "collection") {
      if (!pathSegment(input.listId, LIST_ID)) fail();
      pathname = `/v1.0/sites/${input.siteId}/lists/${input.listId}/items`;
      if (operation === "fields") {
        if (!pathSegment(input.itemId, LIST_ID) || !Array.isArray(input.fieldNames)
          || input.fieldNames.length < 1 || input.fieldNames.length > 8
          || new Set(input.fieldNames).size !== input.fieldNames.length
          || input.fieldNames.some(name => typeof name !== "string" || !FIELD_NAME.test(name))) fail();
        pathname += `/${input.itemId}`;
        query.set("expand", `fields(select=${input.fieldNames.join(",")})`);
      }
    } else pathname = `/v1.0/sites/${input.siteId}/lists`;
  } else {
    if (keys.length !== 0) fail();
    pathname = packageId === "outlook-email" ? "/v1.0/me/messages" : "/v1.0/me/chats";
    query.set("$top", String(TOP));
    if (packageId === "outlook-email") query.set("$select", MAIL_SELECT);
  }
  const url = new URL(pathname, GRAPH_ORIGIN);
  url.search = query.toString();
  return url.href;
}

function projectRow(packageId, value, operation) {
  if (!PLAIN(value) || !text(value.id) || !value.id) fail("MICROSOFT_GRAPH_REMOTE_FAILED");
  if (operation === "items") {
    return { id: value.id, name: text(value.name, 512),
      createdDateTime: text(value.createdDateTime, 64),
      lastModifiedDateTime: text(value.lastModifiedDateTime, 64) };
  }
  if (packageId === "outlook-email") {
    return { id: value.id, subject: text(value.subject, 1024),
      receivedDateTime: text(value.receivedDateTime, 64),
      sender: { name: text(value.sender?.emailAddress?.name, 256),
        address: text(value.sender?.emailAddress?.address, 320) },
      isRead: value.isRead === true };
  }
  if (packageId === "sharepoint") {
    return { id: value.id, name: text(value.name, 512),
      displayName: text(value.displayName, 512),
      lastModifiedDateTime: text(value.lastModifiedDateTime, 64),
      template: text(value.list?.template, 128) };
  }
  return { id: value.id, chatType: text(value.chatType, 64),
    topic: text(value.topic, 512), createdDateTime: text(value.createdDateTime, 64),
    lastUpdatedDateTime: text(value.lastUpdatedDateTime, 64) };
}

function projectList(packageId, value, toolName, input) {
  const operation = operationFor(packageId, toolName);
  if (operation === "fields") {
    listRequest(packageId, input, toolName);
    // The query selects exact column names, but the remote response is still
    // untrusted. Never return additional fields, nested values or a mismatch.
    if (!PLAIN(value) || value.id !== input?.itemId || !PLAIN(value.fields)) {
      fail("MICROSOFT_GRAPH_REMOTE_FAILED");
    }
    const fields = Object.fromEntries(input.fieldNames.map(name => {
      if (!Object.hasOwn(value.fields, name)) fail("MICROSOFT_GRAPH_REMOTE_FAILED");
      const field = value.fields[name];
      if (field !== null && typeof field !== "boolean"
        && !(typeof field === "number" && Number.isFinite(field))
        && !(typeof field === "string" && Buffer.byteLength(field, "utf8") <= 1024
          && !CONTROL.test(field))) fail("MICROSOFT_GRAPH_REMOTE_FAILED");
      return [name, field];
    }));
    const result = { id: value.id, fields };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_ITEM_FIELDS_BYTES) {
      fail("MICROSOFT_GRAPH_REMOTE_FAILED");
    }
    return result;
  }
  // Graph's list/listItem endpoints do not document a portable $top/$select
  // contract. The broker bounds the first HTTP body; keep at most TOP projected
  // rows and never follow a provider-supplied nextLink.
  if (!PLAIN(value) || !Array.isArray(value.value) || value.value.length > 1000
    || value["@odata.nextLink"] !== undefined
      && (typeof value["@odata.nextLink"] !== "string" || value["@odata.nextLink"].length > 4096)) {
    fail("MICROSOFT_GRAPH_REMOTE_FAILED");
  }
  const items = [];
  for (const row of value.value.slice(0, TOP)) {
    const projected = projectRow(packageId, row, operation);
    if (Buffer.byteLength(JSON.stringify([...items, projected]), "utf8") > MAX_RESULT_BYTES) {
      return { items, truncated: true };
    }
    items.push(projected);
  }
  return { items, truncated: value.value.length > TOP || value["@odata.nextLink"] !== undefined };
}

module.exports = { CAPABILITIES, SHAREPOINT_ITEMS_TOOL, SHAREPOINT_ITEM_FIELDS_TOOL,
  capabilityFor, listRequest, projectList };
