"use strict";

// These are reviewed requirements for exact frozen SKILL.md bytes. A changed
// source hash loses this assertion; lexical matches in Skill prose never grant
// availability. The list is intentionally narrower than business acceptance.
const REVIEWED_FROZEN = Object.freeze({
  "936bbe68b4731d4a8748db15f85247efde232c8ae0902857c2c79a9ed40649ea": {
    name: "figma-design-to-code", requiredTools: ["get_design_context"],
  },
  "66b1ad8a1f72e5295c178548ced3c9dd4038432bb08e5f7a4617e399d59be9cd": {
    name: "figma-design-to-code", requiredTools: ["get_design_context"],
  },
  "2e26e67284d47c6a74aedf9dca7543f4c8817dafc59a11abb156d4f7feedb2c2": {
    name: "figma-implement-motion", requiredTools: ["get_design_context", "get_motion_context"],
  },
  "9f34881b4a1b1a5ce031fd4bfdb45bb3dd3c5f8580651a745291bccb594c3091": {
    name: "figma-implement-motion", requiredTools: ["get_design_context", "get_motion_context"],
  },
  "ab2ea3070a27880e27d06eae7d86d1aab759cc544e8b7760a8ed2da8b3606268": {
    name: "deep-security-scan", requiredRuntimeCapabilities: ["codex-security-plugin"],
  },
  "c36e061938b2138d62e310145df05118dbf1b9a1e1ff12883928c92f32add636": {
    name: "deep-security-scan", requiredRuntimeCapabilities: ["codex-security-plugin"],
  },
  "bb8ad932ec473cee097c9c8d106051134e9ab6cf9dc85d6a8e62ce80ad24c385": {
    name: "ios-debugger-agent", requiredTools: ["mcp__XcodeBuildMCP__session"],
  },
  "4fa293e056cde30fc1f7a4724323cc0077dfd8df72b7d6e38a803e69b5be3821": {
    name: "ios-debugger-agent", requiredTools: ["mcp__XcodeBuildMCP__session"],
  },
  "2239188d6ac667a9e4b546ffb441f17ac3cfe90fe7683ac68506789ef8dabeb3": {
    name: "index", requiredTools: ["functions.list_available_plugins_to_install",
      "functions.request_plugin_install"],
  },
  "af165cf095f1e1157c1fcc5b7f1e54a4dd1ae83377a686997f5061618e6784f6": {
    name: "index", requiredTools: ["functions.list_available_plugins_to_install",
      "functions.request_plugin_install"],
  },
  "b4ba5e0847e9b56b327da4e7546f5f0bf3325f54d6d21fc119b320bc2c898a53": {
    name: "build-chatgpt-app", requiredTools: ["mcp__openaiDeveloperDocs__search_openai_docs",
      "mcp__openaiDeveloperDocs__fetch_openai_doc"],
  },
  "27bcd2c43df86961ac057dd5b6953b3b80981687ad2a9200c483a18a9e443019": {
    name: "build-chatgpt-app", requiredTools: ["mcp__openaiDeveloperDocs__search_openai_docs",
      "mcp__openaiDeveloperDocs__fetch_openai_doc"],
  },
});

// The bundled Codex import normalizes frontmatter and removes `allowed-tools`.
// These hashes pin both the original declaration and its converted installed
// bytes; the declaration is an unverified host allowlist, never an authority to
// grant any tool.
const DECLARED_ALLOWED_TOOLS = new Map([
  ["adobe-batch-edit-photos", ["062112a424340bef585f0c3aed9a484721ff4b200044883dd0bdb1dd7599642c", "ad3d4aa4f4ed6245f2049ec1552af71df850ed5b9ce41cea2cb2bd8ee6f8ba48"]],
  ["adobe-create-mockups", ["65a8fd58c8495210296eb1da51d0846d1ad9a7cf80a286ea4220874c0f4e56f2", "dbfaebfc03b4c1f3c316ff8374aa6459a5897955e4fa85557d33efb4d8268a9f"]],
  ["adobe-create-social-variations", ["f2404147b9a05f7d759d8a7c0c51af06f9841ad55025395a887d27429be6d63d", "bfef9e88fec7f23fceebc8473b8aeb5db53cc3f4838f02c0544a0fbf106e0499"]],
  ["adobe-design-from-template", ["11d9eaed34c526b350185c298d8dd3c764d3cebeb111905f59230d3b3c291207", "605aef07ebc353f276013c3da50d4f35afcae41ce89d92d6bb803f6528720dfa"]],
  ["adobe-edit-quick-cut", ["5515014c80995b846dfe511058f507beeedb428078fda1bd60d47531f51b5500", "7fcb870e58f1abedec07d052125c1ae138047065a1363f996088fa07aa613afa"]],
  ["adobe-retouch-portraits", ["30dd9e57ceae0438f3eadb4734403853dc4bb2ae23e23ca14365a4702ed2a182", "938963825d7e3fc4e8b17d9b1b172cd7a492f1cfdd878ccc29e3593ad5ccb81d"]],
  ["magicpath", ["4f22138e17f01b7b852eae4db52592533d6af44977b587734319b6bceaf73913", "9eb8ea4398f2c91557e3787e852f4470567b57ef8ce32d643fc9d24ebd8b2e69"]],
  ["dashboard-expert", ["9caccf53e947097de4aea8f0ff2e6f9076ca4604076f1693665e5bf8d5d329e8", "4a7a56f13a2570361581b147e00c9b16fff813b8280aafe494135f2454a67bb8"]],
  ["mixpanelyst", ["33bd3c7ec38e95ac093e48d91f9b18d4dd5943607449812e299f69bafd23c1f1", "75d29e4539057d88834cdd86991283dc4610b3ae74f6aed76605e8f00662ec8d"]],
  ["setup", ["1724fbfb68297f4fc40c8685bb31934be0efc8f550617242c85df035ebfff6fc", "1f818d406b4d83351a747ad10cc686a7138fa4c275dd45ac8c1a9b29669af21a"]],
  ["aiq-deploy", ["9bfad6034823422b564c0ff3ff7d462eef237fec129f4f5fb1c027f625bc2b9f", "eabdae0376390f4779a31ea0385c6d560dcff5eb76b665c0d220e44e79f84217"]],
  ["aiq-research", ["a765670f3d460a7ef6849070b4a95a28d66c92eb678d720ca9fd1731f80189fc", "8c5c7a82dba023319dcc9971838cca1b199d2414b6fbbc48749e04316074e6fe"]],
  ["stripe-directory", ["dd93d505bb4afd2e2a9c3b0f904301581ed4212f5008169c44281bcd5ed5855b", "6229f3d975941d35460da07fd5b3d490878ed9189376b03a4aa6666649775711"]],
  ["stripe-docs", ["fd02afdef978b9834b458822f253761dc81eac4fd54ff76e3f9ba7de62b2a6ac", "4ee5d60d2adda065267267290179a69707320bc3606dc54645bc5ec1b6743941"]],
  ["stripe-projects", ["9d74a82cc3a9c777ba09e16fb663e7338108735462ce70cb75d99e7a250394d3", "eb6bc595535023876224c5aa940c3200cc602218d98f9c40fa403da4aaf25651"]],
].flatMap(([name, hashes]) => hashes.map((digest) => [digest, name])));

// A bundled update must not silently discard a previously reviewed host
// dependency. Names are scoped to the bundled source, so unrelated local
// Skills with a common name (for example `index`) are unaffected.
const WATCHED_FROZEN = Object.freeze({
  "bundled:adobe": ["adobe-batch-edit-photos", "adobe-create-mockups",
    "adobe-create-social-variations", "adobe-design-from-template",
    "adobe-edit-quick-cut", "adobe-retouch-portraits"],
  "bundled:build-ios-apps": ["ios-debugger-agent"],
  "bundled:codex-security": ["deep-security-scan"],
  "bundled:data-analytics": ["index"],
  "bundled:figma": ["figma-design-to-code", "figma-implement-motion"],
  "bundled:magicpath": ["magicpath"],
  "bundled:mixpanel-headless": ["dashboard-expert", "mixpanelyst", "setup"],
  "bundled:nvidia": ["aiq-deploy", "aiq-research"],
  "bundled:openai-developers": ["build-chatgpt-app"],
  "bundled:stripe": ["stripe-directory", "stripe-docs", "stripe-projects"],
});

function requirementsFor(descriptor) {
  const reviewed = REVIEWED_FROZEN[descriptor.descriptorDigest];
  const exact = reviewed?.name === descriptor.name ? reviewed : null;
  const pinnedAllowedTools = DECLARED_ALLOWED_TOOLS.get(descriptor.descriptorDigest)
    === descriptor.name;
  return {
    requiredTools: [...new Set([...(descriptor.requiredTools || []),
      ...(exact?.requiredTools || [])])],
    requiredRuntimeCapabilities: [...new Set([...(descriptor.requiredRuntimeCapabilities || []),
      ...(exact?.requiredRuntimeCapabilities || [])])],
    reviewedFrozen: Boolean(exact),
    declaredAllowedTools: descriptor.declaredAllowedTools === true || pinnedAllowedTools,
    reviewRequired: WATCHED_FROZEN[descriptor.sourceIdentity]?.includes(descriptor.name) === true
      && !exact && !pinnedAllowedTools,
  };
}

function evaluatePluginSkill(descriptor, { availableTools = [], allowedTools = [],
  runtimeCapabilities = [], pluginTools = [] } = {}) {
  if (descriptor.sourceIdentity === "bundled:higgsfield") {
    // These frozen Skills invoke Higgsfield's Codex sandbox contract
    // (sandbox_exec/HF_WORKFLOWS), which Shoggoth does not implement. Keep
    // their installed bytes for provenance, but never expose them to a Run.
    return Object.freeze({ eligible: false, reason: "review_required",
      dependency: "higgsfield-sandbox", assessment: "not_assessed",
      requiredTools: Object.freeze([]),
      requiredRuntimeCapabilities: Object.freeze(["higgsfield-sandbox"]) });
  }
  const requirements = requirementsFor(descriptor);
  const available = new Set(availableTools);
  const allowed = new Set(allowedTools);
  const capabilities = new Set(runtimeCapabilities);
  const reviewedDesktopFigma = requirements.reviewedFrozen
    && descriptor.sourceIdentity === "bundled:figma"
    && ["figma-design-to-code", "figma-implement-motion"].includes(descriptor.name);
  const boundTool = (name) => (!requirements.reviewedFrozen || reviewedDesktopFigma)
    && typeof descriptor.installationId === "string"
    && typeof descriptor.sourceIdentity === "string"
    && pluginTools.some((tool) => tool.name === name
      && tool.installationId === descriptor.installationId
      && tool.sourceIdentity === descriptor.sourceIdentity);
  // A frozen Codex-specific dependency needs an exact connector contract
  // review, not a coincidental product or third-party MCP tool name.
  const missingTool = requirements.requiredTools.find((tool) =>
    !(boundTool(tool) || (!requirements.reviewedFrozen && available.has(tool))));
  const forbiddenTool = requirements.requiredTools.find((tool) =>
    !(boundTool(tool) || (!requirements.reviewedFrozen && allowed.has(tool))));
  const missingCapability = requirements.requiredRuntimeCapabilities.find((item) =>
    !capabilities.has(item));
  const reason = requirements.reviewRequired ? "review_required"
    : missingTool ? "tool_missing"
    : forbiddenTool ? "tool_forbidden"
      : missingCapability ? "runtime_capability_missing"
    : requirements.declaredAllowedTools && !requirements.reviewedFrozen
          ? "tool_contract_unverified" : null;
  return Object.freeze({ eligible: reason === null, reason,
    dependency: missingTool || forbiddenTool || missingCapability || null,
    assessment: requirements.reviewRequired ? "frozen_changed"
      : requirements.reviewedFrozen ? "reviewed_frozen"
      : requirements.declaredAllowedTools ? "declaration_unverified"
        : requirements.requiredTools.length || requirements.requiredRuntimeCapabilities.length
          ? "machine_declared" : "not_assessed",
    requiredTools: requirements.requiredTools,
    requiredRuntimeCapabilities: requirements.requiredRuntimeCapabilities });
}

module.exports = { evaluatePluginSkill, requirementsFor };
