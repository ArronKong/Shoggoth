#!/usr/bin/env node
"use strict";

// Normal LaunchServices launch on an empty, disposable GitHub-hosted account.
// Quarantine is assigned to the exact downloaded draft App for this check;
// this is controlled quarantine evidence, not a browser-download claim.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { execFileSync, spawn } = require("node:child_process");
const { randomUUID, createHash } = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");

function command(executable, args, timeout = 15000) {
  try {
    return execFileSync(executable, args, { encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    if (executable === "/usr/bin/xcrun" && args[0] === "stapler" && args[1] === "validate") {
      console.error("STAPLER_VALIDATE_FAILED " + JSON.stringify({ status: error.status, signal: error.signal,
        stdout: String(error.stdout || "").slice(0, 2000), stderr: String(error.stderr || "").slice(0, 2000) }));
    }
    throw error;
  }
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function embeddingWorkerCommand(binary) {
  return `${binary} ${path.join(path.dirname(path.dirname(binary)), "Resources/app.asar/app/agent-service/embedding-worker.cjs")}`;
}
function guiProcessRecords(output, binary) {
  return output.trim().split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    if (!match || (match[2] !== binary && !match[2].startsWith(`${binary} `))
      || match[2].includes("--shoggoth-internal-role=") || match[2] === embeddingWorkerCommand(binary)) return [];
    return [{ pid: Number(match[1]), command: match[2] }];
  });
}
function mainProcessRecords(binary) {
  return guiProcessRecords(command("/bin/ps", ["-axo", "pid=,args="]), binary);
}
function embeddingProcessRecords(binary) {
  const expected = embeddingWorkerCommand(binary);
  return command("/bin/ps", ["-axo", "pid=,args="]).trim().split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    return match?.[2] === expected ? [{ pid: Number(match[1]), command: match[2] }] : [];
  });
}
function mainProcesses(binary) { return mainProcessRecords(binary).map(item => item.pid); }
const ORDINARY_OPEN_SCRIPT = `tell application "System Events"
  if exists process "CoreServicesUIAgent" then
    tell process "CoreServicesUIAgent"
      repeat with w in windows
        if exists button "Open" of w then
          click button "Open" of w
          return "ordinary-open-confirmed"
        end if
      end repeat
    end tell
  end if
  return "no-ordinary-open-prompt"
end tell`;

function quitScript(pid) {
  assert.ok(Number.isInteger(pid) && pid > 0 && pid <= 2147483647, "Invalid verified GUI PID");
  return `tell application "System Events"
  set targetProcess to first process whose unix id is ${pid}
  set frontmost of targetProcess to true
  tell targetProcess
    keystroke "q" using command down
  end tell
end tell`;
}

async function quitAndWait(binary, pid, evidence, dependencies = {}) {
  const readProcesses = dependencies.readProcesses || mainProcesses;
  const runCommand = dependencies.runCommand || command;
  const wait = dependencies.wait || delay;
  const script = quitScript(pid);
  assert.deepEqual(readProcesses(binary), [pid], "Quit target is not the sole verified GUI process");
  evidence.quitMethod = "System Events Cmd+Q to verified GUI PID";
  evidence.quitTargetPid = pid;
  runCommand("/usr/bin/osascript", ["-e", script]);
  for (let attempt = 0; attempt < 120 && readProcesses(binary).length; attempt++) await wait(500);
  assert.deepEqual(readProcesses(binary), [], "GUI failed to quit normally");
  evidence.naturalGuiExit = true;
}

async function launchAndWait(app, binary, evidence, dependencies = {}) {
  const spawnProcess = dependencies.spawnProcess || spawn;
  const readProcesses = dependencies.readProcesses || mainProcesses;
  const runCommand = dependencies.runCommand || command;
  const wait = dependencies.wait || delay;
  // LaunchServices can keep `open` pending until the ordinary download prompt
  // is confirmed. Keep the existing 15s command budget while polling that UI.
  const launcher = spawnProcess("/usr/bin/open", ["-n", app], { stdio: "ignore", timeout: 15000 });
  let result;
  launcher.once("error", error => { result = { error }; });
  launcher.once("close", (code, signal) => { result = { ...result, code, signal }; });
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (result?.error) throw result.error;
      if (result && Object.hasOwn(result, "code")) {
        assert.equal(result.code, 0, "LaunchServices open failed or timed out");
        assert.equal(result.signal, null, "LaunchServices open did not exit normally");
      }
      const candidates = readProcesses(binary);
      assert.ok(candidates.length <= 1, "Unexpected duplicate GUI process");
      if (candidates.length === 1 && result?.code === 0 && result.signal === null) {
        evidence.launcherNaturalExit = { code: result.code, signal: result.signal };
        return candidates[0];
      }
      if (attempt === 20) {
        // Accept only the ordinary Internet-download Open prompt. A damaged,
        // untrusted, or privacy-permission dialog has no matching action here.
        try {
          const answer = runCommand("/usr/bin/osascript", ["-e", ORDINARY_OPEN_SCRIPT]);
          evidence.normalOpenConfirmation = answer.trim() === "ordinary-open-confirmed";
        } catch { evidence.ordinaryOpenAutomationFailed = true; }
      }
      await wait(500);
    }
    assert.fail("Normal quarantined GUI did not launch");
  } finally {
    if (!result || !Object.hasOwn(result, "code")) launcher.kill("SIGTERM");
  }
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node scripts/shoggoth-quarantined-first-launch.cjs --app /absolute/Shoggoth.app --output /absolute/new-directory (disposable GitHub-hosted runner only)");
    return;
  }
  // These guards precede every filesystem write, xattr change and App launch.
  assert.equal(process.platform, "darwin");
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(os.userInfo().username, "runner");
  assert.equal(os.userInfo().homedir, "/Users/runner");
  assert.equal(process.argv.length, 6);
  assert.equal(process.argv[2], "--app");
  assert.equal(process.argv[4], "--output");
  const sourceApp = path.resolve(process.argv[3]), output = path.resolve(process.argv[5]);
  assert.equal(path.isAbsolute(process.argv[3]), true);
  assert.equal(path.isAbsolute(process.argv[5]), true);
  assert.equal(inside(path.join(fs.realpathSync(process.env.GITHUB_WORKSPACE), "dist"), sourceApp), true);
  assert.equal(inside(fs.realpathSync(process.env.RUNNER_TEMP), output), true);
  assert.equal(fs.existsSync(output), false);
  const home = os.userInfo().homedir;
  for (const relative of ["Library/Application Support/Shoggoth", "Library/LaunchAgents/com.shoggoth.agent-service.plist", ".openclaw", ".hermes"]) {
    assert.equal(fs.existsSync(path.join(home, relative)), false, "First-launch proof requires an empty disposable product account");
  }
  const app = "/Applications/Shoggoth.app";
  assert.equal(fs.lstatSync("/Applications").isSymbolicLink(), false);
  assert.equal(fs.existsSync(app), false, "First-launch check must never replace an installed App");
  const marker = JSON.parse(fs.readFileSync(path.join(sourceApp, "Contents/Resources/shoggoth-release.json"), "utf8"));
  assert.equal(marker.distribution, "official");
  assert.equal(marker.signingMode, "developer-id");
  assert.equal(marker.version, require("../package.json").version);
  const binary = path.join(app, "Contents/MacOS/Shoggoth");
  assert.deepEqual(mainProcesses(binary), []);
  const gatekeeper = command("/usr/sbin/spctl", ["--status"]).trim();
  assert.equal(gatekeeper, "assessments enabled", "GUI proof requires enforced Gatekeeper");
  command("/usr/bin/codesign", ["--verify", "--deep", "--strict", sourceApp], 180000);
  command("/usr/bin/xcrun", ["stapler", "validate", sourceApp], 60000);
  command("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", sourceApp], 60000);
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  const evidence = { version: marker.version, launch: "LaunchServices open -n; no runtime role or data-root override",
    account: "empty disposable GitHub-hosted runner", gatekeeper, installedApp: app,
    downloadProvenance: "exact draft download copied to the disposable runner Applications directory with controlled quarantine",
    browserDownloadVerified: false, quarantineRemoved: false, normalOpenConfirmation: false, verified: false };
  let launched = false, guiPid;
  const screenshot = () => {
    try { command("/usr/sbin/screencapture", ["-x", path.join(output, "first-launch.png")]); } catch { /* keep the original failure */ }
  };
  try {
    // The product deliberately refuses background-service installation from
    // an unstable folder. Exercise the same /Applications path as a user install.
    command("/usr/bin/sudo", ["/bin/cp", "-cRp", sourceApp, app], 180000);
    for (const relative of ["Contents/MacOS/Shoggoth", "Contents/Resources/app.asar"]) {
      const hash = root => createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex");
      assert.equal(hash(app), hash(sourceApp), "Installed draft payload differs");
    }
    command("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], 180000);
    command("/usr/bin/xcrun", ["stapler", "validate", app], 60000);
    evidence.installedPayloadMatchesDraft = true;
    const quarantine = `0001;${Math.floor(Date.now() / 1000).toString(16)};ShoggothReleaseVerification;${randomUUID()}`;
    command("/usr/bin/xattr", ["-w", "com.apple.quarantine", quarantine, app]);
    evidence.quarantineBefore = command("/usr/bin/xattr", ["-p", "com.apple.quarantine", app]).trim();
    launched = true;
    const pid = await launchAndWait(app, binary, evidence);
    guiPid = pid;
    await delay(10000);
    assert.deepEqual(mainProcesses(binary), [pid]);
    const renderer = command("/bin/ps", ["-axo", "ppid=,args="]).split("\n")
      .some(line => line.trim().startsWith(`${pid} `) && line.includes("--type=renderer"));
    assert.equal(renderer, true, "Normal GUI renderer is absent");
    const listeners = command("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP:18799", "-sTCP:LISTEN", "-Fp"]);
    assert.ok(listeners.split("\n").includes(`p${pid}`), "UI server belongs to another process");
    const response = await fetch("http://127.0.0.1:18799/", { signal: AbortSignal.timeout(10000), redirect: "error" });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<div id="root"><\/div>/u);
    const swift = path.join(output, "windows.swift");
    fs.writeFileSync(swift, 'import Foundation\nimport CoreGraphics\nlet pid = Int(CommandLine.arguments[1])!\nlet all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []\nlet windows = all.filter { ($0[kCGWindowOwnerPID as String] as? Int) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }.compactMap { $0[kCGWindowBounds as String] as? [String: Any] }\nlet data = try JSONSerialization.data(withJSONObject: windows)\nprint(String(data: data, encoding: .utf8)!)\n');
    const windows = JSON.parse(command("/usr/bin/swift", [swift, String(pid)], 60000));
    assert.ok(windows.some(window => window.Width >= 600 && window.Height >= 400), "No visible normal App window");
    const { resolveCanonicalServicePaths } = require("../app/agent-service/paths");
    const { readClientToken, requestService } = require("../app/agent-service/client");
    const { PROTOCOL_VERSION } = require("../app/agent-service/server");
    const paths = resolveCanonicalServicePaths();
    const status = await requestService(paths, { token: readClientToken(paths), version: PROTOCOL_VERSION, method: "service.status", params: {} }, { timeoutMs: 10000 });
    assert.equal(status.healthy, true);
    assert.equal(status.serviceVersion, marker.version);
    screenshot();
    assert.equal(fs.existsSync(path.join(output, "first-launch.png")), true);
    evidence.windowBounds = windows;
    evidence.guiPid = pid;
    evidence.rendererPresent = true;
    evidence.productServiceHealthy = true;
    evidence.quarantineAfter = command("/usr/bin/xattr", ["-p", "com.apple.quarantine", app]).trim();
    evidence.processesBeforeQuit = mainProcessRecords(binary);
    evidence.backgroundEmbeddingWorkersBeforeQuit = embeddingProcessRecords(binary);
    await quitAndWait(binary, pid, evidence);
    evidence.processesAfterQuit = mainProcessRecords(binary);
    evidence.backgroundEmbeddingWorkersAfterQuit = embeddingProcessRecords(binary);
    evidence.verified = true;
  } catch (error) {
    try { evidence.processesAtFailure = mainProcessRecords(binary); } catch { evidence.processSnapshotFailed = true; }
    screenshot();
    evidence.failure = String(error.message).slice(0,1000);
    throw error;
  } finally {
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    if (launched && guiPid) {
      try {
        if (mainProcesses(binary).includes(guiPid)) command("/usr/bin/osascript", ["-e", quitScript(guiPid)]);
      } catch { /* failure remains visible */ }
    }
  }
  console.log(JSON.stringify(evidence));
}

module.exports = { launchAndWait, ORDINARY_OPEN_SCRIPT, quitScript, quitAndWait, guiProcessRecords };
if (require.main === module) main().catch(error => { console.error("QUARANTINED_FIRST_LAUNCH_FAILED: " + String(error.message).slice(0,1000)); process.exitCode = 1; });
