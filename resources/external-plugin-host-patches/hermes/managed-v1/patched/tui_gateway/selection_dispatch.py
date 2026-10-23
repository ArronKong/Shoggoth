"""Mandatory, non-model-visible selection admission for normal Desktop turns.

Compatibility proof only: explicit opt-in gate owners, an immutable SQLite receipt,
and a turn-local context. No ordinary hook may stand in for this admission.
"""
from __future__ import annotations

import contextlib
import contextvars
import hashlib
import json
import re
import sqlite3
import threading
import uuid
from pathlib import Path
from types import MappingProxyType

_PROCESS = uuid.uuid4().hex
_ACTIVE = contextvars.ContextVar("hermes_required_selection_dispatch", default=None)
_EVENT = contextvars.ContextVar("hermes_selected_event_owner", default=None)
_FIELDS = {"version", "operation_id", "dispatch_ref", "selection_digest",
           "required_adapter_id", "adapter_generation"}
_OPAQUE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


class SelectionDispatchError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def normalize(envelope):
    if not isinstance(envelope, dict) or set(envelope) != _FIELDS or envelope.get("version") != 1:
        raise SelectionDispatchError("SELECTION_INVALID", "Invalid selection dispatch envelope")
    if isinstance(envelope["version"], bool):
        raise SelectionDispatchError("SELECTION_INVALID", "Invalid selection dispatch version")
    for key in _FIELDS - {"version", "selection_digest"}:
        if not isinstance(envelope[key], str) or not _OPAQUE.fullmatch(envelope[key]):
            raise SelectionDispatchError("SELECTION_INVALID", "Invalid selection dispatch reference")
    if not isinstance(envelope["selection_digest"], str) or not re.fullmatch(r"[a-f0-9]{64}", envelope["selection_digest"]):
        raise SelectionDispatchError("SELECTION_INVALID", "Invalid selection digest")
    return dict(envelope)


def register_gate(ctx, callback, *, metadata, finish):
    from hermes_cli.plugins import _plugin_home_scope, _plugin_settings_entry, load_config_readonly
    with _plugin_home_scope(ctx._manager.home_path):
        config = load_config_readonly() or {}
    if (_plugin_settings_entry(config, ctx.plugin_id) or {}).get("allow_selection_dispatch_gate") is not True:
        raise SelectionDispatchError("SELECTION_ADAPTER_UNTRUSTED", "Selection gate owner needs operator consent")
    if not callable(callback) or not callable(finish):
        raise TypeError("Selection dispatch gate and finish must be callable")
    if not isinstance(metadata, dict) or set(metadata) != {"instance_id", "agent_id"} or not all(
        isinstance(value, str) and _OPAQUE.fullmatch(value) for value in metadata.values()
    ):
        raise SelectionDispatchError("SELECTION_ADAPTER_METADATA_INVALID", "Selection gate owner metadata is invalid")
    gates = ctx._manager._selection_dispatch_gates
    if ctx.plugin_id in gates:
        raise SelectionDispatchError("SELECTION_ADAPTER_DUPLICATE", "Selection gate already registered")
    entry = {"callback": callback, "generation": uuid.uuid4().hex, "plugin_id": ctx.plugin_id, "metadata": dict(metadata), "finish": finish}
    handle = ctx._track_mapping_entry("selection_dispatch_gate", ctx.plugin_id, gates, entry, None)
    # Registration metadata is issued by the host and immutable to its owner.
    # It is outside model arguments and does not replace the unload lease.
    handle.selection_dispatch = MappingProxyType({"version": 1,
        "required_adapter_id": ctx.plugin_id, "adapter_generation": entry["generation"],
        **entry["metadata"]})
    return handle


def _manager(home):
    from hermes_cli.plugins import _plugin_home_scope, _ensure_plugins_discovered
    with _plugin_home_scope(Path(home)):
        return _ensure_plugins_discovered()


def _gate(home, envelope):
    from hermes_cli.plugins import _plugin_home_scope, _plugin_settings_entry, load_config_readonly
    manager = _manager(home)
    owner = envelope["required_adapter_id"]
    entry = manager._selection_dispatch_gates.get(owner)
    loaded = manager._plugins.get(owner)
    with _plugin_home_scope(Path(home)):
        config = load_config_readonly() or {}
    trusted = (_plugin_settings_entry(config, owner) or {}).get("allow_selection_dispatch_gate") is True
    if not trusted or not entry or not loaded or not loaded.enabled or loaded.error or loaded.module is None:
        raise SelectionDispatchError("SELECTION_ADAPTER_UNAVAILABLE", "Required trusted selection adapter is unavailable")
    if entry["generation"] != envelope["adapter_generation"]:
        raise SelectionDispatchError("SELECTION_ADAPTER_STALE", "Selection adapter generation changed")
    return manager, entry


def capabilities(home):
    manager = _manager(home)
    result = []
    for owner, entry in list(manager._selection_dispatch_gates.items()):
        probe = {"required_adapter_id": owner, "adapter_generation": entry["generation"]}
        try:
            _gate(home, probe)
        except SelectionDispatchError:
            continue
        result.append({"required_adapter_id": owner, "adapter_generation": entry["generation"], **entry["metadata"]})
    return {"version": 1, "adapters": result}


@contextlib.contextmanager
def _db(home):
    root = Path(home).resolve(strict=True)
    target = root / "selection-dispatches.sqlite"
    if target.is_symlink():
        raise SelectionDispatchError("SELECTION_STORAGE_UNAVAILABLE", "Selection receipt storage is unsafe")
    connection = sqlite3.connect(target, timeout=5)
    target.chmod(0o600)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("""CREATE TABLE IF NOT EXISTS selection_dispatches(
          dispatch_id TEXT PRIMARY KEY, ui_session_id TEXT NOT NULL, owner_session_id TEXT NOT NULL, operation_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL, envelope TEXT NOT NULL, process_generation TEXT NOT NULL,
          state TEXT NOT NULL, actual_session_id TEXT, actual_task_id TEXT, actual_turn_id TEXT,
          error_code TEXT, UNIQUE(owner_session_id, operation_id), UNIQUE(ui_session_id, operation_id))""")
        with connection:
            yield connection
    finally:
        connection.close()


def _receipt(row):
    envelope = json.loads(row["envelope"])
    return {"version": 1, "dispatch_id": row["dispatch_id"], **envelope, "state": row["state"],
            "actual_session_id": row["actual_session_id"], "actual_task_id": row["actual_task_id"],
            "actual_turn_id": row["actual_turn_id"], "error_code": row["error_code"]}


def _recover(db, row):
    if row["process_generation"] != _PROCESS and row["state"] in {"accepted", "queued", "binding", "bound"}:
        state = "unknown" if row["state"] in {"binding", "bound"} else "interrupted"
        db.execute("UPDATE selection_dispatches SET state=?, error_code=? WHERE dispatch_id=?",
                   (state, "SELECTION_HOST_RESTARTED", row["dispatch_id"]))
        row = db.execute("SELECT * FROM selection_dispatches WHERE dispatch_id=?", (row["dispatch_id"],)).fetchone()
    return row


def accept(home, ui_session_id, text, envelope, *, owner_session_id):
    envelope = normalize(envelope)
    if not isinstance(owner_session_id, str) or not 0 < len(owner_session_id) <= 256:
        raise SelectionDispatchError("SELECTION_IDENTITY_UNAVAILABLE", "Exact host session owner is unavailable")
    fingerprint = hashlib.sha256(json.dumps({"text": text, "envelope": envelope},
        sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    with _db(home) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT * FROM selection_dispatches WHERE owner_session_id=? AND operation_id=?",
                         (owner_session_id, envelope["operation_id"])).fetchone()
        if row:
            if row["fingerprint"] != fingerprint:
                raise SelectionDispatchError("SELECTION_CONFLICT", "Selection operation was used for different input")
            return _receipt(_recover(db, row)), True
        _gate(home, envelope)
        dispatch_id = uuid.uuid4().hex
        db.execute("INSERT INTO selection_dispatches VALUES(?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL)",
            (dispatch_id, ui_session_id, owner_session_id, envelope["operation_id"], fingerprint,
             json.dumps(envelope, sort_keys=True), _PROCESS, "accepted"))
        row = db.execute("SELECT * FROM selection_dispatches WHERE dispatch_id=?", (dispatch_id,)).fetchone()
        return _receipt(row), False


def get(home, ui_session_id, operation_id, *, owner_session_id=None):
    with _db(home) as db:
        owner_key = "ui_session_id" if owner_session_id is None else "owner_session_id"
        owner = ui_session_id if owner_session_id is None else owner_session_id
        row = db.execute(f"SELECT * FROM selection_dispatches WHERE {owner_key}=? AND operation_id=?",
                         (owner, operation_id)).fetchone()
        if not row:
            raise SelectionDispatchError("SELECTION_NOT_FOUND", "Selection dispatch not found for this session")
        return _receipt(_recover(db, row))


def state(home, ui_session_id, envelope, value, error_code=None):
    with _db(home) as db:
        db.execute("UPDATE selection_dispatches SET state=?, error_code=? WHERE ui_session_id=? AND operation_id=? AND process_generation=?",
                   (value, error_code, ui_session_id, envelope["operation_id"], _PROCESS))
    event_owner = _EVENT.get()
    if event_owner is not None and event_owner["sid"] == ui_session_id and event_owner["envelope"] == envelope:
        event_owner["receipt"] = _event_snapshot(home, ui_session_id, envelope)




def _event_snapshot(home, ui_session_id, envelope):
    with _db(home) as db:
        row = db.execute("SELECT * FROM selection_dispatches WHERE ui_session_id=? AND operation_id=?",
                         (ui_session_id, envelope["operation_id"])).fetchone()
        if row is None or json.loads(row["envelope"]) != envelope:
            raise SelectionDispatchError("SELECTION_NOT_FOUND", "Selected event owner is unavailable")
        return {**_receipt(row), "runtime_session_id": row["owner_session_id"]}


@contextlib.contextmanager
def event_scope(home, ui_session_id, envelope, *, emit=None):
    """Own event identity across a whole normal worker, including terminal frames.

    Never use the session's latest active marker: a queued turn must not label
    its predecessor's events. Shared snapshot is refreshed only by core state.
    """
    owner = None
    if envelope is not None:
        envelope = normalize(envelope)
        owner = {"home": str(home), "sid": ui_session_id, "envelope": envelope,
                 "receipt": _event_snapshot(home, ui_session_id, envelope), "emit": emit}
    token = _EVENT.set(owner)
    try:
        yield
    finally:
        _EVENT.reset(token)


def event_sideband(ui_session_id):
    owner = _EVENT.get()
    return None if owner is None or owner["sid"] != ui_session_id else dict(owner["receipt"])


@contextlib.contextmanager
def turn_scope(home, ui_session_id, envelope):
    token = _ACTIVE.set(None if envelope is None else {
        "home": str(home), "ui_session_id": ui_session_id, "envelope": normalize(envelope)})
    try:
        yield
    finally:
        _ACTIVE.reset(token)


def before_model(agent, task_id, turn_id, *, unsupported_runtime=False):
    selected = _ACTIVE.get()
    if selected is None:
        return ""
    home, sid, envelope = selected["home"], selected["ui_session_id"], selected["envelope"]
    actual_session = getattr(agent, "session_id", "")
    identity = {"runtime_session_id": actual_session, "task_id": task_id, "turn_id": turn_id}
    try:
        if not all(isinstance(value, str) and 0 < len(value) <= 256 for value in identity.values()):
            raise SelectionDispatchError("SELECTION_IDENTITY_UNAVAILABLE", "Exact host turn identity is unavailable")
        if unsupported_runtime or getattr(agent, "api_mode", None) == "codex_app_server":
            raise SelectionDispatchError("SELECTION_RUNTIME_UNSUPPORTED", "This selected model runtime is unsupported")
        from tui_gateway.selection_input import verify_before_model
        verify_before_model(home, actual_session, envelope["operation_id"])
        manager, entry = _gate(home, envelope)
        with _db(home) as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM selection_dispatches WHERE ui_session_id=? AND operation_id=?", (sid, envelope["operation_id"])).fetchone()
            if not row or row["process_generation"] != _PROCESS or row["state"] not in {"accepted", "queued"} or json.loads(row["envelope"]) != envelope:
                raise SelectionDispatchError("SELECTION_ALREADY_CONSUMED", "Selection dispatch cannot run again")
            if row["owner_session_id"] != actual_session:
                raise SelectionDispatchError("SELECTION_IDENTITY_CHANGED", "Selected session owner changed before admission")
            db.execute("UPDATE selection_dispatches SET state='binding', actual_session_id=?, actual_task_id=?, actual_turn_id=? WHERE dispatch_id=?",
                       (actual_session, task_id, turn_id, row["dispatch_id"]))
        selected["identity"] = identity
        selected["entry"] = entry
        done, result = threading.Event(), {}
        def invoke():
            try:
                result["proof"] = entry["callback"](selection=MappingProxyType(dict(envelope)), identity=MappingProxyType(identity))
            except BaseException:
                result["failed"] = True
            finally:
                done.set()
        callback_context = contextvars.copy_context()
        threading.Thread(target=lambda: callback_context.run(invoke), daemon=True, name="selection-dispatch-gate").start()
        if not done.wait(2.0):
            raise SelectionDispatchError("SELECTION_GATE_TIMEOUT", "Selection gate did not accept this turn")
        if result.get("failed"):
            raise SelectionDispatchError("SELECTION_GATE_FAILED", "Selection gate rejected this turn")
        proof = result.get("proof")
        if not isinstance(proof, dict) or set(proof) != {"dispatch_ref", "selection_digest", "adapter_generation", "context"}:
            raise SelectionDispatchError("SELECTION_PROOF_INVALID", "Selection gate returned invalid proof")
        if any(proof[key] != envelope[key] for key in ("dispatch_ref", "selection_digest", "adapter_generation")):
            raise SelectionDispatchError("SELECTION_PROOF_INVALID", "Selection gate proof does not match this dispatch")
        context = proof["context"]
        if not isinstance(context, str) or not context.strip() or len(context) > 8192 or any(
            envelope[key] in context for key in ("dispatch_ref", "operation_id", "selection_digest", "adapter_generation")
        ):
            raise SelectionDispatchError("SELECTION_PROOF_INVALID", "Selection context is invalid")
        current_manager, current_entry = _gate(home, envelope)
        if current_manager is not manager or current_entry is not entry:
            raise SelectionDispatchError("SELECTION_ADAPTER_STALE", "Selection gate owner changed during admission")
        selected["identity"] = identity
        selected["context"] = context
        state(home, sid, envelope, "bound")
        owner = _EVENT.get()
        if owner is not None and owner["sid"] == sid and owner["envelope"] == envelope and callable(owner["emit"]):
            owner["emit"]("selection.dispatch.bound", sid)
        return context
    except SelectionDispatchError as exc:
        state(home, sid, envelope, "failed", exc.code)
        raise


def verify_identity(agent, task_id, turn_id):
    selected = _ACTIVE.get()
    if selected is None:
        return
    if selected.get("identity") != {"runtime_session_id": agent.session_id, "task_id": task_id, "turn_id": turn_id}:
        state(selected["home"], selected["ui_session_id"], selected["envelope"], "failed", "SELECTION_IDENTITY_CHANGED")
        raise SelectionDispatchError("SELECTION_IDENTITY_CHANGED", "Selected host identity changed before model execution")



def required_multimodal_context():
    """Only the bound mandatory scope can request multipart API injection."""
    selected = _ACTIVE.get()
    if selected is None:
        return None
    context = selected.get("context")
    if "identity" not in selected or not isinstance(context, str) or not context.strip():
        raise SelectionDispatchError("SELECTION_CONTEXT_MISSING", "Selected multipart context is unavailable")
    return context


def verify_request(agent, task_id, turn_id, request):
    """Core call boundary, after skippable LLM middleware and before provider IO."""
    selected = _ACTIVE.get()
    if selected is None:
        return
    home, sid, envelope = selected["home"], selected["ui_session_id"], selected["envelope"]
    try:
        verify_identity(agent, task_id, turn_id)
        _gate(home, envelope)
        receipt = get(home, sid, envelope["operation_id"])
        if receipt["state"] != "bound":
            raise SelectionDispatchError("SELECTION_TURN_NOT_BOUND", "Selection dispatch is not bound")
        def has_context(value):
            if isinstance(value, str):
                return selected["context"] in value
            if isinstance(value, dict):
                return any(has_context(item) for item in value.values())
            if isinstance(value, (list, tuple)):
                return any(has_context(item) for item in value)
            return False
        if selected.get("context") and not has_context(request):
            raise SelectionDispatchError("SELECTION_CONTEXT_MISSING", "Selected context was removed before model execution")
    except SelectionDispatchError as exc:
        state(home, sid, envelope, "failed", exc.code)
        raise


def tool_context(agent, task_id, turn_id):
    """Mandatory core-owned metadata, propagated to actual tool worker threads."""
    selected = _ACTIVE.get()
    if selected is None:
        return {}
    home, sid, envelope = selected["home"], selected["ui_session_id"], selected["envelope"]
    try:
        verify_identity(agent, task_id, turn_id)
        _manager_current, entry = _gate(home, envelope)
        if entry is not selected.get("entry"):
            raise SelectionDispatchError("SELECTION_ADAPTER_STALE", "Selected tool adapter owner changed")
        receipt = get(home, sid, envelope["operation_id"])
        if receipt["state"] != "bound":
            raise SelectionDispatchError("SELECTION_TURN_NOT_BOUND", "Selected tool turn is not bound")
        return {"selection_dispatch": MappingProxyType(dict(envelope)),
                "selection_adapter_instance_id": entry["metadata"]["instance_id"]}
    except SelectionDispatchError as exc:
        state(home, sid, envelope, "failed", exc.code)
        raise


def finish_turn(agent, outcome):
    """Mandatory final receipt for the exact admitted identity; failure is never replayed."""
    selected = _ACTIVE.get()
    if selected is None or "entry" not in selected or "context" not in selected:
        return  # No successful mandatory admission exists to finish.
    home, sid, envelope = selected["home"], selected["ui_session_id"], selected["envelope"]
    entry, identity = selected["entry"], selected["identity"]
    try:
        if outcome not in {"complete", "stopped", "failed"} or agent.session_id != identity["runtime_session_id"]:
            raise SelectionDispatchError("SELECTION_FINISH_UNCONFIRMED", "Selected turn completion identity changed")
        done, result = threading.Event(), {}
        def invoke():
            try:
                result["proof"] = entry["finish"](selection=MappingProxyType(dict(envelope)),
                    identity=MappingProxyType(dict(identity)), outcome=outcome)
            except BaseException:
                result["failed"] = True
            finally:
                done.set()
        callback_context = contextvars.copy_context()
        threading.Thread(target=lambda: callback_context.run(invoke), daemon=True, name="selection-dispatch-finish").start()
        if not done.wait(2.0) or result.get("failed"):
            raise SelectionDispatchError("SELECTION_FINISH_UNCONFIRMED", "Selected turn completion was not confirmed")
        proof = result.get("proof")
        if not isinstance(proof, dict) or set(proof) != {"dispatch_ref", "selection_digest", "adapter_generation"} or any(
            proof[key] != envelope[key] for key in proof
        ):
            raise SelectionDispatchError("SELECTION_FINISH_UNCONFIRMED", "Selected turn completion proof is invalid")
        receipt = get(home, sid, envelope["operation_id"])
        if receipt["state"] == "bound":
            state(home, sid, envelope, "complete" if outcome == "complete" else "stopped" if outcome == "stopped" else "failed")
    except SelectionDispatchError as exc:
        state(home, sid, envelope, "unknown", exc.code)
        raise


def cancel_pending(home, ui_session_id, envelopes):
    """Only accepted/queued snapshots are cancelled; a bound turn needs exact finish."""
    if not envelopes:
        return
    with _db(home) as db:
        db.execute("BEGIN IMMEDIATE")
        for envelope in envelopes:
            envelope = normalize(envelope)
            db.execute("UPDATE selection_dispatches SET state='cancelled', error_code='SELECTION_CANCELLED' WHERE ui_session_id=? AND operation_id=? AND envelope=? AND process_generation=? AND state IN ('accepted','queued')",
                (ui_session_id, envelope["operation_id"], json.dumps(envelope, sort_keys=True), _PROCESS))
