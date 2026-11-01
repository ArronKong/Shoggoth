#!/usr/bin/env node
"use strict";
// Seven deterministic crash windows for every requested lifecycle round.
process.argv.push("--suite=lifecycle");
require("./generic-acp-recovery-soak.cjs");
