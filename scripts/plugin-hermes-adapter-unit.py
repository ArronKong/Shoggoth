"""Local fixture for Hermes' trusted middleware-to-handler call boundary."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import threading

sys.dont_write_bytecode = True

root = Path(__file__).resolve().parents[1] / "resources/external-plugin-adapters/hermes"
spec = importlib.util.spec_from_file_location(
    "shoggoth_hermes_fixture", root / "__init__.py",
    submodule_search_locations=[str(root)],
)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

calls = []


def service(method, params, timeout=10.0):
    calls.append((method, params, timeout))
    if method == "plugin.external.open":
        return {"token": "fixture-lease"}
    return {"items": [], "total": 0, "nextCursor": None}


adapter = module.Adapter("default", request=service, credential=lambda: "fixture-pairing",
                         instance_id="fixture-instance")
handler = adapter.handler("shoggoth_capability_search")
args = {"query": "figma"}
context = {"tool_name": "shoggoth_capability_search", "args": args,
           "session_id": "fixture-session", "task_id": "fixture-task",
           "turn_id": "fixture-turn", "tool_call_id": "fixture-call"}

assert "no trusted" in json.loads(handler(args, session_id="fixture-session",
                                                 task_id="fixture-task"))["error"]
assert not calls


def invoke(next_args):
    return handler(next_args, task_id="fixture-task", session_id="fixture-session")


result = adapter.middleware(**context, next_call=invoke)
assert json.loads(result)["total"] == 0
assert calls[0][1]["identity"] == {
    "backendId": "hermes", "instanceId": "fixture-instance", "agentId": "hermes-default",
    "sessionId": "fixture-session", "taskId": "fixture-task", "turnId": "fixture-turn",
    "toolCallId": "fixture-call",
}
assert calls[1][0] == "plugin.external.search"
adapter.middleware(**{**context, "args": {"query": "figma", "cursor": 1,
                                     "revision": "a" * 64}}, next_call=invoke)
assert calls[-1][1]["revision"] == "a" * 64
assert "no trusted" in json.loads(handler(args, session_id="fixture-session",
                                                 task_id="fixture-task"))["error"]
assert "identity changed" in json.loads(adapter.middleware(
    **context, next_call=lambda next_args: handler(
        next_args, task_id="other-task", session_id="fixture-session")))["error"]
assert len(calls) == 4
assert "no trusted" in json.loads(adapter.middleware(
    **{**context, "turn_id": ""}, next_call=invoke))["error"]
assert len(calls) == 4

file_handler = adapter.handler("shoggoth_skill_file_read")
file_args = {"skillId": "a" * 64, "relativePath": "references/guide.md"}
adapter.middleware(**{**context, "tool_name": "shoggoth_skill_file_read", "args": file_args},
                   next_call=lambda next_args: file_handler(
                       next_args, task_id="fixture-task", session_id="fixture-session"))
assert calls[-1][0] == "plugin.external.skill.file.read"
assert calls[-1][1]["relativePath"] == "references/guide.md"

transport_module = sys.modules[f"{spec.name}.transport"]


def stale_catalog(_method, _params, timeout=10.0):
    raise transport_module.ServiceError("CATALOG_REVISION_CHANGED")


adapter.request = stale_catalog
stale = adapter.middleware(**context, next_call=invoke)
assert json.loads(stale)["code"] == "CATALOG_REVISION_CHANGED"
assert transport_module.ServiceError("unsafe message").code == "SHOGGOTH_SERVICE_ERROR"

registered = []


class Context:
    def register_middleware(self, kind, callback):
        registered.append(("middleware", kind))

    def register_hook(self, kind, callback):
        registered.append(("hook", kind))

    def register_tool(self, *, name, **_):
        registered.append(("tool", name))


adapter.register(Context())
assert registered == [("middleware", "tool_execution"),
                      ("hook", "agent_loop_stopped"),
                      *[("tool", name) for name in module.NAMES]]

# Stop is scoped to the exact Hermes session, even when two tool calls are
# blocked simultaneously in the synchronous Service transport.
entered = {key: threading.Event() for key in ("session-a", "session-b")}
released = {key: threading.Event() for key in entered}
canceled = []


def blocked_service(method, params, timeout=10.0):
    session = params["identity"]["sessionId"]
    if method == "plugin.external.open":
        return {"token": f"lease-{session}"}
    if method == "plugin.external.call":
        entered[session].set()
        assert released[session].wait(5), session
        return {"ok": True}
    if method == "plugin.external.cancel":
        canceled.append(session)
        released[session].set()
        return {"canceled": True}
    raise AssertionError(method)


parallel = module.Adapter("default", request=blocked_service,
                          credential=lambda: "fixture-pairing", instance_id="parallel-instance")
call = parallel.handler("shoggoth_plugin_call")


def invoke_session(session):
    args = {"serverId": "fixture", "toolName": "blocked", "arguments": {}}
    return parallel.middleware(tool_name="shoggoth_plugin_call", args=args,
                               session_id=session, task_id=f"task-{session}",
                               turn_id=f"turn-{session}", tool_call_id=f"call-{session}",
                               next_call=lambda value: call(value, session_id=session,
                                                            task_id=f"task-{session}"))


threads = [threading.Thread(target=invoke_session, args=(session,), daemon=True)
           for session in entered]
for thread in threads:
    thread.start()
assert all(event.wait(5) for event in entered.values())
parallel.on_loop_stopped(session_key="session-a", reason="user_stop")
assert released["session-a"].wait(5)
assert not released["session-b"].is_set()
released["session-b"].set()
for thread in threads:
    thread.join(5)
    assert not thread.is_alive()
assert canceled == ["session-a"]

opening = threading.Event()
finish_open = threading.Event()
late_calls = []


def delayed_open(method, params, timeout=10.0):
    late_calls.append(method)
    if method == "plugin.external.open":
        opening.set()
        assert finish_open.wait(5)
        return {"token": "late-lease"}
    if method == "plugin.external.cancel":
        return {"canceled": True}
    raise AssertionError("stopped turn reached a business call")


late = module.Adapter("default", request=delayed_open,
                      credential=lambda: "fixture-pairing", instance_id="late-instance")
late_handler = late.handler("shoggoth_plugin_call")
late_result = []


def invoke_late():
    args = {"serverId": "fixture", "toolName": "blocked", "arguments": {}}
    late_result.append(late.middleware(tool_name="shoggoth_plugin_call", args=args,
        session_id="late-session", task_id="late-task", turn_id="late-turn",
        tool_call_id="late-call", next_call=lambda value: late_handler(value,
            session_id="late-session", task_id="late-task")))


late_thread = threading.Thread(target=invoke_late, daemon=True)
late_thread.start()
assert opening.wait(5)
late.on_loop_stopped(session_key="late-session", reason="user_stop")
finish_open.set()
late_thread.join(5)
assert not late_thread.is_alive()
assert "turn was stopped" in json.loads(late_result[0])["error"]
assert late_calls == ["plugin.external.open", "plugin.external.cancel"]
print("plugin-hermes-adapter-unit: ok")
