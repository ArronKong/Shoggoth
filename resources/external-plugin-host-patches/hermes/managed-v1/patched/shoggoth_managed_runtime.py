"""Private App-owned foreground serve lifecycle. No installed-host takeover.

Disabled unless the trusted parent provides a private managed-control descriptor.
The opaque work permits are Python objects: neither JSON nor a model can mint one.
"""
from __future__ import annotations

import atexit
import contextlib
import contextvars
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
import threading
import time

_STATE = None
_CURRENT_PERMIT = contextvars.ContextVar("shoggoth_managed_work_permit", default=None)
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_OP = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z")
_CONTROL_FIELDS = {"version", "backend_id", "runtime_root", "runtime_tree_sha256", "data_root", "nonce", "control_token", "required_adapter_id", "adapter_tree_sha256"}


class ManagedRuntimeError(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _require(value, code):
    if not value:
        raise ManagedRuntimeError(code)


def _inside(root, value):
    return value == root or root in value.parents


def _private_dir(root):
    s = root.lstat()
    _require(stat.S_ISDIR(s.st_mode) and not root.is_symlink() and s.st_uid == os.getuid() and not s.st_mode & 0o077
        and root.resolve(strict=True) == root, "MANAGED_DATA_ROOT_UNSAFE")


def _private_json(file):
    s = file.lstat()
    _require(stat.S_ISREG(s.st_mode) and not file.is_symlink() and s.st_nlink == 1 and s.st_uid == os.getuid()
        and not s.st_mode & 0o077 and s.st_size <= 65536, "MANAGED_CONTROL_UNSAFE")
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        a = os.fstat(fd)
        _require((s.st_dev, s.st_ino) == (a.st_dev, a.st_ino), "MANAGED_CONTROL_CHANGED")
        b = os.read(fd, 65537)
        z = os.fstat(fd)
        _require((a.st_size, a.st_mtime_ns, a.st_ctime_ns) == (z.st_size, z.st_mtime_ns, z.st_ctime_ns), "MANAGED_CONTROL_CHANGED")
        return json.loads(b)
    finally:
        os.close(fd)


def _tree_digest(root):
    rows = []
    def walk(directory, prefix):
        before = directory.lstat()
        s = before
        _require(stat.S_ISDIR(s.st_mode) and not directory.is_symlink() and s.st_uid == os.getuid() and not s.st_mode & 0o277, "MANAGED_RUNTIME_MUTABLE")
        for name in sorted(os.listdir(directory)):
            if not prefix and name == ".git":
                continue
            rel = f"{prefix}/{name}" if prefix else name
            p = directory / name
            s = p.lstat()
            if stat.S_ISLNK(s.st_mode):
                target = p.resolve(strict=True)
                _require(_inside(root, target), "MANAGED_RUNTIME_LINK_ESCAPE")
                rows.append({"path": rel, "kind": "link", "target": str(target.relative_to(root))})
            elif stat.S_ISDIR(s.st_mode):
                rows.append({"path": rel, "kind": "directory"})
                walk(p, rel)
            else:
                _require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == os.getuid()
                    and not s.st_mode & 0o277, "MANAGED_RUNTIME_MUTABLE")
                identity = lambda st: (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns, st.st_mode, st.st_uid, st.st_nlink)
                fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, "rb") as f:
                    _require(identity(s) == identity(os.fstat(f.fileno())), "MANAGED_RUNTIME_CHANGED")
                    digest = hashlib.file_digest(f, "sha256").hexdigest()
                    _require(identity(s) == identity(os.fstat(f.fileno())) == identity(p.lstat()), "MANAGED_RUNTIME_CHANGED")
                rows.append({"path": rel, "kind": "file", "executable": bool(s.st_mode & 0o111), "size": s.st_size, "sha256": digest})
        z = directory.lstat()
        _require((before.st_dev, before.st_ino, before.st_mtime_ns, before.st_ctime_ns) == (z.st_dev, z.st_ino, z.st_mtime_ns, z.st_ctime_ns), "MANAGED_RUNTIME_CHANGED")
    walk(root, "")
    rows.sort(key=lambda row: row["path"])
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


class _Permit:
    def __init__(self, state):
        self.state = state
        self.generation = state.generation


class _ManagedState:
    def __init__(self, descriptor):
        self.descriptor = descriptor
        self.lock = threading.RLock()
        self.paused = True
        self.generation = secrets.token_hex(32)
        self.active = {}
        self.fence_fd = None
        self.runtime = Path(descriptor["runtime_root"])
        self.home = Path(descriptor["data_root"])
        self.adapter_root = self.home / "plugins" / descriptor["required_adapter_id"]
        self.start_identity = subprocess.check_output(["/bin/ps", "-p", str(os.getpid()), "-o", "lstart="], text=True, timeout=2).strip()
        _require(bool(self.start_identity), "MANAGED_PROCESS_IDENTITY_UNAVAILABLE")

    def valid_permit(self):
        p = _CURRENT_PERMIT.get()
        return isinstance(p, _Permit) and p.state is self and p.generation == self.generation

    def validate_fence(self):
        _require(self.fence_fd is not None, "MANAGED_WRITER_FENCE_UNAVAILABLE")
        p = self.home / "shoggoth-managed-writer.fence"
        a, b = os.fstat(self.fence_fd), p.lstat()
        _require(stat.S_ISREG(b.st_mode) and not p.is_symlink() and b.st_nlink == 1
            and (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino), "MANAGED_WRITER_FENCE_CHANGED")
        row = _private_json(p)
        _require(row.get("nonce") == self.descriptor["nonce"] and row.get("data_root") == str(self.home), "MANAGED_WRITER_FENCE_CHANGED")

    def allowed(self):
        self.validate_fence()
        with self.lock:
            return not self.paused or self.valid_permit()

    def snapshot(self):
        from hermes_cli.backend_retirement import retirement
        from hermes_cli.web_server_idle_proof import idle_proof
        from tui_gateway import server
        work = retirement.active_count()
        with server._sessions_lock:
            sessions = list(server._sessions.values())
        running = queued = building = unknown = 0
        for s in sessions:
            with s["history_lock"]:
                running += bool(s.get("running"))
                q = ([s.get("queued_prompt")] if s.get("queued_prompt") else []) + list(s.get("queued_prompts") or [])
                queued += len(q)
                unknown += sum(not isinstance(e, dict) or not isinstance(e.get("shoggoth_managed_permit"), _Permit)
                    or e["shoggoth_managed_permit"].state is not self
                    or e["shoggoth_managed_permit"].generation != self.generation for e in q)
                t = s.get("_agent_build_thread")
                building += bool(t and t.is_alive())
        probe = idle_proof()
        with self.lock:
            models = len(self.active)
            identities = [{"runtime_session_id": str(getattr(row["agent"], "session_id", "")), "ui_session_id": row["sid"],
                "task_id": row["task_id"], "turn_id": row["turn_id"]} for row in self.active.values()]
        complete = probe.get("idle") is not None
        idle = complete and probe.get("idle") is True and not (work or running or queued or building or models or unknown)
        return {"complete": complete, "idle": idle, "running": running, "queued": queued, "building": building,
            "active_work": work, "active_model_turns": models, "active_model_identities": identities, "unknown_queued": unknown,
            "reason": probe.get("reason")}

    def verify_imports(self):
        _require(_tree_digest(self.adapter_root) == self.descriptor["adapter_tree_sha256"], "MANAGED_ADAPTER_HASH_MISMATCH")
        for module in list(sys.modules.values()):
            value = getattr(module, "__file__", None)
            if not isinstance(value, str) or not value:
                continue
            p = Path(value).resolve(strict=True)
            _require(_inside(self.runtime, p) or _inside(self.adapter_root, p), "MANAGED_IMPORT_ESCAPE")

    def proof(self):
        self.validate_fence()
        self.verify_imports()
        from tui_gateway.selection_dispatch import capabilities
        caps = capabilities(str(self.home))
        rows = [r for r in caps["adapters"] if r["required_adapter_id"] == self.descriptor["required_adapter_id"]]
        adapter = rows[0] if len(rows) == 1 else None
        return {"version": 1, "protocol": "hermes-managed-v1", "backend_id": "hermes", "pid": os.getpid(),
            "start_identity": self.start_identity, "nonce": self.descriptor["nonce"], "generation": self.generation,
            "runtime_root": str(self.runtime), "runtime_tree_sha256": self.descriptor["runtime_tree_sha256"],
            "data_root": str(self.home), "adapter_tree_sha256": self.descriptor["adapter_tree_sha256"], "selection_supported": adapter is not None,
            "adapter_generation": adapter["adapter_generation"] if adapter else None, "paused": self.paused,
            "snapshot": self.snapshot()}


def bootstrap():
    global _STATE
    target = os.environ.get("SHOGGOTH_HERMES_MANAGED_CONTROL_FILE")
    if target is None:
        return
    if _STATE is not None:
        _require(Path(target).resolve(strict=True).parent == _STATE.home and _private_json(Path(target)) == _STATE.descriptor, "MANAGED_BOOTSTRAP_CHANGED")
        _STATE.validate_fence()
        return
    _require(os.name == "posix" and sys.platform == "darwin", "MANAGED_PLATFORM_UNSUPPORTED")
    p = Path(target)
    _require(p.is_absolute() and p.resolve(strict=True) == p, "MANAGED_CONTROL_UNSAFE")
    d = _private_json(p)
    _require(isinstance(d, dict) and set(d) == _CONTROL_FIELDS and d["version"] == 1 and not isinstance(d["version"], bool)
        and d["backend_id"] == "hermes" and _HASH.fullmatch(d["runtime_tree_sha256"]) and _HASH.fullmatch(d["nonce"])
        and _HASH.fullmatch(d["control_token"]) and _HASH.fullmatch(d["adapter_tree_sha256"]) and _OP.fullmatch(d["required_adapter_id"]), "MANAGED_CONTROL_INVALID")
    state = _ManagedState(d)
    _require(state.runtime == Path(__file__).resolve().parent and state.runtime.resolve(strict=True) == state.runtime,
        "MANAGED_RUNTIME_IDENTITY_MISMATCH")
    _private_dir(state.home)
    _require(os.environ.get("HERMES_HOME") == str(state.home) and p.parent == state.home, "MANAGED_HOME_MISMATCH")
    fence = state.home / "shoggoth-managed-writer.fence"
    fd = os.open(fence, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        s = os.fstat(fd)
        _require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_uid == os.getuid() and not s.st_mode & 0o077,
            "MANAGED_WRITER_FENCE_UNSAFE")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ManagedRuntimeError("MANAGED_WRITER_ALREADY_OWNED") from exc
        expected = {"version": 1, "data_root": str(state.home), "runtime_root": str(state.runtime), "nonce": d["nonce"]}
        old = os.read(fd, 65537)
        _require(not old or json.loads(old) == expected, "MANAGED_WRITER_OWNER_UNKNOWN")
        _require(_tree_digest(state.runtime) == d["runtime_tree_sha256"], "MANAGED_RUNTIME_HASH_MISMATCH")
        _require(_inside(state.runtime, Path(sys.executable).resolve(strict=True)) and _inside(state.runtime, Path(sys.prefix).resolve(strict=True))
            and _inside(state.runtime, Path(sys.base_prefix).resolve(strict=True)) and all(not x or _inside(state.runtime, Path(x).absolute()) for x in sys.path),
            "MANAGED_INTERPRETER_ESCAPE")
        os.lseek(fd, 0, os.SEEK_SET)
        os.ftruncate(fd, 0)
        os.write(fd, json.dumps(expected, separators=(",", ":")).encode())
        os.fsync(fd)
        state.fence_fd = fd
        _STATE = state
        atexit.register(lambda: os.close(fd))
    except BaseException:
        os.close(fd)
        raise


def enabled():
    return _STATE is not None


def admission_allowed():
    return _STATE is None or _STATE.allowed()


@contextlib.contextmanager
def rpc_scope(method):
    if _STATE is None:
        yield
        return
    with _STATE.lock:
        _require(not _STATE.paused or _STATE.valid_permit(), "MANAGED_ADMISSION_PAUSED")
        permit = _Permit(_STATE)
    token = _CURRENT_PERMIT.set(permit)
    try:
        yield
    finally:
        _CURRENT_PERMIT.reset(token)


def contextual(fn):
    if _STATE is None:
        return fn
    ctx = contextvars.copy_context()
    return lambda: ctx.run(fn)


def capture_permit():
    return _CURRENT_PERMIT.get() if _STATE is not None and _STATE.valid_permit() else None


@contextlib.contextmanager
def queue_scope(entry):
    if _STATE is None:
        yield
        return
    p = entry.get("shoggoth_managed_permit") if isinstance(entry, dict) else None
    _require(isinstance(p, _Permit) and p.state is _STATE and p.generation == _STATE.generation, "MANAGED_QUEUED_OWNER_UNAVAILABLE")
    token = _CURRENT_PERMIT.set(p)
    try:
        yield
    finally:
        _CURRENT_PERMIT.reset(token)


@contextlib.contextmanager
def turn_scope(sid, session):
    if _STATE is None:
        yield
        return
    with _STATE.lock:
        p = capture_permit() or session.pop("_shoggoth_managed_pending_permit", None)
        _require(isinstance(p, _Permit) and p.state is _STATE and p.generation == _STATE.generation, "MANAGED_TURN_OWNER_UNAVAILABLE")
        agent = session.get("agent")
        _require(agent is not None and id(agent) not in _STATE.active, "MANAGED_TURN_OWNER_UNAVAILABLE")
        row = {"agent": agent, "session": session, "sid": sid, "task_id": None, "turn_id": None}
        _STATE.active[id(agent)] = row
    token = _CURRENT_PERMIT.set(p)
    try:
        yield
    finally:
        _CURRENT_PERMIT.reset(token)
        with _STATE.lock:
            _require(_STATE.active.get(id(agent)) is row, "MANAGED_TURN_IDENTITY_CHANGED")
            del _STATE.active[id(agent)]


def assert_model_agent(agent):
    if _STATE is None:
        return
    _STATE.validate_fence()
    _STATE.verify_imports()
    with _STATE.lock:
        row = _STATE.active.get(id(agent))
        _require(row is not None and row["agent"] is agent, "MANAGED_MODEL_OWNER_UNAVAILABLE")


def authorize_model(agent, task_id, turn_id):
    if _STATE is None:
        return
    assert_model_agent(agent)
    _require(isinstance(task_id, str) and bool(task_id) and isinstance(turn_id, str) and bool(turn_id), "MANAGED_MODEL_IDENTITY_UNAVAILABLE")
    with _STATE.lock:
        row = _STATE.active[id(agent)]
        if row["task_id"] is None:
            row.update(task_id=task_id, turn_id=turn_id)
        _require((row["task_id"], row["turn_id"]) == (task_id, turn_id), "MANAGED_MODEL_IDENTITY_CHANGED")


def control_rpc(req):
    rid = req.get("id")
    resume_authorized = False
    try:
        _require(_STATE is not None, "MANAGED_CONTROL_UNAVAILABLE")
        method, p = req.get("method"), req.get("params")
        _require(method in {"runtime.managed.status", "runtime.managed.pause", "runtime.managed.resume"} and isinstance(p, dict)
            and set(p) == {"version", "control_token", "nonce", "operation_id", "deadline_at", "generation"}
            and p["version"] == 1 and not isinstance(p["version"], bool)
            and isinstance(p["control_token"], str) and hmac.compare_digest(p["control_token"], _STATE.descriptor["control_token"])
            and p["nonce"] == _STATE.descriptor["nonce"] and isinstance(p["operation_id"], str) and _OP.fullmatch(p["operation_id"])
            and isinstance(p["deadline_at"], int) and not isinstance(p["deadline_at"], bool) and p["deadline_at"] > int(time.time()*1000)
            and p["generation"] in {None, _STATE.generation}, "MANAGED_CONTROL_REJECTED")
        if method != "runtime.managed.status":
            _require(p["generation"] == _STATE.generation, "MANAGED_CONTROL_GENERATION_REQUIRED")
            from hermes_cli.backend_retirement import retirement
            if method == "runtime.managed.resume":
                resume_authorized = True
                # Admission stays closed throughout health/drain validation. Never open
                # then return an error because the trusted adapter or ledger was lost.
                before = _STATE.proof()
                _require(before["selection_supported"] and before["snapshot"]["complete"]
                    and before["snapshot"]["idle"], "MANAGED_RESUME_NOT_READY")
                with retirement._lock, _STATE.lock:
                    _require(p["deadline_at"] > int(time.time()*1000), "MANAGED_CONTROL_EXPIRED")
                    _require(retirement._active == 0 and not _STATE.active, "MANAGED_RESUME_NOT_READY")
                    _STATE.paused = False
            else:
                with retirement._lock, _STATE.lock:
                    _require(p["deadline_at"] > int(time.time()*1000), "MANAGED_CONTROL_EXPIRED")
                    _STATE.paused = True
        proof = _STATE.proof()
        _require(p["deadline_at"] > int(time.time()*1000), "MANAGED_CONTROL_EXPIRED")
        proof["operation_id"] = p["operation_id"]
        return {"jsonrpc": "2.0", "id": rid, "result": proof}
    except Exception as exc:
        if resume_authorized:
            with _STATE.lock:
                _STATE.paused = True
        code = exc.code if isinstance(exc, ManagedRuntimeError) else "MANAGED_CONTROL_INDETERMINATE"
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": 4097, "message": code, "data": {"code": code}}}
