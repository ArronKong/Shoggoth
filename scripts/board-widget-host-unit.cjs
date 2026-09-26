#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const vm = require("node:vm");
const {
  BOARD_WIDGET_BRIDGE_TYPES,
  BOARD_WIDGET_MAX_HTML_BYTES,
  BOARD_WIDGET_MAX_TICKETS,
  BOARD_WIDGET_MAX_TOTAL_BYTES,
  BOARD_WIDGET_READY_TTL_MS,
  BOARD_WIDGET_TICKET_TTL_MS,
  createBoardWidgetHost,
} = require("../app/board-widget-host");

const UI_ORIGIN = "http://127.0.0.1:18799";

function identity(overrides = {}) {
  const viewGeneration = overrides.viewGeneration || "0123456789abcdef0123456789abcdef";
  return {
    backend: "openclaw",
    agentId: "main",
    sessionKey: "agent:main:main",
    boardRevision: 7,
    viewGeneration,
    name: "weather.card",
    revision: 3,
    instanceId: viewGeneration,
    ...overrides,
  };
}

function issue(host, overrides = {}) {
  return host.issue({
    owner: 41,
    scope: "openclaw\0main\0agent:main:main",
    html: Buffer.from("<!doctype html><p>safe widget</p>", "utf8"),
    identity: identity(),
    ...overrides,
  });
}

function getHeaders(overrides = {}) {
  return {
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "iframe",
    Referer: `${UI_ORIGIN}/#/chat`,
    ...overrides,
  };
}

function headHeaders(overrides = {}) {
  return {
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    Origin: UI_ORIGIN,
    Referer: `${UI_ORIGIN}/#/chat`,
    ...overrides,
  };
}

function request(target, options = {}) {
  const url = new URL(target);
  const headers = { ...(options.headers || {}) };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete headers[name];
  }
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: url.port,
      path: options.path || `${url.pathname}${url.search}`,
      method: options.method || "GET",
      headers,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

class FakeClock {
  constructor() {
    this.value = 10_000;
    this.nextId = 1;
    this.timers = new Map();
  }

  now = () => this.value;

  setTimeout = (callback, delay) => {
    const id = this.nextId;
    this.nextId += 1;
    const handle = { id, unref() {} };
    this.timers.set(id, { callback, at: this.value + delay });
    return handle;
  };

  clearTimeout = (handle) => {
    if (handle) this.timers.delete(handle.id);
  };

  jump(ms) {
    this.value += ms;
  }

  advance(ms) {
    this.jump(ms);
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.value)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test("options require one exact IPv4 loopback UI origin", () => {
  for (const uiOrigin of [
    undefined,
    "http://localhost:18799",
    "http://127.0.0.1",
    "http://127.0.0.1:18799/",
    "https://127.0.0.1:18799",
    "http://user@127.0.0.1:18799",
  ]) {
    assert.throws(
      () => createBoardWidgetHost({ uiOrigin }),
      (error) => error?.code === "BOARD_WIDGET_HOST_OPTIONS_INVALID",
    );
  }
});

test("HEAD probes, request guards, one-shot GET, shell, and ready lease are closed", async () => {
  const host = createBoardWidgetHost({ uiOrigin: UI_ORIGIN });
  try {
    const started = await host.start();
    assert.match(started.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.notEqual(started.origin, UI_ORIGIN);

    const source = "<!doctype html><script>globalThis.attackMarker='never plaintext'</script>";
    const callerBuffer = Buffer.from(source, "utf8");
    const minted = issue(host, { html: callerBuffer });
    callerBuffer.fill(0);
    assert.equal(Buffer.from(minted.ticket, "base64url").length, 32);
    assert.equal(Buffer.from(minted.nonce, "base64url").length, 24);
    assert.equal(Object.isFrozen(minted), true);
    assert.equal(Object.isFrozen(minted.identity), true);
    assert.deepEqual(minted.identity, identity());
    assert.deepEqual(host.stats(), { tickets: 1, bytes: Buffer.byteLength(source), issued: 1, claimed: 0, active: 0 });

    const probe = await request(minted.url, { method: "HEAD", headers: headHeaders() });
    assert.equal(probe.status, 200);
    assert.equal(probe.body, "");
    assert.equal(probe.headers["access-control-allow-origin"], UI_ORIGIN);
    assert.equal(host.stats().issued, 1, "HEAD must not consume an issued ticket");

    const invalidRequests = [
      { path: `${new URL(minted.url).pathname}?x=1`, headers: getHeaders() },
      { path: `${new URL(minted.url).pathname}#fragment`, headers: getHeaders() },
      { path: new URL(minted.url).pathname.replace("board-widget", "board%2Dwidget"), headers: getHeaders() },
      { path: `http://127.0.0.1:${started.port}${new URL(minted.url).pathname}`, headers: getHeaders() },
      { headers: getHeaders({ Host: "localhost" }) },
      { headers: getHeaders({ Cookie: "secret=1" }) },
      { headers: getHeaders({ Authorization: "Bearer secret" }) },
      { headers: getHeaders({ "Proxy-Authorization": "Basic secret" }) },
      { headers: getHeaders({ Range: "bytes=0-1" }) },
      { headers: getHeaders({ "Content-Length": "0" }) },
      { headers: getHeaders({ "Sec-Fetch-Site": "cross-site" }) },
      { headers: getHeaders({ "Sec-Fetch-Mode": "cors" }) },
      { headers: getHeaders({ "Sec-Fetch-Dest": "document" }) },
      { headers: getHeaders({ Referer: null }) },
      { headers: getHeaders({ Referer: "http://127.0.0.1:18888/" }) },
      { headers: getHeaders({ Origin: "http://127.0.0.1:18888" }) },
      { method: "HEAD", headers: headHeaders({ Origin: null }) },
      { method: "HEAD", headers: headHeaders({ Origin: "http://127.0.0.1:18888" }) },
      { method: "HEAD", headers: headHeaders({ "Sec-Fetch-Dest": "iframe" }) },
    ];
    for (const spec of invalidRequests) {
      const response = await request(minted.url, spec);
      assert.equal(response.status, 404, JSON.stringify(spec));
      assert.equal(response.headers["cache-control"], "no-store, max-age=0");
    }
    const wrongMethod = await request(minted.url, { method: "POST", headers: getHeaders() });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, "GET, HEAD");
    assert.equal(host.stats().issued, 1, "wrong methods must not consume a ticket");
    assert.equal((await request(minted.url, { method: "HEAD", headers: headHeaders() })).status, 200);

    const loaded = await request(minted.url, { headers: getHeaders() });
    assert.equal(loaded.status, 200);
    assert.equal(loaded.headers["access-control-allow-origin"], undefined);
    assert.match(loaded.headers["content-security-policy"], /sandbox allow-scripts/u);
    assert.match(loaded.headers["content-security-policy"], /connect-src 'none'/u);
    assert.match(loaded.headers["content-security-policy"], /frame-ancestors http:\/\/127\.0\.0\.1:18799/u);
    assert.match(loaded.headers["permissions-policy"], /camera=\(\)/u);
    assert.equal(loaded.headers["cross-origin-resource-policy"], "same-site");
    assert.equal(loaded.body.includes(source), false);
    assert.equal(loaded.body.includes(Buffer.from(source).toString("base64")), true);
    assert.match(loaded.body, /new TextDecoder\("utf-8",\{fatal:true\}\)/u);
    assert.match(loaded.body, /frame\.srcdoc=/u);
    assert.equal((loaded.body.match(/const bytes=new Uint8Array\(binary\.length\)/gu) || []).length, 1);
    const script = /<script>([\s\S]*)<\/script>/u.exec(loaded.body)?.[1];
    assert.equal(typeof script, "string");
    assert.doesNotThrow(() => new vm.Script(script));
    assert.match(loaded.body, /frame\.setAttribute\("sandbox",""\)/u);
    assert.match(loaded.body, /frame\.setAttribute\("allow",""\)/u);
    assert.match(loaded.body, /frame\.setAttribute\("csp",innerCsp\)/u);
    assert.match(loaded.body, /script-src 'none'/u);
    assert.equal(loaded.body.includes("allow-same-origin"), false);
    assert.equal(loaded.body.includes("innerHTML"), false);
    assert.doesNotMatch(loaded.body, /types\.(?:prompt|action|cron)|["'](?:prompt|action|cron)["']\s*:/u);
    assert.equal(loaded.body.includes(BOARD_WIDGET_BRIDGE_TYPES.bootstrap), true);
    assert.equal(loaded.body.includes(BOARD_WIDGET_BRIDGE_TYPES.connect), true);
    assert.match(loaded.body, /window\.parent\.postMessage\(\{type:types\.bootstrap,nonce\},uiOrigin\)/u);
    assert.match(loaded.body, /event\.source===window\.parent&&event\.origin===uiOrigin&&event\.ports\.length===1/u);
    assert.match(loaded.body, /closePorts\(event\)/u);
    assert.deepEqual(host.stats(), { tickets: 1, bytes: Buffer.byteLength(source), issued: 0, claimed: 1, active: 0 });

    assert.equal((await request(minted.url, { headers: getHeaders() })).status, 404);
    assert.equal((await request(minted.url, { method: "HEAD", headers: headHeaders() })).status, 404);
    assert.equal(host.markReady({ ticket: minted.ticket, nonce: "A".repeat(32), owner: 41, scope: "openclaw\0main\0agent:main:main" }), false);
    assert.equal(host.markReady({ ticket: minted.ticket, nonce: minted.nonce, owner: 42, scope: "openclaw\0main\0agent:main:main" }), false);
    assert.equal(host.markReady({ ticket: minted.ticket, nonce: minted.nonce, owner: 41, scope: "wrong" }), false);
    assert.equal(host.stats().bytes, Buffer.byteLength(source));
    assert.equal(host.markReady({
      ticket: minted.ticket,
      nonce: minted.nonce,
      owner: 41,
      scope: "openclaw\0main\0agent:main:main",
    }), true);
    assert.deepEqual(host.stats(), { tickets: 1, bytes: 0, issued: 0, claimed: 0, active: 1 });
    assert.equal(host.markReady({
      ticket: minted.ticket,
      nonce: minted.nonce,
      owner: 41,
      scope: "openclaw\0main\0agent:main:main",
    }), false);
    assert.equal(host.revokeTicket(minted.ticket), 1);
    assert.equal(host.revokeTicket(minted.ticket), 0);
    assert.deepEqual(host.stats(), { tickets: 0, bytes: 0, issued: 0, claimed: 0, active: 0 });
  } finally {
    await host.close();
  }
});

test("only one concurrent GET claims a ticket", async () => {
  const host = createBoardWidgetHost({ uiOrigin: UI_ORIGIN });
  try {
    await host.start();
    const minted = issue(host);
    const responses = await Promise.all([
      request(minted.url, { headers: getHeaders() }),
      request(minted.url, { headers: getHeaders() }),
    ]);
    assert.deepEqual(responses.map((item) => item.status).sort(), [200, 404]);
    assert.equal(host.stats().claimed, 1);
  } finally {
    await host.close();
  }
});

test("issued and claimed deadlines fail closed and release payloads", async () => {
  const clock = new FakeClock();
  const host = createBoardWidgetHost({
    uiOrigin: UI_ORIGIN,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  try {
    await host.start();
    const issued = issue(host);
    assert.equal(issued.expiresAt, 10_000 + BOARD_WIDGET_TICKET_TTL_MS);
    clock.jump(BOARD_WIDGET_TICKET_TTL_MS);
    assert.equal((await request(issued.url, { method: "HEAD", headers: headHeaders() })).status, 404);
    assert.deepEqual(host.stats(), { tickets: 0, bytes: 0, issued: 0, claimed: 0, active: 0 });

    const claimed = issue(host);
    assert.equal((await request(claimed.url, { headers: getHeaders() })).status, 200);
    clock.jump(BOARD_WIDGET_READY_TTL_MS);
    assert.equal(host.markReady({
      ticket: claimed.ticket,
      nonce: claimed.nonce,
      owner: 41,
      scope: "openclaw\0main\0agent:main:main",
    }), false);
    assert.deepEqual(host.stats(), { tickets: 0, bytes: 0, issued: 0, claimed: 0, active: 0 });

    const timerRevoked = issue(host);
    assert.equal((await request(timerRevoked.url, { headers: getHeaders() })).status, 200);
    clock.advance(BOARD_WIDGET_READY_TTL_MS);
    assert.equal(host.stats().tickets, 0);
  } finally {
    await host.close();
  }
});

test("capacity never evicts live tickets and malformed HTML is rejected", async () => {
  assert.equal(BOARD_WIDGET_MAX_TICKETS * BOARD_WIDGET_MAX_HTML_BYTES, BOARD_WIDGET_MAX_TOTAL_BYTES);
  const host = createBoardWidgetHost({ uiOrigin: UI_ORIGIN });
  try {
    await host.start();
    assert.throws(
      () => issue(host, { html: Buffer.alloc(BOARD_WIDGET_MAX_HTML_BYTES + 1, 0x61) }),
      (error) => error?.code === "BOARD_WIDGET_HOST_INPUT_INVALID",
    );
    assert.throws(
      () => issue(host, { html: Buffer.from([0xc3, 0x28]) }),
      (error) => error?.code === "BOARD_WIDGET_HOST_INPUT_INVALID",
    );
    const empty = issue(host, { html: Buffer.alloc(0) });
    assert.equal(host.revokeTicket(empty.ticket), 1, "an upstream-valid empty HTML document remains renderable");
    const tickets = [];
    for (let index = 0; index < BOARD_WIDGET_MAX_TICKETS; index += 1) {
      tickets.push(issue(host, {
        identity: identity({
          name: `widget-${index}`,
          viewGeneration: index.toString(16).padStart(32, "0"),
        }),
      }));
    }
    assert.equal(host.stats().tickets, BOARD_WIDGET_MAX_TICKETS);
    assert.throws(
      () => issue(host, { identity: identity({ name: "overflow" }) }),
      (error) => error?.code === "BOARD_WIDGET_HOST_CAPACITY",
    );
    assert.equal((await request(tickets[0].url, { method: "HEAD", headers: headHeaders() })).status, 200);
    assert.equal(host.revokeAll(), BOARD_WIDGET_MAX_TICKETS);
    assert.equal(host.revokeAll(), 0);
    assert.equal(host.stats().bytes, 0);
  } finally {
    await host.close();
  }
});

test("scope, owner, and global revocation are idempotent", async () => {
  const host = createBoardWidgetHost({ uiOrigin: UI_ORIGIN });
  try {
    await host.start();
    issue(host, { owner: 1, scope: "scope-a", identity: identity({ name: "one" }) });
    issue(host, { owner: 1, scope: "scope-a", identity: identity({ name: "two" }) });
    issue(host, { owner: 1, scope: "scope-b", identity: identity({ name: "three" }) });
    issue(host, { owner: 2, scope: "scope-a", identity: identity({ name: "four" }) });
    assert.equal(host.revokeScope(1, "scope-a"), 2);
    assert.equal(host.revokeScope(1, "scope-a"), 0);
    assert.equal(host.revokeOwner(1), 1);
    assert.equal(host.revokeOwner(1), 0);
    assert.equal(host.revokeAll(), 1);
    assert.equal(host.revokeAll(), 0);
    assert.deepEqual(host.stats(), { tickets: 0, bytes: 0, issued: 0, claimed: 0, active: 0 });
  } finally {
    await host.close();
  }
});

(async () => {
  let passed = 0;
  for (const entry of tests) {
    await entry.run();
    passed += 1;
    process.stdout.write(`ok ${passed} - ${entry.name}\n`);
  }
  process.stdout.write(`Board Widget host unit: ${passed}/${tests.length} passed\n`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
