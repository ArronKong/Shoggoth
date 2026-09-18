"use strict";

// Only the trusted application shell receives this policy. Widgets and Board
// documents have their own stricter, independent response policies.
const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: https:",
  "connect-src 'self' ws://127.0.0.1:*",
  "frame-src 'self' http://127.0.0.1:* blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

module.exports = { UI_CONTENT_SECURITY_POLICY };
