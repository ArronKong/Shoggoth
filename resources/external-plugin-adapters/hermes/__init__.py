"""Hermes bridge for capabilities installed and authorized in Shoggoth."""

from __future__ import annotations

import contextvars
import json
import re
import threading
import uuid

from .transport import read_credential, request_service

NAMES = ("shoggoth_capability_search", "shoggoth_skill_read",
         "shoggoth_skill_file_read", "shoggoth_plugin_call")
_active_call = contextvars.ContextVar("shoggoth_external_plugin_call", default=None)


def _schema(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {"name": name, "description": description,
            "parameters": {"type": "object", "properties": properties,
                           "required": required, "additionalProperties": False}}


SCHEMAS = {
    "shoggoth_capability_search": _schema("shoggoth_capability_search",
        "Search installed and enabled Shoggoth skills and plugin tools.",
        {"query": {"type": "string"}, "cursor": {"type": "integer", "minimum": 0},
         "revision": {"type": "string", "pattern": "^[a-f0-9]{64}$"}}, ["query"]),
    "shoggoth_skill_read": _schema("shoggoth_skill_read",
        "Read one installed Shoggoth Skill by id.",
        {"skillId": {"type": "string"}, "cursor": {"type": "integer", "minimum": 0}}, ["skillId"]),
    "shoggoth_skill_file_read": _schema("shoggoth_skill_file_read",
        "Read a text file in an installed Shoggoth Skill by relative path.",
        {"skillId": {"type": "string"}, "relativePath": {"type": "string"},
         "cursor": {"type": "integer", "minimum": 0}}, ["skillId", "relativePath"]),
    "shoggoth_plugin_call": _schema("shoggoth_plugin_call",
        "Call one authorized Shoggoth plugin tool by server and tool name.",
        {"serverId": {"type": "string"}, "toolName": {"type": "string"},
         "arguments": {"type": "object"}}, ["serverId", "toolName", "arguments"]),
}


def _agent_id(profile_name: str) -> str:
    safe = re.sub(r"[^a-z0-9-]+", "-", profile_name.lower()).strip("-")
    return "hermes-" + (safe or "default")


class Adapter:
    def __init__(self, profile_name: str, *, request=request_service, credential=read_credential,
                 instance_id: str | None = None):
        self.profile_name = profile_name
        self.agent_id = _agent_id(profile_name)
        self.instance_id = instance_id or str(uuid.uuid4())
        self.request = request
        self.credential = credential
        self._lock = threading.Lock()
        self._session_epoch = {}
        self._active = {}

    def _cancel_lease(self, token: str, identity: dict):
        try:
            self.request("plugin.external.cancel", {"token": token, "identity": identity}, timeout=2.0)
        except Exception:
            # A completed/revoked lease is already unusable. Stop must never
            # fail because a cancellation raced with ordinary completion.
            pass

    def on_loop_stopped(self, *, session_key=None, **_kwargs):
        if not isinstance(session_key, str) or not session_key:
            return
        with self._lock:
            self._session_epoch[session_key] = self._session_epoch.get(session_key, 0) + 1
            pending = []
            for state in self._active.values():
                if state["identity"]["sessionId"] != session_key:
                    continue
                state["canceled"] = True
                if state["token"]:
                    pending.append((state["token"], state["identity"]))
        if pending:
            # Hermes executes plugins synchronously; session.interrupt runs on
            # another host thread. Keep that RPC responsive while closing the
            # exact in-flight Service leases, each with a bounded timeout.
            def cancel_pending():
                for token, identity in pending:
                    self._cancel_lease(token, identity)
            threading.Thread(target=cancel_pending, daemon=True).start()

    def middleware(self, **kwargs):
        next_call = kwargs["next_call"]
        if kwargs.get("tool_name") not in NAMES:
            return next_call(kwargs["args"])
        fields = {key: kwargs.get(key) for key in ("session_id", "task_id", "turn_id", "tool_call_id")}
        if not all(isinstance(value, str) and 0 < len(value) <= 256 for value in fields.values()):
            # Middleware failures are fail-open in Hermes; the handler still
            # refuses execution because no trusted context is installed.
            return next_call(kwargs["args"])
        identity = {"backendId": "hermes", "instanceId": self.instance_id,
                    "agentId": self.agent_id, "sessionId": fields["session_id"],
                    "taskId": fields["task_id"], "turnId": fields["turn_id"],
                    "toolCallId": fields["tool_call_id"]}
        with self._lock:
            epoch = self._session_epoch.get(identity["sessionId"], 0)
        marker = _active_call.set((kwargs["tool_name"], identity, epoch))
        try:
            return next_call(kwargs["args"])
        finally:
            _active_call.reset(marker)

    def handler(self, name: str):
        def execute(args, **kwargs):
            captured = _active_call.get()
            if not captured or captured[0] != name:
                return json.dumps({"error": "Shoggoth call has no trusted host execution identity"})
            identity = captured[1]
            epoch = captured[2]
            # Hermes' registry forwards task/session to the handler, while
            # turn/tool-call remain in the enclosing middleware context.
            if (kwargs.get("session_id") != identity["sessionId"]
                    or kwargs.get("task_id") != identity["taskId"]):
                return json.dumps({"error": "Shoggoth host execution identity changed"})
            if not isinstance(args, dict):
                return json.dumps({"error": "Shoggoth tool arguments invalid"})
            key = (identity["sessionId"], identity["taskId"],
                   identity["turnId"], identity["toolCallId"])
            with self._lock:
                if epoch != self._session_epoch.get(identity["sessionId"], 0):
                    return json.dumps({"error": "Shoggoth turn was stopped"})
                if key in self._active:
                    return json.dumps({"error": "Shoggoth tool identity was already used"})
                state = {"identity": identity, "token": None, "canceled": False}
                self._active[key] = state
            try:
                opened = self.request("plugin.external.open", {
                    "credentialToken": self.credential(), "identity": identity})
                with self._lock:
                    state["token"] = opened["token"]
                    canceled = state["canceled"] or epoch != self._session_epoch.get(
                        identity["sessionId"], 0)
                if canceled:
                    self._cancel_lease(opened["token"], identity)
                    return json.dumps({"error": "Shoggoth turn was stopped"})
                base = {"token": opened["token"], "identity": identity}
                if name == "shoggoth_capability_search":
                    method = "plugin.external.search"
                    base.update(query=args.get("query"), cursor=args.get("cursor", 0), limit=5)
                    if args.get("revision") is not None:
                        base["revision"] = args["revision"]
                elif name == "shoggoth_skill_read":
                    method = "plugin.external.skill.read"
                    base.update(skillId=args.get("skillId"), cursor=args.get("cursor", 0))
                elif name == "shoggoth_skill_file_read":
                    method = "plugin.external.skill.file.read"
                    base.update(skillId=args.get("skillId"), relativePath=args.get("relativePath"),
                                cursor=args.get("cursor", 0))
                else:
                    method = "plugin.external.call"
                    base.update(serverId=args.get("serverId"), toolName=args.get("toolName"),
                                arguments=args.get("arguments"))
                result = self.request(method, base, timeout=120.0 if method == "plugin.external.call" else 10.0)
                return json.dumps(result, ensure_ascii=False)
            except Exception as exc:
                return json.dumps({"error": "Shoggoth capability unavailable",
                                   "code": getattr(exc, "code", "SHOGGOTH_ADAPTER_UNAVAILABLE")})
            finally:
                with self._lock:
                    self._active.pop(key, None)
        return execute

    def register(self, ctx):
        ctx.register_middleware("tool_execution", self.middleware)
        ctx.register_hook("agent_loop_stopped", self.on_loop_stopped)
        for name in NAMES:
            ctx.register_tool(name=name, toolset="shoggoth_shared_capabilities",
                              schema=SCHEMAS[name], handler=self.handler(name))


def register(ctx):
    Adapter(ctx.profile_name).register(ctx)
