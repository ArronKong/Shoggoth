"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadPluginOAuthProviders } = require("../app/agent-service/plugin-oauth-config");
const { PluginOAuthProviderRegistry } = require("../app/agent-service/plugin-oauth-provider-registry");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-oauth-config-"));
  const paths = { pluginsDir: path.join(root, "plugins") };
  const file = path.join(paths.pluginsDir, "oauth-providers.json");
  const provider = (id = "fixture", host = "https://fixture.example") => ({ id, name: "Fixture",
    serverUrl: `${host}/mcp`, issuer: host, audience: `${host}/mcp`, authorizationEndpoint: `${host}/authorize`,
    tokenEndpoint: `${host}/token`, clientId: "public-client", scopes: ["read"],
    metadataUrls: [`${host}/.well-known/oauth-authorization-server`], identity: { url: `${host}/identity`, subjectField: "id" } });
  const valid = { version: 1, providers: [provider()] };
  const write = value => { fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(file, 0o600); };
  const invalid = value => { write(value); assert.throws(() => loadPluginOAuthProviders(paths), { code: "PLUGIN_OAUTH_CONFIG_INVALID" }); };
  try {
    assert.deepEqual(loadPluginOAuthProviders(paths), [], "missing config has no implicit providers");
    assert.equal(fs.existsSync(paths.pluginsDir), false, "reading missing config creates no authority");
    fs.mkdirSync(paths.pluginsDir, { mode: 0o700 });
    assert.throws(() => new PluginOAuthProviderRegistry().forEndpoint(valid.providers[0].serverUrl),
      { code: "PLUGIN_OAUTH_PROVIDER_UNSUPPORTED" });
    write(valid);
    assert.equal(loadPluginOAuthProviders(paths).length, 1);
    fs.chmodSync(file, 0o644);
    assert.throws(() => loadPluginOAuthProviders(paths), { code: "PLUGIN_OAUTH_CONFIG_INVALID" });
    fs.chmodSync(file, 0o600); fs.chmodSync(paths.pluginsDir, 0o755);
    assert.throws(() => loadPluginOAuthProviders(paths), { code: "PLUGIN_OAUTH_CONFIG_INVALID" });
    fs.chmodSync(paths.pluginsDir, 0o700);
    fs.renameSync(file, `${file}.target`); fs.symlinkSync(`${file}.target`, file);
    assert.throws(() => loadPluginOAuthProviders(paths), { code: "PLUGIN_OAUTH_CONFIG_INVALID" });
    fs.unlinkSync(file); fs.linkSync(`${file}.target`, file);
    assert.throws(() => loadPluginOAuthProviders(paths), { code: "PLUGIN_OAUTH_CONFIG_INVALID" });
    fs.unlinkSync(file); fs.renameSync(`${file}.target`, file);
    for (const key of ["verifyPrincipal", "command", "module", "clientSecret", "accessToken", "allowLoopback"]) {
      invalid({ ...valid, providers: [{ ...provider(), [key]: key === "allowLoopback" ? true : "untrusted" }] });
    }
    invalid({ ...valid, arbitrary: true });
    invalid({ ...valid, providers: [{ ...provider(), identity: { url: "http://127.0.0.1/identity", subjectField: "id" } }] });
    invalid({ ...valid, providers: [{ ...provider(), identity: { url: "https://fixture.example/identity", subjectField: "token" } }] });
    invalid({ ...valid, providers: [{ ...provider(), identity: { url: "https://fixture.example/identity?token=bad", subjectField: "id" } }] });
    invalid({ ...valid, providers: [{ ...provider(), scopes: ["read", "read"] }] });
    invalid({ ...valid, providers: [{ ...provider(), serverUrl: "http://127.0.0.1/mcp" }] });
    invalid({ ...valid, providers: [provider(), provider()] });
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe]));
    assert.throws(() => loadPluginOAuthProviders(paths), { code: "PLUGIN_OAUTH_CONFIG_INVALID" });
    fs.writeFileSync(file, " ".repeat(32 * 1024 + 1));
    assert.throws(() => loadPluginOAuthProviders(paths), { code: "PLUGIN_OAUTH_CONFIG_INVALID" });

    write({ version: 1, providers: [provider(), provider("second", "https://second.example")] });
    const loaded = loadPluginOAuthProviders(paths);
    let subject = "private-subject";
    let status = 200;
    let requests = 0;
    const registry = new PluginOAuthProviderRegistry({ providers: loaded, fetchImpl: async request => {
      requests += 1;
      assert.match(request.url, /^https:\/\/(fixture|second)\.example\/identity$/u);
      assert.equal(request.headers.get("authorization"), "Bearer private-fixture-token");
      return Response.json({ id: subject }, { status });
    } });
    const verify = (index = 0) => registry.verifyPrincipal({ endpointIdentity: loaded[index].serverUrl,
      issuer: new URL(loaded[index].issuer).href, audience: loaded[index].audience, scopes: ["read"], accessToken: "private-fixture-token" });
    const first = await verify();
    assert.match(first, /^oauth:fixture:[a-f0-9]{64}$/u);
    assert.equal(first.includes(subject), false);
    assert.equal(await verify(), first, "same issuer/provider/subject has stable opaque identity");
    assert.notEqual(await verify(1), first, "same subject across providers is not the same principal");
    subject = "other-subject";
    assert.notEqual(await verify(), first, "different account cannot preserve principal identity");
    subject = 0;
    assert.match(await verify(), /^oauth:fixture:[a-f0-9]{64}$/u);
    const integerIdentity = await verify();
    subject = "0";
    assert.notEqual(await verify(), integerIdentity, "typed subject identities cannot collide");
    for (const invalidSubject of [null, {}, [], "", "a\nb", "a".repeat(513), -1, 0.5]) {
      subject = invalidSubject;
      await assert.rejects(verify(), { code: "PLUGIN_OAUTH_CONFIG_INVALID" });
    }
    subject = "okay"; status = 401;
    await assert.rejects(verify(), { code: "PLUGIN_OAUTH_CONFIG_INVALID" });
    const before = requests;
    await assert.rejects(registry.verifyPrincipal({ endpointIdentity: loaded[0].serverUrl,
      issuer: "https://evil.example", audience: loaded[0].audience, scopes: ["read"], accessToken: "private-fixture-token" }),
    { code: "CONNECTION_AUTH_REQUIRED" });
    assert.equal(requests, before, "untrusted issuer is rejected before identity IO");
    console.log("plugin OAuth private config / explicit trust / opaque principal fixture: PASS");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
