#!/usr/bin/env node

// Regression: BUG-005 — creating a task while viewing a non-current Hermes
// board must keep the selected board on both the create request and the optional
// follow-up column move.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { HermesBackend } from "../app/core/hermes-backend.js";

const captured = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    captured.push({ method: req.method, url: req.url, raw });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "POST") {
      res.end(JSON.stringify({ task: { id: 42, title: "created", status: "todo" } }));
      return;
    }
    res.end(JSON.stringify({ task: { id: 42, title: "created", status: "done" } }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const backend = new HermesBackend({ getConfig: () => ({ hermesMode: "local", hermesRemotes: [] }) });
  backend.dashboards.set("default", { profile: "default", baseUrl, token: "tok" });

  await backend.createTask({ title: "created", column: "done" }, { board: "board-b" });
  const create = captured.find((entry) => entry.method === "POST" && entry.url.includes("/tasks"));
  const move = captured.find((entry) => entry.method === "PATCH" && entry.url.includes("/tasks/42"));
  assert.match(create?.url || "", /[?&]board=board-b(?:&|$)/, "create must target the viewed board");
  assert.match(move?.url || "", /[?&]board=board-b(?:&|$)/, "follow-up move must stay on the viewed board");
  console.log("PASS Hermes task creation preserves board context");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
