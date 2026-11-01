"use strict";
try { require("./connector-package-checks.cjs").checkPublicConnectorRelease(); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
