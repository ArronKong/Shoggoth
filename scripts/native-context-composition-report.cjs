#!/usr/bin/env node
"use strict";

// Deterministic size report of what Shoggoth itself adds to a native request,
// compiled with the standard context fixture (no model, no user data). Values
// are Shoggoth's local token estimate. Use it to compare before/after changes;
// real CLI totals come from native-context-overhead-measure.cjs.
//
// Usage: node scripts/native-context-composition-report.cjs [--json]

const { contextFixture } = require("./fixtures/shoggoth-context-fixture.cjs");
const { estimateContextTokens } = require("../app/agent-service/conversation-context-budget");
const { splitTurnInstructions } = require("../app/agent-service/native-instruction-delivery");
const { DEFAULT_TOOL_REGISTRY } = require("../app/agent-service/mcp-product-tool-controller");
const { residentToolDefinitions } = require("../app/agent-service/product-tool-exposure");

function toolTokens(definitions) {
  return estimateContextTokens(JSON.stringify(definitions.map(tool => ({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))));
}

function report(runtime = "pi") {
  const f = contextFixture({ runtime });
  try {
    const compiled = f.compiler.compile({ profile: f.profile, run: f.run, transcriptSessionId: f.transcriptSessionId,
      contextLifecycleV1: true, query: "ordinary task" });
    const turn = splitTurnInstructions(compiled.turnDeveloperInstructions);
    const tools = DEFAULT_TOOL_REGISTRY.mcpDefinitions();
    return {
      runtime,
      stableRules: estimateContextTokens(compiled.stableDeveloperInstructions),
      blocks: Object.fromEntries(compiled.blocks.filter(block => ["policy", "rules", "tools", "identity", "soul"]
        .includes(block.kind)).map(block => [block.id, block.estimatedTokens])),
      turnRules: estimateContextTokens(turn.rules),
      runLine: estimateContextTokens(turn.run),
      productTools: { count: tools.length, tokens: toolTokens(tools) },
      residentTools: { count: residentToolDefinitions(tools).length, tokens: toolTokens(residentToolDefinitions(tools)) },
    };
  } finally { f.cleanup(); }
}

module.exports = { report, toolTokens };

if (require.main === module) {
  const result = report();
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    console.log(`stable rules        ${result.stableRules}`);
    for (const [id, tokens] of Object.entries(result.blocks)) console.log(`  ${id.padEnd(18)}${tokens}`);
    console.log(`turn rules          ${result.turnRules}`);
    console.log(`run line            ${result.runLine}`);
    console.log(`product tools       ${result.productTools.count} tools, ${result.productTools.tokens}`);
    console.log(`resident tools      ${result.residentTools.count} tools, ${result.residentTools.tokens} (Pi/DeepSeek/OpenCode)`);
  }
}
