#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { syncAdapterContracts } = require("../app/external-plugin-adapter-protocol");

const root = path.join(__dirname, "../resources/external-plugin-adapters");
const problems = syncAdapterContracts(root, { write: !process.argv.includes("--check") });
if (problems.length) throw new Error(problems.join("\n"));
console.log("MCP connector adapter contracts match Service tools");
