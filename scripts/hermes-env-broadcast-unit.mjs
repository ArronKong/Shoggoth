#!/usr/bin/env node
// Contract unit: Hermes env/credential-pool 操作 vs isolated dashboards（R139）。
// R132 起 named-profile dashboard 用 --isolated 各自服务自己的 HERMES_HOME，
// .env / auth.json 每个 profile 一份——env 写必须广播全部 dashboard、读必须聚合，
// 否则「删除 provider」只清 default，bull/horse 上残留凭证让它在模型页复活
// （2026-07-14 alibaba 事故）。
// 运行：node scripts/hermes-env-broadcast-unit.mjs

import { createServer } from "node:http";
import { HermesBackend } from "../app/core/hermes-backend.js";

function fakeDash(routes = {}) {
  const captured = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const rec = {
        method: req.method, path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: raw ? JSON.parse(raw) : null,
      };
      captured.push(rec);
      const handler = routes[`${req.method} ${url.pathname}`] || routes.default;
      const out = handler ? handler(rec) : { code: 200, json: {} };
      res.writeHead(out.code, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    captured,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  })));
}

function makeBackend(dashes) {
  const be = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  for (const [profile, d] of Object.entries(dashes)) {
    be.dashboards.set(profile, { profile, baseUrl: d.baseUrl, token: "tok" });
    be.profileById.set(`hermes-${profile}`, profile);
  }
  return be;
}

const results = [];
const check = (name, cond) => { results.push({ name, ok: !!cond }); if (!cond) process.exitCode = 1; };

// ---- 1. setEnvVar / deleteEnvVar 广播到每个 dashboard ----
{
  const dDefault = await fakeDash();
  const dBull = await fakeDash();
  const be = makeBackend({ default: dDefault, bull: dBull });

  await be.setEnvVar("FOO_API_KEY", "v1");
  await be.deleteEnvVar("FOO_API_KEY");

  const puts = (c) => c.filter((r) => r.method === "PUT" && r.path === "/api/env");
  const dels = (c) => c.filter((r) => r.method === "DELETE" && r.path === "/api/env");
  check("set 广播 default", puts(dDefault.captured).length === 1);
  check("set 广播 bull", puts(dBull.captured).length === 1);
  check("set body 带 key/value", puts(dBull.captured)[0]?.body?.key === "FOO_API_KEY" && puts(dBull.captured)[0]?.body?.value === "v1");
  check("delete 广播 default", dels(dDefault.captured).length === 1);
  check("delete 广播 bull", dels(dBull.captured).length === 1);
  await dDefault.close(); await dBull.close();
}

// ---- 2. 部分失败 = warnings；全部失败 = throw ----
{
  const ok = await fakeDash();
  const bad = await fakeDash({ default: () => ({ code: 500, json: { detail: "boom" } }) });
  const be = makeBackend({ default: ok, bull: bad });
  const r = await be.setEnvVar("K", "v");
  check("部分失败返回 warnings", r.ok === true && Array.isArray(r.warnings) && r.warnings.length === 1 && /bull/.test(r.warnings[0]));

  const bad2 = await fakeDash({ default: () => ({ code: 500, json: {} }) });
  const be2 = makeBackend({ default: bad2, bull: bad2 });
  let threw = false;
  try { await be2.deleteEnvVar("K"); } catch { threw = true; }
  check("全部失败抛错", threw);
  await ok.close(); await bad.close(); await bad2.close();
}

// ---- 2b. DELETE 幂等：只在 default 有的键，bull/horse 返回 404「not found」
//          不算失败（删除目标状态本就达成），不产生 warnings ----
{
  const okDash = await fakeDash(); // default: DELETE 默认 200
  const missing = await fakeDash({ "DELETE /api/env": () => ({ code: 404, json: { detail: "DEEPSEEK_API_KEY not found in .env" } }) });
  const be = makeBackend({ default: okDash, bull: missing });
  const r = await be.deleteEnvVar("DEEPSEEK_API_KEY");
  check("DELETE 404 幂等：无 warnings", r.ok === true && !r.warnings);
  const dels = (c) => c.filter((x) => x.method === "DELETE" && x.path === "/api/env");
  check("DELETE 仍广播到两个 dashboard", dels(okDash.captured).length === 1 && dels(missing.captured).length === 1);
  await okDash.close(); await missing.close();
}

// ---- 2c. DELETE 全 404（键处处不存在）：幂等成功，不抛 ----
{
  const m1 = await fakeDash({ "DELETE /api/env": () => ({ code: 404, json: { detail: "not found" } }) });
  const m2 = await fakeDash({ "DELETE /api/env": () => ({ code: 404, json: { detail: "not found" } }) });
  const be = makeBackend({ default: m1, bull: m2 });
  let threw = false, r = null;
  try { r = await be.deleteEnvVar("GHOST"); } catch { threw = true; }
  check("DELETE 全 404 不抛且成功", !threw && r?.ok === true && !r.warnings);
  await m1.close(); await m2.close();
}

// ---- 2d. DELETE 真实失败（500）仍上报 warnings（不被 404 豁免误伤）----
{
  const okDash = await fakeDash();
  const broken = await fakeDash({ "DELETE /api/env": () => ({ code: 500, json: { detail: "boom" } }) });
  const be = makeBackend({ default: okDash, bull: broken });
  const r = await be.deleteEnvVar("K");
  check("DELETE 500 仍算失败", r.ok === true && r.warnings?.length === 1 && /500/.test(r.warnings[0]));
  await okDash.close(); await broken.close();
}

// ---- 2e. removeModelProvider(env 类，仅 default 有键)：不再误报「部分写入失败」----
{
  const cfg = () => ({ code: 200, json: { providers: {} } });
  const envRow = { DEEPSEEK_API_KEY: { is_set: true, description: "", category: "", is_password: true, provider: "deepseek" } };
  const okDash = await fakeDash({
    "GET /api/config": cfg,
    "GET /api/env": () => ({ code: 200, json: envRow }),
    "GET /api/credentials/pool": () => ({ code: 200, json: { providers: [{ provider: "deepseek", entries: [{ index: 1, source: "env:DEEPSEEK_API_KEY" }] }] } }),
    default: () => ({ code: 200, json: {} }),
  });
  const missing = await fakeDash({
    "GET /api/config": cfg,
    "GET /api/env": () => ({ code: 200, json: {} }), // bull 没有 deepseek 的 env 变量
    "GET /api/credentials/pool": () => ({ code: 200, json: { providers: [] } }),
    "DELETE /api/env": () => ({ code: 404, json: { detail: "DEEPSEEK_API_KEY not found in .env" } }),
    default: () => ({ code: 200, json: {} }),
  });
  const be = makeBackend({ default: okDash, bull: missing });
  const out = await be._withModelChangeCoordinatorContext(
    "env-single-profile",
    () => be.removeModelProvider("deepseek"),
  );
  check("removeModelProvider env 单 default：无 warnings", !out.warnings);
  await okDash.close(); await missing.close();
}

// ---- 3. listEnvVars 聚合：任一 profile is_set → isSet；profile 独有变量并入 ----
{
  const envRow = (isSet, extra = {}) => ({ is_set: isSet, redacted_value: isSet ? "sk-***" : null, description: "", category: "", is_password: true, ...extra });
  const dDefault = await fakeDash({
    "GET /api/env": () => ({ code: 200, json: { DASHSCOPE_API_KEY: envRow(false, { provider: "alibaba" }) } }),
  });
  const dBull = await fakeDash({
    "GET /api/env": () => ({ code: 200, json: {
      DASHSCOPE_API_KEY: envRow(true, { provider: "alibaba" }),
      BULL_ONLY_KEY: envRow(true, { provider: "bullish" }),
    } }),
  });
  const be = makeBackend({ default: dDefault, bull: dBull });
  const rows = await be.listEnvVars();
  const dash = rows.find((r) => r.key === "DASHSCOPE_API_KEY");
  check("聚合 isSet 任一为真", dash?.isSet === true);
  check("profile 独有变量并入", rows.some((r) => r.key === "BULL_ONLY_KEY" && r.isSet));
  await dDefault.close(); await dBull.close();
}

// ---- 4. revealEnvVar：default 空值时回落到有值的 profile ----
{
  const dDefault = await fakeDash({ "POST /api/env/reveal": () => ({ code: 200, json: { value: "" } }) });
  const dBull = await fakeDash({ "POST /api/env/reveal": () => ({ code: 200, json: { value: "sk-bull" } }) });
  const be = makeBackend({ default: dDefault, bull: dBull });
  const r = await be.revealEnvVar("DASHSCOPE_API_KEY");
  check("reveal 回落到有值 profile", r.value === "sk-bull");
  await dDefault.close(); await dBull.close();
}

// ---- 5. _clearProviderPool 逐 dashboard 清（倒序 index）----
{
  const poolJson = { providers: [{ provider: "alibaba", entries: [{ index: 1 }, { index: 2 }] }] };
  const mkRoutes = () => ({
    "GET /api/credentials/pool": () => ({ code: 200, json: poolJson }),
    default: () => ({ code: 200, json: {} }),
  });
  const dDefault = await fakeDash(mkRoutes());
  const dBull = await fakeDash(mkRoutes());
  const be = makeBackend({ default: dDefault, bull: dBull });
  const r = await be._clearProviderPool("alibaba", "env");
  const delPaths = (c) => c.filter((x) => x.method === "DELETE").map((x) => x.path);
  check("pool 清理 default 倒序", JSON.stringify(delPaths(dDefault.captured)) === JSON.stringify(["/api/credentials/pool/alibaba/2", "/api/credentials/pool/alibaba/1"]));
  check("pool 清理 bull 也执行", delPaths(dBull.captured).length === 2);
  check("removed 计数跨 dashboard", r.removed === 4 && r.failures.length === 0);
  await dDefault.close(); await dBull.close();
}

// ---- 6. removeModelProvider：纯凭证池 provider（openai-codex 型）不再误报
//         「不存在或不可编辑」，清掉每个 dashboard 的池条目 ----
{
  const mkRoutes = () => ({
    "GET /api/config": () => ({ code: 200, json: { providers: {} } }),
    "GET /api/env": () => ({ code: 200, json: {} }),
    "GET /api/credentials/pool": () => ({
      code: 200,
      json: { providers: [{ provider: "openai-codex", entries: [{ index: 1, source: "device_code" }] }] },
    }),
    default: () => ({ code: 200, json: {} }),
  });
  const dDefault = await fakeDash(mkRoutes());
  const dBull = await fakeDash(mkRoutes());
  const be = makeBackend({ default: dDefault, bull: dBull });
  let err = null;
  let out = null;
  try {
    out = await be._withModelChangeCoordinatorContext(
      "pool-only-provider",
      () => be.removeModelProvider("openai-codex"),
    );
  } catch (e) { err = e; }
  const delPaths = (c) => c.filter((x) => x.method === "DELETE").map((x) => x.path);
  check("poolOnly 删除不抛错", !err);
  check("poolOnly 删除无 warnings", !!out && !out.warnings);
  check("poolOnly 池清理 default", delPaths(dDefault.captured).includes("/api/credentials/pool/openai-codex/1"));
  check("poolOnly 池清理 bull", delPaths(dBull.captured).includes("/api/credentials/pool/openai-codex/1"));
  await dDefault.close(); await dBull.close();
}

// ---- 7. removeModelProvider：env 变量与池都为空 → 明确报「没有可清除的凭证」 ----
{
  const mkRoutes = () => ({
    "GET /api/config": () => ({ code: 200, json: { providers: {} } }),
    "GET /api/env": () => ({ code: 200, json: {} }),
    "GET /api/credentials/pool": () => ({ code: 200, json: { providers: [] } }),
    default: () => ({ code: 200, json: {} }),
  });
  const d = await fakeDash(mkRoutes());
  const be = makeBackend({ default: d });
  let msg = "";
  try {
    await be._withModelChangeCoordinatorContext(
      "missing-provider",
      () => be.removeModelProvider("ghost-provider"),
    );
  } catch (e) { msg = e.message; }
  check("空 provider 报『没有可清除的凭证』", /没有可清除的凭证/.test(msg));
  await d.close();
}

// ---- 汇总 ----
for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
