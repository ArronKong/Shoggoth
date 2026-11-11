"use strict";

// Maintainer-owned release gate, NOT a user preference. Keep disabled until the
// distribution review and native candidate checks are complete.
// Only a public phc_ project token may be embedded; never a personal/secret key.
// No environment variables, config.json, renderer IPC or remote flags override it.
module.exports = Object.freeze({
  exportEnabled: false,
  projectToken: "",
  region: "us",
  revision: 2,
});
