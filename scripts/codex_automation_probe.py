#!/usr/bin/env python3
"""Feasibility probe only. No scheduler and no private Codex IPC/DB writes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import subprocess
import tempfile
import time
import tomllib

MAX_BYTES = 512 * 1024
ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")


def owner_from_source(repo):
    script = """const {BUILTIN_CLI_AGENT_PROFILES}=require('./app/agent-service/builtin-cli-profiles');
const {DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME}=require('./app/agent-service/runtime-account');
const p=BUILTIN_CLI_AGENT_PROFILES.find(p=>p.runtime==='codex');
console.log(JSON.stringify({profileId:p.id,agentId:p.agentId,
runtimeAccountId:DEFAULT_NATIVE_RUNTIME_ACCOUNT_ID_BY_RUNTIME.codex}));"""
    result = subprocess.run(["node", "-e", script], cwd=repo, check=True,
                            capture_output=True, text=True)
    return json.loads(result.stdout)


def automation_file(home, automation_id):
    if not ID.fullmatch(automation_id) or automation_id in (".", ".."):
        raise ValueError("invalid automation id")
    root = Path(home).resolve(strict=True)
    directory = root / "automations"
    target = directory / automation_id / "automation.toml"
    for path in (directory, target.parent, target):
        if path.is_symlink():
            raise ValueError("symlink automation path rejected")
    if not target.resolve(strict=True).is_relative_to(root):
        raise ValueError("automation outside Codex home")
    return target


def read_automation(home, automation_id):
    path = automation_file(home, automation_id)
    metadata = path.stat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_BYTES:
        raise ValueError("invalid automation file")
    raw = path.read_bytes()
    if len(raw) > MAX_BYTES:
        raise ValueError("automation too large")
    doc = tomllib.loads(raw.decode("utf-8"))
    if doc.get("version", 1) != 1 or doc.get("id") != automation_id:
        raise ValueError("unsupported version or mismatched id")
    if doc.get("kind", "cron") not in ("cron", "heartbeat"):
        raise ValueError("unsupported automation kind")
    for field in ("name", "prompt", "rrule"):
        if not isinstance(doc.get(field), str) or not doc[field].strip():
            raise ValueError("invalid automation field: " + field)
    if doc.get("status") not in ("ACTIVE", "PAUSED"):
        raise ValueError("unsupported automation status")
    return path, raw, doc, hashlib.sha256(raw).hexdigest()


def discover(home, owner):
    root = Path(home).resolve(strict=True)
    directory = root / "automations"
    if directory.is_symlink():
        raise ValueError("symlink automation directory rejected")
    rows, unavailable = [], []
    if not directory.exists():
        return {"items": [], "unavailable": []}
    home_key = hashlib.sha256(str(root).encode()).hexdigest()[:20]
    for child in sorted(directory.iterdir()):
        if child.name.startswith("."):
            continue
        try:
            _, _, doc, revision = read_automation(root, child.name)
            rows.append({"id": f"codex-automation:{home_key}:{doc['id']}",
                         "externalId": doc["id"], "name": doc["name"],
                         "kind": doc.get("kind", "cron"), "status": doc["status"],
                         "ownerProfileId": owner["profileId"],
                         "runtimeAccountId": owner["runtimeAccountId"],
                         "revision": revision})
        except (OSError, ValueError, tomllib.TOMLDecodeError) as error:
            unavailable.append({"id": child.name, "reason": str(error)})
    return {"items": rows, "unavailable": unavailable}


def for_profile(rows, profile, owner):
    if profile.get("id") != owner["profileId"]:
        return []
    bindings = profile.get("bindings", [])
    if not any(b.get("runtime") == "codex" and
               b.get("runtimeAccountId") == owner["runtimeAccountId"]
               for b in bindings):
        return []
    return rows


def assert_legacy_ownership(home, automation_id):
    database = Path(home).resolve(strict=True) / "sqlite/codex-dev.db"
    if not database.exists():
        return
    if database.is_symlink():
        raise ValueError("symlink client database rejected")
    try:
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
            row = db.execute("SELECT account_id, user_id, installation_id, status "
                             "FROM automations WHERE id = ?", (automation_id,)).fetchone()
    except sqlite3.Error as error:
        raise ValueError("unsupported client database; use native update") from error
    if row and (any(value is not None for value in row[:3]) or row[3] == "DELETED"):
        raise ValueError("account-owned or deleted task; use native update")


def native_run_metadata(home, automation_id, limit=30):
    read_automation(home, automation_id)
    assert_legacy_ownership(home, automation_id)
    database = Path(home).resolve(strict=True) / "sqlite/codex-dev.db"
    if not database.exists():
        return {"available": False, "reason": "client database unavailable", "items": []}
    limit = max(1, min(int(limit), 100))
    db = None
    try:
        db = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
        rows = db.execute("SELECT thread_id, status, created_at, updated_at, "
                          "length(coalesce(inbox_summary, '')) > 0, "
                          "length(coalesce(archived_assistant_message, '')) > 0 "
                          "FROM automation_runs WHERE automation_id = ? "
                          "ORDER BY created_at DESC, thread_id DESC LIMIT ?",
                          (automation_id, limit + 1)).fetchall()
    except sqlite3.Error:
        return {"available": False, "reason": "unsupported client run schema", "items": []}
    finally:
        if db is not None:
            db.close()
    return {"available": True, "hasMore": len(rows) > limit, "items": [
        {"threadId": row[0], "presentationStatus": row[1],
         "completionStatus": "unknown", "createdAt": row[2], "updatedAt": row[3],
         "hasSummary": bool(row[4]), "hasArchivedResult": bool(row[5])}
        for row in rows[:limit]]}


def rename_legacy(home, automation_id, expected_revision, name):
    """Narrow one-off probe for the observed client-generated TOML dialect.

    It is not a production concurrent-writer contract. It leaves the scheduler
    database to Codex and preserves every other parsed field and the file mode.
    """
    if not isinstance(name, str) or not name.strip() or len(name) > 200:
        raise ValueError("invalid name")
    assert_legacy_ownership(home, automation_id)
    path, raw, before, revision = read_automation(home, automation_id)
    if revision != expected_revision:
        raise ValueError("automation changed; read a new revision")
    lines = raw.decode().splitlines(keepends=True)
    if len(lines) < 5 or any(not lines[i].startswith(field + " = ")
                             for i, field in enumerate(("version", "id", "kind", "name"))):
        raise ValueError("unsupported file layout; use native update")
    if not lines[-1].startswith("updated_at = "):
        raise ValueError("unsupported timestamp layout")
    if tomllib.loads("".join(lines[:4]))["name"] != before["name"]:
        raise ValueError("name is not in the expected header")
    lines[3] = "name = " + json.dumps(name, ensure_ascii=False) + "\n"
    lines[-1] = "updated_at = " + str(max(int(time.time() * 1000), before["updated_at"] + 1)) + "\n"
    after_raw = "".join(lines).encode()
    after = tomllib.loads(after_raw.decode())
    if {k: v for k, v in before.items() if k not in ("name", "updated_at")} != {
            k: v for k, v in after.items() if k not in ("name", "updated_at")}:
        raise ValueError("unexpected field change")
    mode = stat.S_IMODE(path.stat().st_mode)
    fd, tmp_name = tempfile.mkstemp(prefix=".shoggoth-rename-", dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as stream:
            stream.write(after_raw)
            stream.flush()
            os.fsync(stream.fileno())
        if read_automation(home, automation_id)[3] != expected_revision:
            raise ValueError("automation changed before replace")
        assert_legacy_ownership(home, automation_id)
        os.replace(tmp_name, path)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
    _, _, verified, result_revision = read_automation(home, automation_id)
    if verified != after:
        raise ValueError("rename requires verification")
    return {"id": automation_id, "name": verified["name"],
            "changedFields": sorted(k for k in before if before[k] != verified[k]),
            "revision": result_revision}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", required=True)
    parser.add_argument("--repo", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--rename-id")
    parser.add_argument("--expected-revision")
    parser.add_argument("--name")
    parser.add_argument("--include-run-metadata", action="store_true")
    args = parser.parse_args()
    if args.rename_id:
        if not args.expected_revision or not args.name:
            parser.error("rename requires --expected-revision and --name")
        result = rename_legacy(args.home, args.rename_id, args.expected_revision, args.name)
    else:
        owner = owner_from_source(args.repo)
        result = {"proposedOwnerFromSource": owner, **discover(args.home, owner)}
        if args.include_run_metadata:
            for item in result["items"]:
                item["nativeRuns"] = native_run_metadata(args.home, item["externalId"])
    print(json.dumps(result, ensure_ascii=False, indent=2))
