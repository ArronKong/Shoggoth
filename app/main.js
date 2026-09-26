"use strict";

// 旧入口仅作源码兼容；正式 package 入口由 bootstrap 按进程角色分派。
const selected = require("./desktop-data-bootstrap").prepareDesktopData(require("electron").app);
module.exports = selected ? require("./ui-entry") : null;
