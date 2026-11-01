#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "../app/manage-ui/node_modules/typescript/lib/typescript.js";
let checks = 0;
const check = Object.fromEntries(["equal", "deepEqual", "throws", "ok"].map(name => [name, (...args) => { checks++; return assert[name](...args); }]));
const decode = value => JSON.parse(JSON.stringify(value));
function load(relative, extra = {}) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8"), module = { exports: {} };
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(compiled, { module, exports: module.exports, ...extra }); return module.exports;
}
const ui = load("../app/manage-ui/src/lib/mcpConnectorUi.ts", { URL });
const desktopFigma = {source:{kind:"custom"},auth:{kind:"none"},transport:{kind:"remote",protocol:"streamable-http",url:ui.FIGMA_DESKTOP_URL}};
check.equal(ui.isFigmaDesktopConnector(desktopFigma),true);
check.equal(ui.isFigmaDesktopConnector({...desktopFigma,transport:{...desktopFigma.transport,url:"http://localhost:3845/mcp/"}}),true);
for (const url of ["https://mcp.figma.com/mcp", "http://127.0.0.1:3846/mcp", "http://127.0.0.1:3845/other", "http://127.0.0.1:3845/mcp?token=value", "http://127.0.0.1.evil.test:3845/mcp", "http://user:secret@127.0.0.1:3845/mcp"]) check.equal(ui.isFigmaDesktopConnector({...desktopFigma,name:"Figma",transport:{...desktopFigma.transport,url}}),false);
check.equal(ui.isFigmaDesktopConnector({...desktopFigma,auth:{kind:"headers"}}),false,"authenticated endpoints retain credential setup");
check.equal(ui.isFigmaDesktopConnector({...desktopFigma,source:{kind:"registry"}}),false);
check.equal(ui.isFigmaDesktopConnector({...desktopFigma,transport:{...desktopFigma.transport,protocol:"sse"}}),false);
check.equal(ui.isFigmaDesktopConnector(),false);
const recommendation={id:'posthog',name:'PostHog',url:'https://mcp.posthog.com/mcp',docsUrl:'https://posthog.com/docs/model-context-protocol',description:{en:'Product analytics', 'zh-CN':'产品分析'}};
check.equal(ui.matchesMcpRecommendation(recommendation,' POSTHOG '),true);
check.equal(ui.matchesMcpRecommendation(recommendation,'产品'),true);
check.equal(ui.matchesMcpRecommendation(recommendation,'missing'),false);
check.equal(ui.mcpRecommendationText(recommendation.description,'zh-CN'),'产品分析');
check.equal(ui.mcpRecommendationText(recommendation.description,'en-US'),'Product analytics');
check.equal(ui.mcpRecommendationText(recommendation.description,'de'),'Product analytics');
check.equal(ui.mcpRegistryHasRemote({options:[{transport:{kind:'remote',url:recommendation.url}}]},recommendation.url),true);
check.equal(ui.mcpRegistryHasRemote({name:'PostHog',options:[{transport:{kind:'remote',url:'https://third-party.example/mcp'}}]},recommendation.url),false,'display names cannot replace official endpoint identity');
check.equal(ui.mcpRegistryHasRemote({options:[{transport:{kind:'stdio-command',command:'/usr/local/bin/dayone'}}]},undefined),false);
const dayOnePreset={transport:{kind:'stdio-command',command:'/usr/local/bin/dayone',args:['mcp']}};
check.equal(ui.mcpRecommendationMatchesServer(dayOnePreset,{transport:{kind:'stdio-command',command:'/usr/local/bin/dayone',args:['mcp']}}),true,'known installed local app opens management');
check.equal(ui.mcpRecommendationMatchesServer(dayOnePreset,{transport:{kind:'stdio-command',command:'/usr/local/bin/dayone'}}),true,'the public DTO omits argv and still opens management without crashing');
check.equal(ui.mcpRecommendationMatchesServer(dayOnePreset,{transport:{kind:'stdio-command',command:'/usr/local/bin/other'}}),false);
check.equal(ui.mcpRecommendationMatchesServer(dayOnePreset,{transport:{kind:'stdio-command',command:'/usr/local/bin/dayone',args:['export']}}),false,'another command mode is not an installed MCP match');
const passwordPreset={transport:{kind:'stdio-command',command:'1password-mcp',args:[]}};
check.equal(ui.mcpRecommendationMatchesServer(passwordPreset,{transport:{kind:'stdio-command',command:'/Applications/1Password.app/Contents/MacOS/1password-mcp',args:[]}}),true,'a resolved official command can be managed');
check.equal(ui.mcpRecommendationMatchesServer(passwordPreset,{transport:{kind:'stdio-command',command:'/opt/homebrew/bin/1password-mcp'}}),true,'the PATH-resolved public DTO does not expose argv');
check.equal(ui.mcpRecommendationMatchesServer(passwordPreset,{transport:{kind:'stdio-command',command:'/tmp/other-mcp',args:[]}}),false);
check.equal(ui.mcpRecommendationMatchesServer({transport:{kind:'stdio-command',command:'',args:[]}},{transport:{kind:'stdio-command',command:'/Users/test/quickbooks/dist/index.js',args:[]}}),false,'an empty configurable path never matches an unrelated executable');
const amapPreset={transport:{kind:'stdio-package',registryType:'npm',identifier:'@amap/amap-maps-mcp-server',version:'0.0.8'}};
check.equal(ui.mcpRecommendationMatchesServer(amapPreset,{transport:{...amapPreset.transport,version:'0.0.7'}}),true,'existing package version is managed, not implicitly upgraded or duplicated');
check.equal(ui.mcpRecommendationMatchesServer(amapPreset,{transport:{...amapPreset.transport,identifier:'third-party/amap'}}),false);
check.deepEqual(decode(ui.parseMcpStringMap(' {"Authorization":"Bearer token-canary"} ')), { Authorization: "Bearer token-canary" });
for (const raw of ['[]', 'null', '{"token":3}', '{"__proto__":"x"}', '{"constructor":"x"}', 'invalid']) check.throws(() => ui.parseMcpStringMap(raw));
check.deepEqual(decode(ui.parseMcpArguments('["folder with spaces","$(not-a-shell)"]')), ["folder with spaces", "$(not-a-shell)"]);
for (const raw of ['{}','[1]','[null]']) check.throws(() => ui.parseMcpArguments(raw));
const definitions = [{ name: "TOKEN", location: "env", required: true, secret: true }, { name: "target", location: "argument", required: true, secret: false }, { name: "host", location: "variable", required: true, secret: false, default: "example.test" }];
check.deepEqual(decode(ui.mcpFieldsFromInputs({ env: "", headers: "", definitions, values: { "env:TOKEN": "token-canary", "argument:target": "folder" }, includeDefaults: true })), { env: { TOKEN: "token-canary" }, arguments: { target: "folder" }, variables: { host: "example.test" } });
check.deepEqual(decode(ui.mcpFieldsFromInputs({ env: "", headers: "", definitions, values: {}, includeDefaults: false })), {}, "untouched values must not clear existing credentials");
check.deepEqual(decode(ui.mcpFieldsFromInputs({ env: "", headers: "", definitions: [{ name: "value", location: "env", secret: true }, { name: "value", location: "argument", secret: false }], values: { "env:value": "token-canary", "argument:value": "folder" } })), { env: { value: "token-canary" }, arguments: { value: "folder" } });
const iconUi = load("../app/manage-ui/src/lib/mcpConnectorIcons.ts", { URL });
const catalog = load("../app/manage-ui/src/lib/mcpRecommendationCatalog.ts");
const presets = JSON.parse(fs.readFileSync(new URL("../app/agent-service/data/mcp-featured-presets.json", import.meta.url), "utf8"));
for (const [id, url] of Object.entries({ runway: "https://mcp.runwayml.com/mcp", higgsfield: "https://mcp.higgsfield.ai/mcp", "black-forest-labs": "https://mcp.bfl.ai", "fal-ai": "https://mcp.fal.ai/mcp-relay" })) {
  const preset = presets.find(value => value.id === id);
  check.equal(preset.url, url, `${id} uses the official generation endpoint`);
  check.equal(preset.setup, "oauth");
  check.equal(preset.requiresOAuthApp, undefined);
  check.equal(preset.envKey, undefined);
}
const blenderLab = presets.find(value => value.id === "blender-lab");
check.equal(blenderLab.docsUrl, "https://www.blender.org/lab/mcp-server/");
check.equal(blenderLab.setup, "local");
check.deepEqual(blenderLab.transport, { kind: "stdio-command", command: "", args: ["-m", "blmcp"] });
const savedBlender = { recommendationId: "blender-lab", name: "My scene editor", transport: { kind: "stdio-command", command: "/Users/fixture/.venv/bin/python" } };
check.equal(ui.mcpRecommendationMatchesServer(blenderLab, savedBlender), true, "saved Python module identity retains Blender management without public argv");
check.equal(ui.mcpRecommendationMatchesServer(blenderLab, { ...savedBlender, recommendationId: undefined, name: "Blender Lab" }), false, "a display name and Python path cannot select the official preset");
check.equal(ui.mcpRecommendationMatchesServer(dayOnePreset, savedBlender), false);
const { validateMcpRemoteUrl } = createRequire(import.meta.url)("../app/agent-service/native-mcp-store.js");
for (const preset of presets.filter(value => value.url)) {
  const transport = { kind: "remote", protocol: "streamable-http", url: validateMcpRemoteUrl(preset.url) };
  check.equal(ui.mcpRecommendationMatchesServer(preset, { transport }), true, `${preset.id}: the persisted URL retains recommendation metadata and artwork`);
  check.equal(ui.mcpRegistryHasRemote({ options: [{ transport }] }, preset.url), true, `${preset.id}: normalized registry endpoints retain their match`);
}
const lovable = presets.find(value => value.id === "lovable");
for (const url of ["https://mcp.lovable.dev/", "https://MCP.LOVABLE.DEV:443/"]) {
  check.equal(ui.mcpRecommendationMatchesServer(lovable, { transport: { kind: "remote", protocol: "streamable-http", url } }), true);
}
for (const url of ["https://mcp.lovable.dev.evil.test/", "https://evil.test/mcp.lovable.dev", "https://mcp.lovable.dev/mcp", "https://mcp.lovable.dev/?workspace=other", "https://mcp.lovable.dev:8443/", "http://mcp.lovable.dev/", "https://user:secret@mcp.lovable.dev/", "invalid"]) {
  check.equal(ui.mcpRecommendationMatchesServer(lovable, { name: "Lovable", transport: { kind: "remote", protocol: "streamable-http", url } }), false, "a name or different endpoint must not select the official brand");
}
check.equal(ui.mcpRecommendationMatchesServer(lovable, { transport: { kind: "remote", protocol: "sse", url: lovable.url } }), false);
check.equal(ui.mcpRecommendationMatchesServer(recommendation, { transport: { kind: "remote", protocol: "streamable-http", url: recommendation.url + "/" } }), false, "a non-root trailing slash may address a different resource");
check.equal(ui.mcpRecommendationMatchesServer({ ...lovable, url: "invalid" }, { transport: { kind: "remote", protocol: "streamable-http", url: "invalid" } }), false);
const featured = JSON.parse(fs.readFileSync(new URL("../app/agent-service/data/mcp-featured-servers.json", import.meta.url), "utf8"));
const canva = presets.find(value => value.id === "canva");
const canvaRegistry = JSON.parse(fs.readFileSync(new URL("./fixtures/mcp-registry/com.canva.mcp__mcp.json", import.meta.url), "utf8"));
check.equal(canva.setup, "oauth", "Canva uses the working browser OAuth route without manual client credentials");
check.equal(canva.url, canvaRegistry.server.remotes[0].url, "keep the existing official Canva endpoint");
check.equal(canva.clientSecretRequired, undefined);
check.equal(ui.mcpRecommendationMatchesServer(canva, { source: { kind: "registry", registryName: canvaRegistry.server.name }, transport: { kind: "remote", protocol: "streamable-http", url: canva.url } }), true, "existing Canva connections open management");
check.equal(catalog.mcpBrandId(canvaRegistry.server.name), "canva", "existing registry records retain the official logo");
const officialSkills = JSON.parse(fs.readFileSync(new URL("../app/agent-service/data/official-skill-connectors.json", import.meta.url), "utf8"));
for (const definition of officialSkills) {
  const saved = { id: `official-${definition.id}-a0b0c0d0`, name: "Renamed connector", source: { kind: "custom" }, transport: { kind: "stdio-command", command: "/Applications/Shoggoth.app/Contents/MacOS/Shoggoth" } };
  check.equal(catalog.mcpOfficialSkillBrand(saved), definition.id, `${definition.id}: app-created registration retains display identity without ownership metadata or argv`);
  check.equal(catalog.mcpOfficialSkillBrand({ ...saved, id: "custom", name: definition.name }), undefined, "display names never assign a brand");
  check.equal(catalog.mcpOfficialSkillBrand({ ...saved, id: `official-${definition.id}-a0b0c0d0-extra` }), undefined);
  check.equal(catalog.mcpOfficialSkillBrand({ ...saved, id: `official-${definition.id}-short` }), undefined);
  check.equal(catalog.mcpOfficialSkillBrand({ ...saved, source: { kind: "registry", registryName: "other/publisher" } }), undefined);
  check.equal(catalog.mcpOfficialSkillBrand({ ...saved, transport: { kind: "remote", protocol: "streamable-http", url: "https://example.test/mcp" } }), undefined);
}
check.equal(catalog.mcpOfficialSkillBrand(undefined), undefined);
check.equal(catalog.mcpOfficialSkillBrand({ id: "official-unknown-a0b0c0d0", source: { kind: "custom" }, transport: { kind: "stdio-command" } }), undefined);
const ids = [...featured.map(catalog.mcpBrandId), ...presets.filter(value => !value.registryName).map(value => value.id), "lark-cli", ...officialSkills.map(value => value.id)];
check.equal(new Set(ids).size, ids.length, "recommendations have unique brand identities");
check.deepEqual([...catalog.mcpRecommendationOrder].sort(), [...ids].sort(), "every recommendation has one deterministic popularity position");
const sources = JSON.parse(fs.readFileSync(new URL("../app/manage-ui/src/assets/mcp-logos/sources.json", import.meta.url), "utf8"));
for (const id of ids) {
  const bytes = fs.readFileSync(new URL(`../app/manage-ui/src/assets/mcp-logos/${id}.png`, import.meta.url));
  check.equal(bytes.subarray(1, 4).toString(), "PNG", id + " is a real bundled PNG");
  check.equal(bytes.readUInt32BE(16), id === "wind" ? 2570 : 128); check.equal(bytes.readUInt32BE(20), id === "wind" ? 887 : 128);
  check.ok(sources.assets.some(value => value.id === id && value.assetUrl.startsWith("https://")), id + " retains its official source");
}
for (const registryName of featured) {
  const summary = presets.find(value => value.registryName === registryName) || catalog.mcpRegistrySummary(registryName);
  check.ok(summary?.description.en && summary?.description["zh-CN"], registryName + " has both descriptions");
}
const lightIcon = {src:"https://icons.example/light.svg",mimeType:"image/svg+xml",theme:"light"};
const darkIcon = {src:"https://icons.example/dark.svg",mimeType:"image/svg+xml",theme:"dark"};
const neutralIcon = {src:"https://icons.example/logo.png",mimeType:"image/png",sizes:["64x64"]};
check.equal(iconUi.selectMcpIcon([lightIcon,darkIcon,neutralIcon],"light").src,lightIcon.src);
check.equal(iconUi.selectMcpIcon([lightIcon,darkIcon,neutralIcon],"dark").src,darkIcon.src);
check.equal(iconUi.selectMcpIcon([lightIcon,darkIcon,neutralIcon],"dark",new Set([darkIcon.src])).src,neutralIcon.src);
check.equal(iconUi.selectMcpIcon([lightIcon],"light",new Set([lightIcon.src])),undefined);
check.equal(iconUi.selectMcpIcon([{src:"javascript:alert(1)"},{src:"data:image/svg+xml,private"},{src:"https://user:secret@icons.example/logo.png"}],"light"),undefined);
check.equal(iconUi.selectMcpIcon(undefined,"dark"),undefined);
check.deepEqual(decode(iconUi.mcpIconFallback("com.notion/mcp","com.notion/mcp")),decode(iconUi.mcpIconFallback("com.notion/mcp","com.notion/mcp")));
check.equal(iconUi.mcpIconFallback("com.notion/mcp","com.notion/mcp").initials,"NO");
check.equal(iconUi.mcpIconFallback("本地工具","local").initials,"本地");
check.equal(iconUi.mcpIconFallback("  ","local").initials,"M");
const a = { registryName: "org/a", version: "1.0.0", name: "A" }, b = { ...a, version: "2.0.0" };
check.deepEqual(decode(ui.mergeMcpRegistryItems([a], [{ ...a, name: "A updated" }, b])), [{ ...a, name: "A updated" }, b]);
check.equal(ui.mcpRequestStatus({ status: "pending", expiresAt: 100 }, 99), "pending");
check.equal(ui.mcpRequestStatus({ status: "pending", expiresAt: 100 }, 100), "expired");
check.equal(ui.mcpRequestStatus({ status: "completed", expiresAt: 100 }, 200), "completed");
const reqFields = [{ name: "header:Authorization", kind: "header" }, { name: "TOKEN", kind: "env" }, { name: "client_id", kind: "oauthClient" }, { name: "client_secret", kind: "oauthClient" }];
check.deepEqual(decode(ui.mcpRequestFields({ requiredFields: reqFields }, { "header:header:Authorization": "token-canary", "env:TOKEN": "token-canary", "oauthClient:client_id": "client", "oauthClient:client_secret": "secret-canary" })), { headers: { Authorization: "token-canary" }, env: { TOKEN: "token-canary" }, oauthClient: { clientId: "client", clientSecret: "secret-canary" } });
check.deepEqual(decode(ui.mcpRequestFields({ requiredFields: [{ name: "clientSecret", kind: "oauthClient" }] }, { "oauthClient:clientSecret": "secret-only" })), { oauthClient: { clientSecret: "secret-only" } });
check.deepEqual(decode(ui.mcpRequestFields({ requiredFields: [{ name: "oauthClient.client_secret", kind: "oauthClient" }] }, { "oauthClient:oauthClient.client_secret": "secret-only" })), { oauthClient: { clientSecret: "secret-only" } });
check.throws(() => ui.mcpRequestFields({ requiredFields: [{ name: "redirectUri", kind: "oauthClient" }] }, { "oauthClient:redirectUri": "https://injected.example" }));
const installedRegistry = { source: { kind: "registry", registryName: "org/a", version: "1.0.0" } };
check.equal(ui.mcpAvailableUpdate(installedRegistry,[a]),undefined);
check.deepEqual(decode(ui.mcpAvailableUpdate(installedRegistry,[b])),b);
check.equal(ui.mcpAvailableUpdate({ source: { kind: "custom" } },[b]),undefined);
check.equal(ui.mcpAvailableUpdate(installedRegistry,[{...b,registryName:"org/unrelated"}]),undefined);
check.deepEqual(decode(ui.mcpAvailableUpdate(installedRegistry,[a,b])),b);
const approval = { requestId: "request-one", argumentDigest: "digest-original", expiresAt: 100 };
check.equal(ui.canResolveMcpApproval(approval, approval, 99),true);
check.equal(ui.canResolveMcpApproval(approval, approval, 100),false);
check.equal(ui.canResolveMcpApproval(approval, { ...approval, argumentDigest: "changed" }, 99),false);
check.equal(ui.canResolveMcpApproval(approval, { ...approval, expiresAt: 200 }, 99),false);
check.equal(ui.canResolveMcpApproval(approval, undefined, 99),false);
const calls = [], events = [];
const api = load("../app/manage-ui/src/api/mcpConnectors.ts", { require: name => { check.equal(name,"./client"); return { jsonFetch: (url, options) => { calls.push({ url, options }); return Promise.resolve({}); } }; }, URLSearchParams, Event, window: { dispatchEvent: event => events.push(event.type) } });
await api.saveMcpCredentials("same-id", { env: { TOKEN: "token-canary" } }, 2);
await api.completeMcpRequest({ requestId: "request-id", fields: { headers: { Authorization: "token-canary" } } });
await api.addMcpConnector({ source: { kind: "custom" }, option: { kind: "remote", protocol: "streamable-http", url: "https://example.test/mcp" }, expectedRevision: 2 });
await api.resolveMcpApproval("request-one", "digest-original", true);
for (const call of calls) { check.equal(call.options.method,"POST"); check.ok(call.url.startsWith("/__api/connectors/mcp/")); check.equal(call.url.includes("token-canary"),false); check.equal(call.url.includes("__chatws"),false); }
check.deepEqual(JSON.parse(calls[0].options.body), { id: "same-id", fields: { env: { TOKEN: "token-canary" } }, expectedRevision: 2 });
check.deepEqual(JSON.parse(calls[3].options.body), { requestId: "request-one", argumentDigest: "digest-original", approved: true });
check.equal(events.length,4);
check.equal(api.mcpPublicError(new Error("secret-canary")),"MCP_CONNECTOR_REQUEST_FAILED");
check.equal(api.mcpPublicError({ code: "MCP_AUTH_REQUIRED" }),"MCP_AUTH_REQUIRED");
const resources = load("../app/manage-ui/src/i18n/mcpConnectorResources.ts").mcpConnectorResources;
const translate = language => key => key.split(".").slice(1).reduce((value,part)=>value[part],resources[language]);
for(const language of ["zh-CN","en"]){
  const tr=translate(language);
  check.equal(api.formatMcpError({code:"MCP_REQUEST_ACK_UNKNOWN",message:"private-canary"},tr),resources[language].errors.ackUnknown);
  check.equal(api.formatMcpError({code:"MCP_AUTH_REQUIRED",message:"private-canary"},tr),resources[language].errors.auth);
  check.ok(resources[language].errors.providerAccessDenied);
  check.equal(api.formatMcpError({code:"MCP_SERVER_ACCESS_DENIED",message:"private-canary"},tr),resources[language].errors.providerAccessDenied);
  check.equal(resources[language].errors.providerAccessDenied===resources[language].errors.auth,false);
  check.ok(resources[language].errors.registrationDenied);
  check.equal(api.formatMcpError({code:"MCP_OAUTH_REGISTRATION_DENIED",message:"private-canary"},tr),resources[language].errors.registrationDenied);
  check.equal(api.formatMcpError({code:"CONNECTOR_UNAVAILABLE",message:"private-canary"},tr),resources[language].errors.service);
  check.equal(api.formatMcpError({code:"UNRECOGNIZED_PRIVATE_CANARY",message:"private-canary"},tr),resources[language].errors.fallback);
  check.equal(api.formatMcpError(new Error("private-canary"),tr).includes("private-canary"),false);
}
console.log(JSON.stringify({ outcome: "PASS", checks, untouchedCredentialsPreserved: true, privateCredentialPostOnly: true, expiryBoundary: true, registryDedupe: true, backendErrorRedacted: true }));

{
  const approval = { requestId: "request-a", backendId: "hermes", agentId: "coder", sessionId: "physical-a",
    toolName: "mcp_server_call", serverId: "composio", argumentDigest: "a".repeat(64), reason: "Review this call",
    argumentsPreview: JSON.stringify({ serverId: "composio", toolName: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: [{ name: "gmail", action: "list" }] } }),
    createdAt: 1, expiresAt: 100 };
  check.equal(ui.mcpApprovalMatchesConversation(approval, { backendId: "hermes", agentId: "coder", sessionId: "physical-a" }), true);
  for (const conversation of [{ backendId: "openclaw", agentId: "coder", sessionId: "physical-a" },
    { backendId: "hermes", agentId: "other", sessionId: "physical-a" },
    { backendId: "hermes", agentId: "coder", sessionId: "physical-b" },
    { backendId: "hermes", agentId: "coder" }]) check.equal(ui.mcpApprovalMatchesConversation(approval, conversation), false);
  const prompt = ui.mcpApprovalPrompt(approval);
  check.deepEqual(decode(prompt.approvalChoices), ["once", "deny"]);
  check.equal(prompt.kind, "mcp_permission"); check.equal(prompt.requestId, approval.requestId);
  check.equal(prompt.approvalDetails.toolName, "COMPOSIO_MANAGE_CONNECTIONS");
  check.deepEqual(JSON.parse(prompt.approvalDetails.input), { toolkits: [{ name: "gmail", action: "list" }] });
  check.equal(ui.canResolveMcpApproval(approval, { ...approval }, 99), true);
  for (const changed of [{ backendId: "openclaw" }, { agentId: "other" }, { sessionId: "physical-b" },
    { argumentDigest: "b".repeat(64) }, { expiresAt: 101 }, { toolName: "different" }, { serverId: "other" }]) {
    check.equal(ui.canResolveMcpApproval(approval, { ...approval, ...changed }, 99), false);
  }
  check.equal(ui.canResolveMcpApproval(approval, approval, 100), false);
  check.equal(ui.mcpApprovalPrompt({ ...approval, argumentDigest: "b".repeat(64) }).id === prompt.id, false);
  check.equal(ui.mcpApprovalPrompt({ ...approval, argumentsPreview: "{truncated…" }).approvalDetails.input, "{truncated…");
  console.log(JSON.stringify({ outcome: "PASS", checks, scopedMcpApproval: true, exactBrokerIdentity: true, onceOnlyChoices: true }));
}
