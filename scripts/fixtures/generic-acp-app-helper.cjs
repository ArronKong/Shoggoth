"use strict";
// Only the OS account-home observation is controlled so this source-mode
// acceptance cannot address the user's canonical Service. All bootstrap gate,
// live parent/process identity, HMAC and Service/tool routes remain production.
const path = require("node:path");
const root = path.resolve(__dirname, "../../.."), snapshot = path.join(root, "source"), isolatedHome = path.join(root, "home");
require(path.join(snapshot, "app/background-role-activation")).prepareBackgroundRoleActivation();
const { main } = require(path.join(snapshot, "app/bootstrap-role"));
Promise.resolve(main(process.argv.slice(1), process.env, { defaultApp: true, userInfo: () => ({ homedir: isolatedHome }) }))
  .catch(error => { console.error("[controlled-helper] " + (/^[A-Z0-9_]{1,80}$/u.test(error?.code || "") ? error.code : "HELPER_REJECTED")); process.exitCode = 1; });
