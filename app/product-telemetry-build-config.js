"use strict";

// Maintainer-owned release gate, NOT a user preference. Keep disabled until the
// receiving project/region, retention/budget and distribution review are approved.
// Only a public phc_ project token may be embedded; never a personal/secret key.
// No environment variables, config.json, renderer IPC or remote flags override it.
module.exports = Object.freeze({
  exportEnabled: false,
  projectToken: "",
  region: "",
  revision: 1,
});
