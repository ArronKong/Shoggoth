"use strict";

// Apply before loading role validators or product modules: parent/code-signature
// checks may block, and rejected helpers never reach their normal ready handler.
require("./background-role-activation").prepareBackgroundRoleActivation();

// Electron 的 package main 不是普通 Node CLI，不能依赖 require.main 判定。
// 正式入口加载即分派；可测试的纯函数放在 bootstrap-role，避免测试误启 UI。
const { bootstrapFailureCode, main } = require("./bootstrap-role");

Promise.resolve()
  .then(main)
  .catch((error) => {
    console.error(`[bootstrap] startup failure: ${bootstrapFailureCode(error)}`);
    try {
      require("electron").app.exit(1);
    } catch {
      process.exit(1);
    }
  });
