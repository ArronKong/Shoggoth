"use strict";

// Bump whenever an exact Service request/result DTO changes incompatibly.
const SERVICE_PROTOCOL_VERSION = 28;

// Preserve the previous 60 KiB history projection plus a 16 KiB round instruction and frame metadata.
const INSPIRATION_HISTORY_MAX_RESPONSE_BYTES = 84 * 1024;

module.exports = { SERVICE_PROTOCOL_VERSION, INSPIRATION_HISTORY_MAX_RESPONSE_BYTES };
