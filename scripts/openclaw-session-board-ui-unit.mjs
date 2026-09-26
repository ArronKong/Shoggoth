#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const modelPath = path.join(root, "app/manage-ui/src/pages/chat-session-board/sessionBoardModel.ts");
const viewPath = path.join(root, "app/manage-ui/src/pages/chat-session-board/SessionBoardView.tsx");
const pagePath = path.join(root, "app/manage-ui/src/pages/ChatPage.tsx");
const clientPath = path.join(root, "app/manage-ui/src/api/client.ts");
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-board-ui-"));
const outFile = path.join(outDir, "session-board-model.cjs");

const methods = {
  "board.get": true,
  "board.update": true,
  "board.widget.put": true,
  "board.widget.grant": true,
};
const capabilities = { "board-widget-put-canvas-doc": true };
const widget = {
  name: "status",
  tabId: "main",
  title: "Status",
  content: { kind: "unknown", supported: false },
  sizeW: 6,
  sizeH: 4,
  position: 0,
  grantState: "pending",
  revision: 2,
  instanceId: "instance-2",
};
const result = {
  supported: true,
  methods,
  capabilities,
  snapshot: {
    sessionKey: "agent:main:main",
    revision: 8,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [widget],
  },
};

try {
  execFileSync(path.join(root, "app/manage-ui/node_modules/.bin/esbuild"), [
    modelPath, "--bundle", "--platform=node", "--format=cjs", `--outfile=${outFile}`,
  ], { stdio: "pipe" });
  const model = createRequire(import.meta.url)(outFile);

  assert.equal(model.canReadSessionBoard(result), true);
  assert.equal(model.canReadSessionBoard({ ...result, supported: false, snapshot: null }), false,
    "unsupported responses must not expose board view modes");
  assert.equal(model.canReadSessionBoard({ ...result, methods: { ...methods, "board.get": false } }), false);
  assert.equal(model.canPinCanvasToBoard(result), true);
  assert.equal(model.canPinCanvasToBoard({ ...result, capabilities: { "board-widget-put-canvas-doc": false } }), false);

  const firstScope = model.sessionBoardScopeKey("backend-a", "agent-a", "agent:agent-a:main");
  const secondScope = model.sessionBoardScopeKey("backend-b", "agent-a", "agent:agent-a:main");
  assert.notEqual(firstScope, secondScope, "backend, agent, and session must all isolate board state");
  assert.equal(model.shouldApplySessionBoardResult(4, 4, firstScope, firstScope), true);
  assert.equal(model.shouldApplySessionBoardResult(4, 5, firstScope, firstScope), false);
  assert.equal(model.shouldApplySessionBoardResult(4, 4, firstScope, secondScope), false,
    "a late result from another board scope must be ignored");

  assert.equal(model.shouldAdoptSessionBoardRevision(result, {
    ...result,
    snapshot: { ...result.snapshot, revision: 7 },
  }), false, "a late read cannot overwrite a newer mutation snapshot");
  assert.equal(model.shouldAdoptSessionBoardRevision(result, {
    ...result,
    snapshot: { ...result.snapshot, revision: 9 },
  }), true);

  assert.equal(model.canRejectSessionBoardGrant(result, widget), true);
  assert.equal(model.canApproveSessionBoardGrant(result, widget), false,
    "missing access summary must fail closed for allow");
  assert.equal(model.canApproveSessionBoardGrant(result, {
    ...widget,
    accessSummary: { networkOrigins: ["https://api.example"], tools: ["prompt", "cron.trigger:job-1"] },
  }), true);
  assert.equal(model.canApproveSessionBoardGrant(result, {
    ...widget,
    accessSummary: { networkOrigins: [""], tools: ["prompt"] },
  }), false);
  assert.equal(model.shouldAdoptSessionBoardRevision(result, {
    ...result,
    supported: false,
    reason: "error",
    snapshot: null,
  }), false, "a transient read error must preserve the last verified snapshot");
  assert.equal(model.shouldAdoptSessionBoardRevision(result, {
    ...result,
    supported: false,
    reason: "unsupported",
    snapshot: null,
  }), true, "an explicit capability removal must clear the old snapshot");
  assert.equal(model.sameSessionBoardWidgetIdentity(widget, { ...widget }), true);
  assert.equal(model.sameSessionBoardWidgetIdentity(widget, { ...widget, revision: 3 }), false,
    "confirmation must not act on a replaced widget revision");

  assert.equal(model.sessionBoardContentPresentation(widget), "placeholder");
  assert.equal(model.sessionBoardContentPresentation({
    ...widget,
    content: { kind: "html", supported: false },
    grantState: "none",
  }), "host", "an identity-bound HTML widget may use the M7b.2 safe host");
  assert.equal(model.sessionBoardContentPresentation({
    ...widget,
    content: { kind: "html", supported: false },
    grantState: "pending",
  }), "placeholder", "pending HTML must remain metadata-only");
  assert.equal(model.sessionBoardContentPresentation({
    ...widget,
    content: { kind: "mcp-app", supported: false },
    grantState: "granted",
  }), "placeholder", "MCP App stays out of the M7b.2 host");

  assert.equal(model.shouldRefreshSessionBoardEvent(
    ["board.changed"], "board.changed", "agent:main:main", "agent:main:main",
  ), true);
  assert.equal(model.shouldRefreshSessionBoardEvent(
    [], "board.changed", "agent:main:main", "agent:main:main",
  ), false, "unadvertised board events are not authority");
  assert.equal(model.shouldRefreshSessionBoardEvent(
    ["board.changed"], "board.changed", "agent:main:other", "agent:main:main",
  ), false, "another session's board event cannot invalidate the active board");

  const viewSource = fs.readFileSync(viewPath, "utf8");
  assert.doesNotMatch(viewSource, /dangerouslySetInnerHTML/);
  assert.match(viewSource, /sessionBoardContentPresentation\(widget\)/);
  assert.match(viewSource, /SessionBoardHtmlWidget/);
  assert.match(viewSource, /contentPresentation === "host" && !stale && hostable/,
    "stale board snapshots must revoke executable hosts and render metadata only");
  assert.match(viewSource, /widget\.grantState === "pending"/);
  assert.match(viewSource, /access\.networkOrigins\.map/,
    "the grant surface must list every requested network origin");
  assert.match(viewSource, /access\.tools\.map/,
    "the grant surface must list every requested tool capability");

  const boardSources = [modelPath, viewPath].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(boardSources, /backendId\s*[!=]==?\s*["']|\bopenclaw\b/i,
    "Session Board UI must be capability-driven, not backend-id driven");

  const pageSource = fs.readFileSync(pagePath, "utf8");
  assert.match(pageSource, /const confirm = useConfirm\(\)/);
  assert.match(pageSource, /removeSessionBoardWidget[\s\S]*await confirm\([\s\S]*widget_remove/,
    "destructive removal must require the shared confirmation UI");
  assert.match(pageSource, /decideSessionBoardGrant[\s\S]*await confirm\([\s\S]*grantSessionBoardWidget/,
    "grant decisions must require explicit confirmation");
  assert.match(pageSource, /chat-board-grant-confirm[\s\S]*requestedAccess\.networkOrigins\.map[\s\S]*requestedAccess\.tools\.map/,
    "the final allow confirmation must repeat every exact requested capability");
  assert.match(pageSource, /sameSessionBoardWidgetIdentity\(widget, currentWidget\)/,
    "confirm-open races must revalidate the widget identity before mutation");
  assert.match(pageSource, /currentBoardRevision !== boardRevision/,
    "remove confirmation must also reject an observed Board revision ABA");
  assert.match(pageSource, /sessionBoardMutationChainRef\.current\.then\(run, run\)/,
    "board mutations must be serialized");
  assert.match(pageSource, /catch \(error\)[\s\S]*sessionBoardStaleRef\.current = true[\s\S]*setSessionBoardStale\(true\)[\s\S]*throw error/,
    "an uncertain mutation must freeze the queue until a verified refresh succeeds");
  assert.match(pageSource, /if \(!sessionBoardStaleRef\.current\) setSessionBoardStale\(false\)/,
    "an older mutation response must not clear stale state raised by board.changed");
  assert.match(pageSource, /sessionBoardProbeEpochRef\.current \+= 1;[\s\S]*setSessionBoardLoading\(false\)/,
    "starting a mutation must invalidate an older board read");
  assert.match(pageSource, /shouldRefreshSessionBoardEvent\([\s\S]*setSessionBoardReload/,
    "advertised board.changed events must invalidate the active board");
  const boardChangedHandler = pageSource.slice(
    pageSource.indexOf('f.type === "event" && shouldRefreshSessionBoardEvent'),
    pageSource.indexOf("intentionally defers board.command"),
  );
  assert.match(boardChangedHandler,
    /sessionBoardProbeEpochRef\.current \+= 1;[\s\S]*setSessionBoardLoading\(false\)[\s\S]*sessionBoardStaleRef\.current = true/,
    "board.changed must invalidate an in-flight board.get before freezing and scheduling its verified refresh");
  assert.match(pageSource, /intentionally defers board\.command/,
    "remote focus/dock commands stay explicitly deferred in M7b.1");
  assert.doesNotMatch(pageSource, /chat-board-modes|\["chat", "split", "dashboard"\]/,
    "the session Board view switch stays hidden until the frontend feature is restored");

  const clientSource = fs.readFileSync(clientPath, "utf8");
  assert.match(clientSource, /session-board\/pin-canvas[\s\S]*JSON\.stringify\(\{ backend, agentId, sessionKey, spec \}\)/);
  assert.match(clientSource, /session-board\/grant[\s\S]*JSON\.stringify\(\{ backend, agentId, sessionKey, spec: input \}\)/);
  const pinFunction = clientSource.slice(
    clientSource.indexOf("export async function pinSessionCanvas"),
    clientSource.indexOf("export async function grantSessionBoardWidget"),
  );
  assert.doesNotMatch(pinFunction, /html|rawText|url/i,
    "pinning sends only the stable widget identity and Canvas document id/spec metadata");

  console.log("openclaw-session-board-ui-unit: PASS");
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
