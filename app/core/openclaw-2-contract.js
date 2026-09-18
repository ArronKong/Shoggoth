"use strict";

const { compareVersions } = require("./version-checker");

const MIN_OPENCLAW_VERSION = "2026.8.1";

function contractError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string" && item.length > 0))];
}

function assertSupportedOpenClawHello(hello) {
  const validShape =
    hello &&
    typeof hello === "object" &&
    hello.type === "hello-ok" &&
    Number.isInteger(hello.protocol) &&
    typeof hello.server?.version === "string" &&
    hello.server.version.trim() &&
    Array.isArray(hello.features?.methods) &&
    Array.isArray(hello.features?.events) &&
    typeof hello.auth?.role === "string" &&
    Array.isArray(hello.auth?.scopes) &&
    Number.isInteger(hello.policy?.maxPayload) &&
    Number.isInteger(hello.policy?.maxBufferedBytes);
  if (!validShape) {
    throw contractError(
      "OPENCLAW_HELLO_INVALID",
      "OpenClaw gateway returned an invalid 2026.8.1 hello response",
    );
  }

  const version = hello.server.version.trim();
  const comparison = compareVersions(version, MIN_OPENCLAW_VERSION);
  if (comparison == null) {
    throw contractError(
      "OPENCLAW_HELLO_INVALID",
      "OpenClaw gateway returned an unrecognized server version",
    );
  }
  if (comparison < 0) {
    throw contractError(
      "OPENCLAW_VERSION_UNSUPPORTED",
      `OpenClaw ${MIN_OPENCLAW_VERSION} or newer is required`,
      { currentVersion: version, minimumVersion: MIN_OPENCLAW_VERSION },
    );
  }
  return hello;
}

// Project only the negotiated fields the browser needs. In particular, never
// forward auth.deviceToken, the presence/health snapshot, filesystem paths, or
// the gateway connection id from the authenticated hello response.
function sanitizeOpenClawHello(hello) {
  assertSupportedOpenClawHello(hello);
  const safe = {
    protocol: hello.protocol,
    server: { version: hello.server.version.trim() },
    features: {
      methods: stringList(hello.features.methods),
      events: stringList(hello.features.events),
      capabilities: stringList(hello.features.capabilities),
    },
    auth: {
      role: hello.auth.role,
      scopes: stringList(hello.auth.scopes),
    },
    policy: {
      maxPayload: hello.policy.maxPayload,
      maxBufferedBytes: hello.policy.maxBufferedBytes,
    },
  };

  if (typeof hello.server.buildId === "string" && hello.server.buildId) {
    safe.server.buildId = hello.server.buildId;
  }
  const attachments = hello.policy.attachments;
  if (
    attachments &&
    Number.isInteger(attachments.maxBytes) &&
    Number.isInteger(attachments.maxImageBytes)
  ) {
    safe.policy.attachments = {
      maxBytes: attachments.maxBytes,
      maxImageBytes: attachments.maxImageBytes,
    };
  }
  const visibilities = stringList(hello.policy.allowedSessionVisibilities);
  if (visibilities.length) safe.policy.allowedSessionVisibilities = visibilities;
  return safe;
}

function hasGatewayMethod(hello, method) {
  return typeof method === "string" && stringList(hello?.features?.methods).includes(method);
}

function hasGatewayEvent(hello, event) {
  return typeof event === "string" && stringList(hello?.features?.events).includes(event);
}

function hasGatewayScope(hello, scope) {
  return typeof scope === "string" && stringList(hello?.auth?.scopes).includes(scope);
}

function hasGatewayCapability(hello, capability) {
  return (
    typeof capability === "string" &&
    stringList(hello?.features?.capabilities).includes(capability)
  );
}

module.exports = {
  MIN_OPENCLAW_VERSION,
  assertSupportedOpenClawHello,
  sanitizeOpenClawHello,
  hasGatewayMethod,
  hasGatewayEvent,
  hasGatewayScope,
  hasGatewayCapability,
};
