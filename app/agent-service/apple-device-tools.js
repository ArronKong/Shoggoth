"use strict";

const { TOOL_OPERATIONS, TOOL_INPUT_SCHEMAS, isWriteOperation, validateAppleDeviceOperationParams } = require("../core/apple-device-contract");
const DESCRIPTIONS = Object.freeze({
  apple_calendar_list: "List calendars on this Mac after the current Calendar reading policy is checked. Connect Apple Calendar in Connectors > Your devices first. Returns opaque calendar IDs and whether they permit changes.",
  apple_calendar_events: "Read events in an explicit ISO time interval (maximum 366 days) from this Mac. Optional calendarIds filter and limit 1..100. Inspect truncated before claiming completeness. Every invocation follows this assistant's current reading policy.",
  apple_calendar_get: "Read one event by its exact opaque ID. Returns its revision and recurring state; use that revision for a later update or deletion under the current Calendar writing policy.",
  apple_calendar_create: "Create one event on this Mac under the current Calendar writing policy: Allow executes, Ask requires approval for this exact write, Off refuses. Times require explicit ISO timezone; optional calendarId selects the destination. Returns only the event ID and revision; content requires a separate permitted read. Do not retry an unknown outcome automatically.",
  apple_calendar_update: "Update an event under the current Calendar writing policy; Ask requires approval of this exact change. First read its expectedRevision. Choose scope=this for one occurrence or future for this and later occurrences; patch contains only changed fields. A stale revision is rejected. Returns only the event ID and revision; content requires a separate permitted read.",
  apple_calendar_delete: "Delete an event under the current Calendar writing policy; Ask requires approval of this exact deletion. First read expectedRevision and explicitly choose scope=this or future. Do not retry an unknown outcome automatically.",
  apple_reminders_lists: "List reminder lists on this Mac after the current Reminders reading policy is checked. Connect Apple Reminders in Connectors > Your devices first. Returns opaque list IDs and whether they permit changes.",
  apple_reminders_search: "Read reminders on this Mac, optionally filtered by listIds and completed. limit is 1..100; inspect truncated before claiming completeness. Every invocation follows this assistant's current reading policy.",
  apple_reminders_get: "Read one reminder by exact opaque ID, including its current revision. Use that revision for a later change or deletion under the current Reminders writing policy.",
  apple_reminders_create: "Create one reminder under the current Reminders writing policy: Allow executes, Ask requires approval for this exact write, Off refuses. Optional listId selects the list; due is an ISO timestamp with timezone or null. Returns only the reminder ID and revision; content requires a separate permitted read. Do not retry an unknown outcome automatically.",
  apple_reminders_update: "Update a reminder under the current Reminders writing policy; Ask requires approval of this exact change. Requires a matching expectedRevision. Set patch.completed=true to complete it, false to reopen it; due=null removes its due date. Returns only the reminder ID and revision; content requires a separate permitted read.",
  apple_reminders_delete: "Delete one reminder under the current Reminders writing policy; Ask requires approval of this exact deletion. Requires a matching expectedRevision. Do not retry an unknown outcome automatically.",
});
const TOOL_DEFINITIONS = Object.freeze(Object.entries(TOOL_OPERATIONS).map(([name]) => Object.freeze({ name, description: DESCRIPTIONS[name], inputSchema: TOOL_INPUT_SCHEMAS[name] })));
const TOOL_CAPABILITIES = Object.freeze(Object.entries(TOOL_OPERATIONS).map(([tool, operation]) => Object.freeze({ tool,
  domain: operation.split(".")[0], feature: operation.split(".")[1], risk: isWriteOperation(operation) ? "confirm" : "read", description: DESCRIPTIONS[tool] })));
const isAppleDeviceTool = name => Object.hasOwn(TOOL_OPERATIONS, name);
function validateAppleDeviceArguments(name, args) {
  if (!isAppleDeviceTool(name)) return false;
  try { validateAppleDeviceOperationParams(TOOL_OPERATIONS[name], args); return true; } catch { return false; }
}
module.exports = { TOOL_DEFINITIONS, TOOL_CAPABILITIES, isAppleDeviceTool, validateAppleDeviceArguments,
  APPLE_DEVICE_TOOL_DEFINITIONS: TOOL_DEFINITIONS, APPLE_DEVICE_TOOL_CAPABILITIES: TOOL_CAPABILITIES,
  APPLE_DEVICE_WRITE_TOOLS: Object.keys(TOOL_OPERATIONS).filter(name => isWriteOperation(TOOL_OPERATIONS[name])) };
