#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { validSlackUserScopes } = require("../app/agent-service/plugin-slack-oauth");
const { LEGACY_COMPONENT, FULL_COMPONENT, PUBLIC_SCOPES, READ_SCOPES, FULL_SCOPES,
  PROFILES, slackAccessProfile, slackToolRequiresEachCall, slackToolAccess } =
  require("../app/agent-service/plugin-slack-access-policy");
const access = (toolName, scopes = FULL_SCOPES, componentName = FULL_COMPONENT) =>
  slackToolAccess({ componentName, scopes, toolName });

test("three explicit profiles use only official user scopes; ordering cannot change selected authority", () => {
  assert.equal(FULL_SCOPES.length, 30);
  for (const profile of PROFILES) {
    assert.equal(Object.isFrozen(profile), true); assert.equal(Object.isFrozen(profile.scopes), true);
    assert.equal(validSlackUserScopes(profile.scopes), true);
    assert.strictEqual(slackAccessProfile([...profile.scopes].reverse()), profile);
  }
  for (const scopes of [[], null, ["chat:write"], ["search:read.public", "chat:write"],
    [...FULL_SCOPES, "admin"], [...PUBLIC_SCOPES, ...PUBLIC_SCOPES], ["SEARCH:READ.PUBLIC"]]) {
    assert.equal(slackAccessProfile(scopes), null);
    assert.deepEqual(access("slack_send_message", scopes), { allowed: false, requiresEachCall: false });
  }
});

test("legacy component cannot inherit expanded scopes or read/write tools", () => {
  assert.deepEqual(access("slack_search_public", FULL_SCOPES, LEGACY_COMPONENT),
    { allowed: true, requiresEachCall: false });
  for (const name of ["slack_search_public_and_private", "slack_read_channel", "slack_send_message",
    "slack_get_file_upload_url", "slack_create_canvas", "slack_unknown_action"]) {
    assert.deepEqual(access(name, FULL_SCOPES, LEGACY_COMPONENT),
      { allowed: false, requiresEachCall: false });
  }
});

test("public search cannot inherit private histories, files or account email", () => {
  assert.equal(access("slack_search_public", PUBLIC_SCOPES).allowed, true);
  for (const name of ["slack_search_public_and_private", "slack_read_channel", "slack_read_thread",
    "slack_read_file", "slack_read_user_profile", "slack_list_channel_members"]) {
    assert.equal(access(name, PUBLIC_SCOPES).allowed, false);
    assert.equal(access(name, READ_SCOPES).allowed, true);
  }
});

test("reviewed writes require an explicitly selected write profile and per-call approval", () => {
  for (const name of ["slack_send_message", "slack_send_message_draft", "slack_schedule_message",
    "slack_add_reaction", "slack_create_canvas", "slack_get_file_upload_url", "slack_complete_file_upload"]) {
    assert.equal(slackToolRequiresEachCall(name), true);
    for (const scopes of [PUBLIC_SCOPES, READ_SCOPES]) assert.equal(access(name, scopes).allowed, false);
    assert.deepEqual(access(name), { allowed: true, requiresEachCall: true });
  }
  assert.equal(slackToolRequiresEachCall("slack_search_public"), false);
});

test("unknown tools remain forbidden even with all scopes and a readOnlyHint claim", () => {
  for (const name of ["slack_unknown_action", "slack_delete_everything", "slack_read_unknown",
    "__proto__", "constructor", "Slack_search_public", "slack_send_message ", "slack_send_message" + "x".repeat(128), null]) {
    const result = slackToolAccess({ componentName: FULL_COMPONENT, scopes: FULL_SCOPES,
      toolName: name, annotations: { readOnlyHint: true } });
    assert.deepEqual(result, { allowed: false, requiresEachCall: false });
  }
});

test("foreign components cannot inherit the official source-pinned tool permissions", () => {
  for (const componentName of ["slack", "local-slack", "shoggoth-slack-official-mcp ", null]) {
    assert.deepEqual(access("slack_search_public", FULL_SCOPES, componentName),
      { allowed: false, requiresEachCall: false });
    assert.deepEqual(access("slack_send_message", FULL_SCOPES, componentName),
      { allowed: false, requiresEachCall: false });
  }
});


test("dispatch permissions require the exact installed component and actual live account scopes", () => {
  const { slackDispatchToolAccess } = require("../app/agent-service/plugin-slack-access-policy");
  const { componentId } = require("../app/agent-service/plugin-component-catalog");
  const installationId = "slack-dispatch-installation";
  const records = { installation: { installationId }, binding: { installationId,
    componentId: componentId(installationId, "mcp-server", FULL_COMPONENT) } };
  assert.equal(slackDispatchToolAccess(records, "slack_send_message", FULL_SCOPES).allowed, true);
  for (const scopes of [null, undefined, PUBLIC_SCOPES, READ_SCOPES]) {
    assert.equal(slackDispatchToolAccess(records, "slack_send_message", scopes).allowed, false);
  }
  for (const changed of [{ ...records, installation: { installationId: "different" } },
    { ...records, binding: { ...records.binding, componentId: "0".repeat(64) } }]) {
    assert.equal(slackDispatchToolAccess(changed, "slack_send_message", FULL_SCOPES).allowed, false);
  }
});
