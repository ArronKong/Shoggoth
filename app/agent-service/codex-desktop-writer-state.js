"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { UUID } = require("./codex-desktop-session-store");
const runFile = promisify(execFile);
const PID = /^[1-9][0-9]{0,9}$/u;
const DESKTOP_BINARY = /\/(?:Codex|ChatGPT)\.app\/Contents\/Resources\/(?:codex|codex-cli\/CodexCLI\.app\/Contents\/MacOS\/codex)$/u;

function writerState(state, owner, checkedAt) { return { state, owner, checkedAt }; }
function validateWriterState(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== 3 || !["state", "owner", "checkedAt"].every(key => Object.hasOwn(value, key))
    || !["available", "busy", "unknown"].includes(value.state)
    || !Number.isSafeInteger(value.checkedAt) || value.checkedAt < 0
    || (value.state === "busy" ? !["codex-desktop", "codex-client"].includes(value.owner)
      : value.state === "available" ? ![null, "shoggoth"].includes(value.owner) : value.owner !== null)) throw new Error("Invalid Codex writer state");
  return { ...value };
}
function parseProcesses(output) {
  const result = new Map();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match || !PID.test(match[1]) || result.has(Number(match[1]))) throw new Error("Invalid process snapshot");
    result.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), uid: Number(match[3]), executable: match[4] });
  }
  return result;
}
function parseOpenFiles(output) {
  const files = []; let process = null, file = null;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const key = line[0], value = line.slice(1);
    if (key === "p") {
      if (!PID.test(value)) throw new Error("Invalid writer PID");
      process = { pid: Number(value) }; file = null;
    } else if (["c", "u"].includes(key)) {
      if (!process || file) throw new Error("Invalid writer process");
      process[key === "c" ? "command" : "uid"] = key === "u" ? Number(value) : value;
    } else if (key === "f") {
      if (!process || !/^\d+$/u.test(value)) throw new Error("Invalid writer descriptor");
      file = { process: { ...process } }; files.push(file);
    } else if (["a", "t", "n"].includes(key)) {
      if (!file || Object.hasOwn(file, key)) throw new Error("Invalid writer file");
      file[key] = value;
    } else throw new Error("Unexpected writer field");
  }
  if (files.some(file => !file.n || file.t !== "REG" || !["r", "w", "u"].includes(file.a))) throw new Error("Incomplete writer snapshot");
  return files;
}
function isServiceChild(processes, pid, servicePid) {
  const seen = new Set();
  for (let depth = 0; depth < 32 && pid > 0 && !seen.has(pid); depth++) {
    if (pid === servicePid) return true;
    seen.add(pid); pid = processes.get(pid)?.parent || 0;
  }
  return false;
}

// macOS lsof does not expose flock ownership in its lock column. Codex keeps
// its writable per-thread lock descriptor open for the lifetime of the writer.
// Observe that descriptor and its actual process; never resume a thread to test
// availability, create/delete lock files, or return process/path details to UI.
class CodexDesktopWriterObserver {
  constructor({ run = runFile, now = Date.now, platform = process.platform, servicePid = process.pid, uid = process.getuid?.(), cacheMs = 2000 } = {}) {
    Object.assign(this, { run, now, platform, servicePid, uid, cacheMs });
    this.cache = new Map();
  }
  async observe(home, ids) {
    const checkedAt = this.now(), unknown = () => new Map(ids.map(id => [id, writerState("unknown", null, checkedAt)]));
    if (!ids.length) return new Map();
    if (this.platform !== "darwin" || ids.length > 100 || !ids.every(id => UUID.test(id))) return unknown();
    const cached = this.cache.get(home);
    if (cached && checkedAt - cached.at < this.cacheMs && ids.every(id => cached.states.has(id))) return new Map(ids.map(id => [id, cached.states.get(id)]));
    const states = unknown(), locks = new Map();
    try {
      if (!path.isAbsolute(home) || fs.realpathSync(home) !== home) return states;
      const directory = path.join(home, "thread-writer-locks");
      let dir;
      try { dir = fs.lstatSync(directory); } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return new Map(ids.map(id => [id, writerState("available", null, checkedAt)]));
      }
      if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== this.uid || fs.realpathSync(directory) !== directory) return states;
      for (const id of ids) {
        const file = path.join(directory, id + ".lock");
        try {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== this.uid || stat.size !== 0) continue;
          locks.set(file, { id, stat });
        } catch (error) { if (error.code === "ENOENT") states.set(id, writerState("available", null, checkedAt)); else throw error; }
      }
      if (locks.size) {
        let opened;
        try { opened = await this.run("/usr/sbin/lsof", ["-nP", "-Fpcuftan", "--", ...locks.keys()], { encoding: "utf8", timeout: 1500, maxBuffer: 128 * 1024, windowsHide: true }); }
        catch (error) { if (error.code === 1 && error.stdout === "" && error.stderr === "") opened = { stdout: "" }; else throw error; }
        const files = parseOpenFiles(opened.stdout);
        const writable = files.filter(file => file.a !== "r");
        const processes = writable.length ? parseProcesses((await this.run("/bin/ps", ["-axo", "pid=,ppid=,uid=,comm="], { encoding: "utf8", timeout: 1500, maxBuffer: 512 * 1024, windowsHide: true })).stdout) : new Map();
        for (const [file, lock] of locks) {
          const current = fs.lstatSync(file);
          if (current.isSymbolicLink() || current.dev !== lock.stat.dev || current.ino !== lock.stat.ino) continue;
          const holders = writable.filter(entry => entry.n === file);
          if (!holders.length) { states.set(lock.id, writerState("available", null, checkedAt)); continue; }
          if (holders.length !== 1) continue;
          const holder = holders[0], process = processes.get(holder.process.pid);
          if (!process || process.uid !== this.uid || holder.process.uid !== this.uid
            || holder.process.command !== "codex" || path.basename(process.executable) !== "codex") continue;
          const owner = isServiceChild(processes, process.pid, this.servicePid) ? "shoggoth"
            : DESKTOP_BINARY.test(process.executable) ? "codex-desktop" : "codex-client";
          states.set(lock.id, writerState(owner === "shoggoth" ? "available" : "busy", owner, checkedAt));
        }
      }
    } catch { /* Unknown is visible; a failed probe must not look available. */ }
    this.cache.set(home, { at: checkedAt, states });
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
    return states;
  }
}

module.exports = { CodexDesktopWriterObserver, validateWriterState, parseProcesses, parseOpenFiles };
