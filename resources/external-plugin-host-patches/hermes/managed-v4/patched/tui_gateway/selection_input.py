"""Immutable operation-scoped attachments for selected normal Gateway turns.

Canonical digests are SHA-256 of UTF-8 compact JSON arrays (ensure_ascii=False),
identical to JS JSON.stringify. File bytes and paths never enter a receipt.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from .selection_dispatch import SelectionDispatchError, _db

MAX_BYTES = 25 * 1024 * 1024
MAX_ITEMS = 16
MAX_RETAINED_BYTES = 256 * 1024 * 1024
MAX_OPERATIONS = 64
TTL_SECONDS = 15 * 60
CAPABILITY = {"version": 1, "max_bytes": MAX_BYTES, "max_items": MAX_ITEMS, "kinds": ["image", "pdf", "file"]}
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_HEX = re.compile(r"^[a-f0-9]{64}$")
_META = {"kind", "name", "mime_type", "size", "sha256"}
_STAGE_SLOTS = threading.BoundedSemaphore(1)


def fail(code="SELECTION_INPUT_INVALID"):
    raise SelectionDispatchError(code, "Selected operation input cannot be verified; do not upload or submit again")


def sha(value):
    return hashlib.sha256(value).hexdigest()


def digest(value):
    return sha(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def identity(owner, operation):
    if not isinstance(owner, str) or not 0 < len(owner) <= 256 or not isinstance(operation, str) or not _ID.fullmatch(operation):
        fail()


def metadata(attachments):
    if not isinstance(attachments, list) or not 1 <= len(attachments) <= MAX_ITEMS:
        fail()
    total = 0
    for row in attachments:
        if (not isinstance(row, dict) or set(row) != _META
                or row["kind"] not in CAPABILITY["kinds"] or not isinstance(row["name"], str)
                or not 0 < len(row["name"].encode("utf-8")) <= 255 or row["name"] in {".", ".."}
                or re.search(r"[\\/\x00-\x1f\x7f]", row["name"])
                or not isinstance(row["mime_type"], str) or not re.fullmatch(r"[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+", row["mime_type"])
                or len(row["mime_type"]) > 128 or type(row["size"]) is not int or not 0 <= row["size"] <= MAX_BYTES
                or not isinstance(row["sha256"], str) or not _HEX.fullmatch(row["sha256"])
                or row["kind"] == "image" and row["mime_type"] not in {"image/png", "image/jpeg", "image/gif", "image/webp"}
                or row["kind"] == "pdf" and row["mime_type"] != "application/pdf"):
            fail()
        total += row["size"]
    if total > MAX_BYTES:
        fail("SELECTION_INPUT_TOO_LARGE")
    return digest([[r[k] for k in ("kind", "name", "mime_type", "size", "sha256")] for r in attachments])


def text_digest(text):
    if not isinstance(text, str) or "\0" in text or len(text.encode("utf-8")) > 1024 * 1024:
        fail()
    return sha(text.encode("utf-8"))


def table(db):
    db.execute("""CREATE TABLE IF NOT EXISTS selection_inputs(
      owner_session_id TEXT NOT NULL, operation_id TEXT NOT NULL, workspace TEXT NOT NULL,
      input_digest TEXT NOT NULL, message_digest TEXT NOT NULL, attachment_digest TEXT NOT NULL,
      attachments TEXT NOT NULL, files TEXT NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY(owner_session_id, operation_id))""")


def receipt(row):
    return {"version": 1, "owner_session_id": row["owner_session_id"], "operation_id": row["operation_id"], "input_digest": row["input_digest"],
            "message_digest": row["message_digest"], "attachment_digest": row["attachment_digest"],
            "attachments": json.loads(row["attachments"]), "expires_at": row["expires_at"]}


def get(home, owner, operation):
    identity(owner, operation)
    with _db(home) as db:
        table(db)
        row = db.execute("SELECT * FROM selection_inputs WHERE owner_session_id=? AND operation_id=?", (owner, operation)).fetchone()
        return receipt(row) if row else None


def private_root(workspace, owner, *, create=True):
    base = Path(workspace).resolve(strict=True)
    if not base.is_dir():
        fail("SELECTION_INPUT_STORAGE_UNAVAILABLE")
    root = base
    for name in (".shoggoth-selection-inputs", sha(owner.encode())):
        root = root / name
        if create:
            try:
                root.mkdir(mode=0o700)
            except FileExistsError:
                pass
        found = root.lstat()
        if not stat.S_ISDIR(found.st_mode) or found.st_uid != os.getuid() or stat.S_IMODE(found.st_mode) != 0o700:
            fail("SELECTION_INPUT_STORAGE_UNAVAILABLE")
    return root


def verified_files(row, workspace=None):
    base = Path(row["workspace"]).resolve(strict=True)
    if workspace is not None and base != Path(workspace).resolve(strict=True):
        fail("SELECTION_INPUT_OWNER_CHANGED")
    root = private_root(str(base), row["owner_session_id"], create=False) / sha(row["operation_id"].encode())
    if root.is_symlink() or not root.is_dir():
        fail("SELECTION_INPUT_STORAGE_UNAVAILABLE")
    files = json.loads(row["files"])
    for item in files:
        target = root / item["name"]
        if (target.is_symlink() or target.parent != root or not target.is_file()
                or target.stat().st_size != item["size"] or sha(target.read_bytes()) != item["sha256"]):
            fail("SELECTION_INPUT_CHANGED")
    return root, files


def cleanup_expired_files(home):
    """Reclaim only expired, never-dispatched or durably terminal own files.

    Digest receipts remain for immutable retries. Active/unknown dispatches and
    corrupt/unrecognised directories retain their capacity and fail closed.
    """
    now = int(time.time())
    with _db(home) as db:
        table(db)
        rows = db.execute("""SELECT i.* FROM selection_inputs i LEFT JOIN selection_dispatches d
          ON d.owner_session_id=i.owner_session_id AND d.operation_id=i.operation_id
          WHERE i.bytes>0 AND i.expires_at<=? AND
          (d.operation_id IS NULL OR d.state IN ('complete','stopped','failed','canceled','cancelled'))
          ORDER BY i.expires_at LIMIT 8""", (now,)).fetchall()
    for row in rows:
        try:
            root, files = verified_files(row)
            if {item.name for item in root.iterdir()} != {item["name"] for item in files}:
                continue
            with _db(home) as db:
                db.execute("BEGIN IMMEDIATE")
                current = db.execute("SELECT i.bytes,d.state FROM selection_inputs i LEFT JOIN selection_dispatches d ON d.owner_session_id=i.owner_session_id AND d.operation_id=i.operation_id WHERE i.owner_session_id=? AND i.operation_id=? AND i.input_digest=?", (row["owner_session_id"],row["operation_id"],row["input_digest"])).fetchone()
                if current is None or current["bytes"] == 0 or current["state"] not in {None,'complete','stopped','failed','canceled','cancelled'}:
                    continue
                # Exact files were created here and verified before deletion.
                shutil.rmtree(root)
                db.execute("UPDATE selection_inputs SET bytes=0 WHERE owner_session_id=? AND operation_id=? AND input_digest=?", (row["owner_session_id"],row["operation_id"],row["input_digest"]))
        except (SelectionDispatchError,OSError):
            continue


def stage(home, owner, operation, workspace, text, attachments):
    if not _STAGE_SLOTS.acquire(blocking=False):
        fail("SELECTION_INPUT_BUSY")
    try:
        return _stage(home, owner, operation, workspace, text, attachments)
    finally:
        _STAGE_SLOTS.release()


def _stage(home, owner, operation, workspace, text, attachments):
    identity(owner, operation)
    if not isinstance(attachments, list):
        fail()
    rows, payloads = [], []
    for item in attachments:
        if not isinstance(item, dict) or set(item) != _META | {"data_base64"} or not isinstance(item["data_base64"], str) or len(item["data_base64"]) > (MAX_BYTES * 4 // 3 + 8):
            fail()
        row = {key: item[key] for key in _META}
        try:
            payload = base64.b64decode(item["data_base64"], validate=True)
        except Exception:
            fail()
        if len(payload) != row.get("size") or sha(payload) != row.get("sha256"):
            fail("SELECTION_INPUT_CHANGED")
        rows.append(row); payloads.append(payload)
    attachment_hash, message_hash = metadata(rows), text_digest(text)
    input_hash = digest([1, message_hash, attachment_hash])
    cleanup_expired_files(home)
    with _db(home) as db:
        table(db)
        dispatch = db.execute("SELECT state FROM selection_dispatches WHERE owner_session_id=? AND operation_id=?", (owner, operation)).fetchone()
        if dispatch:
            fail("SELECTION_INPUT_ALREADY_DISPATCHED")
        existing = db.execute("SELECT * FROM selection_inputs WHERE owner_session_id=? AND operation_id=?", (owner, operation)).fetchone()
        if existing:
            if existing["input_digest"] != input_hash:
                fail("SELECTION_INPUT_CONFLICT")
            if existing["expires_at"] <= int(time.time()):
                fail("SELECTION_INPUT_EXPIRED")
            verified_files(existing, workspace)
            return receipt(existing)
        capacity = db.execute("SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM selection_inputs WHERE bytes>0").fetchone()
        if capacity[0] >= MAX_OPERATIONS or capacity[1] + sum(map(len, payloads)) > MAX_RETAINED_BYTES:
            fail("SELECTION_INPUT_CAPACITY")
    root = private_root(workspace, owner)
    target = root / sha(operation.encode())
    if target.exists() or target.is_symlink():
        fail("SELECTION_INPUT_STORAGE_UNAVAILABLE")
    temporary = Path(tempfile.mkdtemp(prefix=".pending-", dir=root))
    files = []
    published = False
    try:
        render_deadline, total_pages, retained_bytes = time.monotonic() + 30, 0, 0
        for index, (row, payload) in enumerate(zip(rows, payloads)):
            name = f"{index:02d}-" + row["name"]
            file = temporary / name
            with file.open("xb") as output:
                os.chmod(file, 0o400); output.write(payload); output.flush(); os.fsync(output.fileno())
            files.append({"name": name, "kind": row["kind"], "size": len(payload), "sha256": sha(payload)})
            retained_bytes += len(payload)
            if retained_bytes > 64 * 1024 * 1024:
                fail("SELECTION_INPUT_TOO_LARGE")
            if row["kind"] == "pdf":
                if not payload.startswith(b"%PDF-") or shutil.which("pdftoppm") is None or shutil.which("pdfinfo") is None:
                    fail("SELECTION_INPUT_PDF_UNAVAILABLE")
                try:
                    remaining = render_deadline - time.monotonic()
                    if remaining <= 0:
                        fail("SELECTION_INPUT_PDF_UNAVAILABLE")
                    info = subprocess.run(["pdfinfo", str(file)], timeout=min(5, remaining), check=True, capture_output=True, text=True)
                    count = re.search(r"^Pages:\s+(\d+)\s*$", info.stdout, re.MULTILINE)
                    if count is None or not 1 <= int(count[1]) <= 40 or total_pages + int(count[1]) > 40:
                        fail("SELECTION_INPUT_PDF_UNAVAILABLE")
                    total_pages += int(count[1])
                    for page_number in range(1, int(count[1]) + 1):
                        remaining = render_deadline - time.monotonic()
                        if remaining <= 0:
                            fail("SELECTION_INPUT_PDF_UNAVAILABLE")
                        prefix = temporary / f"{index:02d}-page-{page_number:03d}"
                        # One bounded page at a time; no unbounded whole-document
                        # output can fill disk before the publication limit check.
                        subprocess.run(["pdftoppm", "-png", "-r", "96", "-scale-to", "1600", "-singlefile", "-f", str(page_number), "-l", str(page_number), str(file), str(prefix)],
                                       timeout=remaining, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        page = prefix.with_suffix(".png")
                        if not page.is_file() or page.stat().st_size > 12 * 1024 * 1024:
                            fail("SELECTION_INPUT_TOO_LARGE")
                        body = page.read_bytes(); os.chmod(page, 0o400)
                        retained_bytes += len(body)
                        if retained_bytes > 64 * 1024 * 1024:
                            fail("SELECTION_INPUT_TOO_LARGE")
                        files.append({"name": page.name, "kind": "image", "size": len(body), "sha256": sha(body)})
                except SelectionDispatchError:
                    raise
                except Exception:
                    fail("SELECTION_INPUT_PDF_UNAVAILABLE")
        total_bytes = sum(item["size"] for item in files)
        if total_bytes > 64 * 1024 * 1024:
            fail("SELECTION_INPUT_TOO_LARGE")
        expires = int(time.time()) + TTL_SECONDS
        with _db(home) as db:
            table(db); db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM selection_dispatches WHERE owner_session_id=? AND operation_id=?", (owner, operation)).fetchone():
                fail("SELECTION_INPUT_ALREADY_DISPATCHED")
            existing = db.execute("SELECT * FROM selection_inputs WHERE owner_session_id=? AND operation_id=?", (owner, operation)).fetchone()
            if existing:
                if existing["input_digest"] != input_hash:
                    fail("SELECTION_INPUT_CONFLICT")
                if existing["expires_at"] <= int(time.time()):
                    fail("SELECTION_INPUT_EXPIRED")
                verified_files(existing, workspace); return receipt(existing)
            capacity = db.execute("SELECT COUNT(*), COALESCE(SUM(bytes),0) FROM selection_inputs WHERE bytes>0").fetchone()
            if capacity[0] >= MAX_OPERATIONS or capacity[1] + total_bytes > MAX_RETAINED_BYTES:
                fail("SELECTION_INPUT_CAPACITY")
            if target.exists() or target.is_symlink():
                fail("SELECTION_INPUT_STORAGE_UNAVAILABLE")
            os.rename(temporary, target); published = True
            db.execute("INSERT INTO selection_inputs VALUES(?,?,?,?,?,?,?,?,?,?)", (owner, operation, str(Path(workspace).resolve(strict=True)),
                input_hash, message_hash, attachment_hash, json.dumps(rows, ensure_ascii=False), json.dumps(files), expires, total_bytes))
            row = db.execute("SELECT * FROM selection_inputs WHERE owner_session_id=? AND operation_id=?", (owner, operation)).fetchone()
            return receipt(row)
    finally:
        if not published:
            shutil.rmtree(temporary, ignore_errors=True)


def for_submit(home, owner, operation, workspace, text, input_hash):
    identity(owner, operation)
    with _db(home) as db:
        table(db)
        row = db.execute("SELECT * FROM selection_inputs WHERE owner_session_id=? AND operation_id=?", (owner, operation)).fetchone()
        if row is None:
            if input_hash is not None:
                fail("SELECTION_INPUT_NOT_FOUND")
            return text, []
        if not isinstance(input_hash, str) or row["input_digest"] != input_hash or row["message_digest"] != text_digest(text):
            fail("SELECTION_INPUT_CONFLICT")
        if row["expires_at"] <= int(time.time()) and not db.execute("SELECT 1 FROM selection_dispatches WHERE owner_session_id=? AND operation_id=?", (owner, operation)).fetchone():
            fail("SELECTION_INPUT_EXPIRED")
        root, files = verified_files(row, workspace)
        images = [str(root / item["name"]) for item in files if item["kind"] == "image"]
        rendered = text + "".join("\n\n@file:" + json.dumps(str(root / item["name"]), ensure_ascii=False)
                                  for item in files if item["kind"] == "file")
        return rendered, images


def verify_before_model(home, owner, operation):
    with _db(home) as db:
        table(db)
        row = db.execute("SELECT * FROM selection_inputs WHERE owner_session_id=? AND operation_id=?", (owner, operation)).fetchone()
        if row is not None:
            verified_files(row)
