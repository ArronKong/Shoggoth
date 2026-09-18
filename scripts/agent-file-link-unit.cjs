"use strict";

// Unit test for the workspace **link-file** fallback in openclaw-backend
// (R364). 网关的 agents.files.* 一律拒链接类文件（read 传 hardlinks:"reject"、
// list 的 stat 要求 !isSymbolicLink && nlink<=1），软链身份文件因此读写报
// `unsafe workspace file "<name>"`、列表里没有大小/时间。本机网关下我们按链接
// 目标兜底。这里钉住的是兜底的**边界**：只对本机、只对网关名单里的名字、只对
// 直属 workspace 的链接条目生效，其余一律把网关原错抛出去。
// Run: node scripts/agent-file-link-unit.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { OpenClawBackend } = require("../app/core/openclaw-backend");

const UNSAFE = 'unsafe workspace file';
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-file-link-"));
const ws = path.join(root, "agents", "cto");
const shared = path.join(root, "workspace");
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(shared, { recursive: true });

// TOOLS.md = 软链到 workspace 外的共享文件（用户的真实形状）
fs.writeFileSync(path.join(shared, "TOOLS.md"), "# shared tools\n");
fs.symlinkSync(path.join(shared, "TOOLS.md"), path.join(ws, "TOOLS.md"));
// SOUL.md = 普通文件（对照组，必须继续走网关）
fs.writeFileSync(path.join(ws, "SOUL.md"), "# soul\n");
// USER.md = 硬链接（网关的 nlink<=1 同样拒）
fs.writeFileSync(path.join(shared, "USER.md"), "# shared user\n");
fs.linkSync(path.join(shared, "USER.md"), path.join(ws, "USER.md"));
// HEARTBEAT.md = 断链（目标不存在 → 保持网关的 missing 语义，不兜底）
fs.symlinkSync(path.join(shared, "gone.md"), path.join(ws, "HEARTBEAT.md"));
// secrets.md = workspace 里的软链，但**不在**网关名单里 → 不许读（防绕过白名单）
fs.writeFileSync(path.join(root, "secrets.md"), "TOP SECRET\n");
fs.symlinkSync(path.join(root, "secrets.md"), path.join(ws, "secrets.md"));

// 网关名单：软链条目 gateway 报 missing（无 size/updatedAtMs），普通文件带 stat
const GATEWAY_FILES = [
  { name: "AGENTS.md", missing: true },
  { name: "SOUL.md", size: 7, updatedAtMs: 111 },
  { name: "TOOLS.md", missing: true },
  { name: "USER.md", missing: true },
  { name: "HEARTBEAT.md", missing: true },
];

function makeBackend({ local = true, workspace = ws } = {}) {
  const b = new OpenClawBackend();
  b._connect = async () => {};
  b._isLocalGateway = () => local;
  b.request = async (method, params) => {
    if (method === "agents.files.list") return { workspace, files: GATEWAY_FILES };
    if (method === "agents.files.get") {
      if (params.name === "SOUL.md") return { file: { name: "SOUL.md", content: "# soul\n" } };
      throw new Error(`${UNSAFE} "${params.name}"`);
    }
    if (method === "agents.files.set") {
      if (params.name === "SOUL.md") return { ok: true };
      throw new Error(`${UNSAFE} "${params.name}"`);
    }
    throw new Error(`unexpected rpc ${method}`);
  };
  return b;
}

(async () => {
  try {
    // --- 读：软链 / 硬链都按目标内容返回 ---
    assert.deepEqual(
      await makeBackend().getAgentFile("cto", "TOOLS.md"),
      { name: "TOOLS.md", content: "# shared tools\n", missing: false },
      "软链条目应读到链接目标的内容，而不是把网关的 unsafe 抛出去",
    );
    assert.equal(
      (await makeBackend().getAgentFile("cto", "USER.md")).content,
      "# shared user\n",
      "硬链接（nlink>1）网关同样拒，也要兜底",
    );

    // --- 读：普通文件仍然走网关，兜底不越权接管 ---
    assert.equal(
      (await makeBackend().getAgentFile("cto", "SOUL.md")).content,
      "# soul\n",
      "普通文件必须走网关原路径",
    );

    // --- 列表：软链条目补回 size/modifiedAt，普通文件保持网关值 ---
    const listed = await makeBackend().listAgentFiles("cto");
    const byName = Object.fromEntries(listed.map((f) => [f.name, f]));
    assert.equal(byName["TOOLS.md"].size, "# shared tools\n".length, "软链应显示目标大小");
    assert.ok(byName["TOOLS.md"].modifiedAt > 0, "软链应显示目标修改时间");
    assert.deepEqual(
      { size: byName["SOUL.md"].size, modifiedAt: byName["SOUL.md"].modifiedAt },
      { size: 7, modifiedAt: 111 },
      "普通文件的 stat 仍以网关为准",
    );
    assert.equal(byName["AGENTS.md"].size, undefined, "磁盘上不存在的条目保持 missing");
    assert.equal(byName["HEARTBEAT.md"].size, undefined, "断链保持 missing，不假装存在");

    // --- 写：落到链接目标，链接本身不被替换成普通文件 ---
    const w = makeBackend();
    assert.deepEqual(await w.setAgentFile("cto", "TOOLS.md", "# edited\n"), { ok: true });
    assert.equal(fs.readFileSync(path.join(shared, "TOOLS.md"), "utf8"), "# edited\n", "写应落到链接目标");
    assert.ok(fs.lstatSync(path.join(ws, "TOOLS.md")).isSymbolicLink(), "链接不能被写成普通文件");

    // --- 边界：以下四种都必须把网关原错抛出去 ---
    const rejects = [
      ["名单外的软链（防绕过网关白名单读任意路径）", makeBackend(), "secrets.md"],
      ["断链", makeBackend(), "HEARTBEAT.md"],
      ["路径逃逸", makeBackend(), "../secrets.md"],
      ["子目录", makeBackend(), "sub/TOOLS.md"],
    ];
    for (const [label, backend, name] of rejects) {
      await assert.rejects(
        () => backend.getAgentFile("cto", name),
        (err) => err.message.includes(UNSAFE),
        `${label} 不该兜底`,
      );
    }
    assert.equal(fs.readFileSync(path.join(root, "secrets.md"), "utf8"), "TOP SECRET\n", "名单外文件不该被读走");

    // --- 边界：远程网关不碰本机磁盘（本机的同名文件与远程无关）---
    await assert.rejects(
      () => makeBackend({ local: false }).getAgentFile("cto", "TOOLS.md"),
      (err) => err.message.includes(UNSAFE),
      "远程网关下不许拿本机文件冒充",
    );
    const remoteListed = await makeBackend({ local: false }).listAgentFiles("cto");
    assert.equal(
      remoteListed.find((f) => f.name === "TOOLS.md").size,
      undefined,
      "远程网关的列表也不许用本机 stat 补齐",
    );

    fs.rmSync(root, { recursive: true, force: true });
    console.log("✓ agent-file-link-unit: all cases passed");
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    console.error(err);
    process.exit(1);
  }
})();
