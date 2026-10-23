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

resource_handler = adapter.handler("shoggoth_plugin_resource_read")
resource_args = {"skillId": "a" * 64, "relativePath": "shared/workflow.md"}
adapter.middleware(**{**context, "tool_name": "shoggoth_plugin_resource_read",
                      "args": resource_args},
                   next_call=lambda next_args: resource_handler(
                       next_args, task_id="fixture-task", session_id="fixture-session"))
assert calls[-1][0] == "plugin.external.resource.read"
assert calls[-1][1]["relativePath"] == "shared/workflow.md"

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

# Host-owned mandatory gate registration, explicit snake wire mapping, and
# strict Service current-installation reply. Never trust model tool arguments.
from copy import deepcopy
from types import MappingProxyType, SimpleNamespace

wire = {'version': 1, 'operation_id': 'selected.operation', 'dispatch_ref': 'selected.reference',
        'selection_digest': 'b' * 64, 'required_adapter_id': module.ADAPTER_ID,
        'adapter_generation': 'selected.generation'}
envelope = {target: wire[source] for source, target in module._WIRE.items()}
host_identity = {'runtime_session_id': 'physical.session', 'task_id': 'actual.task', 'turn_id': 'actual.turn'}
execution = {'backendId': 'hermes', 'instanceId': 'gate.instance', 'agentId': 'hermes-default',
             'sessionId': 'physical.session', 'taskId': 'actual.task', 'turnId': 'actual.turn'}
receipt = {**envelope, 'state': 'bound', 'subject': {k: execution[k] for k in module._SUBJECT},
           'identity': execution, 'createdAt': 1, 'updatedAt': 2, 'expiresAt': 10000}
bind_result = {'envelope': envelope, 'receipt': receipt, 'selectedPlugins': [
    {'installationId': 'installed.fixture', 'revision': 3, 'releaseDigest': 'c' * 64,
     'packageName': 'installed-fixture', 'declaredVersion': None}]}
selected_calls = []


def selected_service(method, params, timeout=10.0):
    selected_calls.append((method, deepcopy(params), timeout))
    if method == 'plugin.external.selection.bind': return deepcopy(bind_result)
    if method == 'plugin.external.selection.finish': return {**deepcopy(receipt), 'state': 'completed'}
    if method == 'plugin.external.open': return {'token': 'selected.tool.lease'}
    return {'items': [], 'total': 0, 'nextCursor': None}


class SelectedContext:
    def register_selection_dispatch_gate(self, gate, *, metadata, finish):
        self.gate, self.finish = gate, finish
        assert metadata == {'instance_id': 'gate.instance', 'agent_id': 'hermes-default'}
        return SimpleNamespace(selection_dispatch=MappingProxyType({
            'version': 1, 'required_adapter_id': module.ADAPTER_ID,
            'adapter_generation': wire['adapter_generation'], **metadata}))
    def register_middleware(self, *args): pass
    def register_hook(self, *args): pass
    def register_tool(self, **kwargs): pass


selected_adapter = module.Adapter('default', request=selected_service,
    credential=lambda: 'fixture-pairing', instance_id='gate.instance')
selected_context = SelectedContext()
selected_adapter.register(selected_context)
proof = selected_context.gate(selection=MappingProxyType(wire), identity=MappingProxyType(host_identity))
assert proof['dispatch_ref'] == wire['dispatch_ref']
assert '"packageName":"installed-fixture"' in proof['context']
assert '"version":"cccccccccccc"' in proof['context']
assert not any(value in proof['context'] for value in (wire['dispatch_ref'], wire['operation_id'], wire['adapter_generation'], wire['selection_digest'], 'fixture-pairing'))
assert selected_calls[0] == ('plugin.external.selection.bind',
    {'credentialToken': 'fixture-pairing', 'envelope': envelope, 'identity': execution}, 1.5)
for changed in ({**wire, 'dispatchRef': 'camel'}, {**wire, 'version': True},
                {**wire, 'adapter_generation': 'another-generation'}):
    before = len(selected_calls)
    try: selected_context.gate(selection=changed, identity=host_identity)
    except RuntimeError: pass
    else: raise AssertionError('invalid wire reached selection gate')
    assert len(selected_calls) == before
for edit in ('envelope', 'identity', 'pluginFields', 'revision', 'version', 'duplicate', 'envelopeBoolean', 'receiptBoolean', 'unsafeTimestamp', 'unsafeRevision'):
    bad = deepcopy(bind_result)
    if edit == 'envelope': bad['envelope']['dispatchRef'] = 'wrong-reference'
    elif edit == 'identity': bad['receipt']['identity']['turnId'] = 'another-turn'
    elif edit == 'pluginFields': bad['selectedPlugins'][0]['injectedContent'] = 'caller payload'
    elif edit == 'revision': bad['selectedPlugins'][0]['revision'] = True
    elif edit == 'version': bad['selectedPlugins'][0]['declaredVersion'] = 'unsafe\nversion'
    elif edit == 'duplicate': bad['selectedPlugins'].append(deepcopy(bad['selectedPlugins'][0]))
    elif edit == 'envelopeBoolean': bad['envelope']['version'] = True
    elif edit == 'receiptBoolean': bad['receipt']['version'] = True
    elif edit == 'unsafeTimestamp': bad['receipt']['createdAt'] = 2**53
    else: bad['selectedPlugins'][0]['revision'] = 2**53
    try: module._selected_preference(bad, envelope, execution)
    except RuntimeError: pass
    else: raise AssertionError('unvalidated Service selection reply accepted')
scoped = module.Adapter('default', request=selected_service,
    credential=lambda: 'fixture-pairing', instance_id='different.scoped.instance')
scoped_handler = scoped.handler('shoggoth_capability_search')
scoped_context = {**context, 'session_id': 'physical.session', 'task_id': 'actual.task',
    'turn_id': 'actual.turn', 'tool_call_id': 'selected.tool.call',
    'selection_dispatch': MappingProxyType(wire), 'selection_adapter_instance_id': 'gate.instance'}
scoped.middleware(**scoped_context, next_call=lambda value: scoped_handler(value,
    session_id='physical.session', task_id='actual.task'))
opened = [params for method, params, _timeout in selected_calls if method == 'plugin.external.open'][-1]
assert opened['identity'] == {**execution, 'toolCallId': 'selected.tool.call'}
assert opened['selectionEnvelope'] == envelope
for missing in ('selection_dispatch', 'selection_adapter_instance_id'):
    bad = {key: value for key, value in scoped_context.items() if key != missing}
    before = len(selected_calls)
    denied = scoped.middleware(**bad, next_call=lambda _value: (_ for _ in ()).throw(AssertionError('invalid selected tool dispatched')))
    assert 'no trusted Host binding' in json.loads(denied)['error']
    assert len(selected_calls) == before
for outcome in ('complete', 'stopped', 'failed'):
    assert selected_context.finish(selection=wire, identity=host_identity, outcome=outcome) == {
        key: wire[key] for key in ('dispatch_ref', 'selection_digest', 'adapter_generation')}
assert all(call[1]['identity'] == execution for call in selected_calls if call[0] == 'plugin.external.selection.finish')
print('plugin-hermes-adapter-selection-unit: ok')

# Already-bound canceled receipt is read-only known Stop confirmation.
# Unbound cancellation has no exact identity and cannot confirm a host turn.
for closed in ({**deepcopy(receipt), 'state': 'canceled'},):
    selected_adapter.request=lambda _method, _params, timeout=10.0: closed
    assert selected_context.finish(selection=wire, identity=host_identity, outcome='stopped')['dispatch_ref'] == wire['dispatch_ref']
selected_adapter.request=lambda _method, _params, timeout=10.0: {**deepcopy(receipt), 'state':'canceled', 'identity':None}
try: selected_context.finish(selection=wire, identity=host_identity, outcome='stopped')
except RuntimeError: pass
else: raise AssertionError('unbound canceled receipt confirmed a turn')
print('plugin-hermes-adapter-known-stop-unit: ok')

# Protocol-v2 group collaboration follows the same trusted middleware identity.
assert "group_collaborate" in module.GROUP_SCHEMAS
collaboration_calls = []
def collaboration_service(method, params, timeout=10.0):
    collaboration_calls.append((method, params))
    return {"ok": True, "state": "registered"}
collaborator = module.Adapter("default", request=collaboration_service, credential=lambda: "fixture-pairing",
                             instance_id="group-v2-instance")
collaboration_handler = collaborator.handler("group_collaborate")
collaboration_args = {"groupToken": "fixture-group-token", "action": "ask", "clientActionId": "ask-1",
                      "itemId": "item-1", "target": "@reader", "objective": "Read source", "stopCondition": "Cite source"}
assert "no trusted" in json.loads(collaboration_handler(collaboration_args,
    session_id="fixture-session", task_id="fixture-task"))["error"]
assert not collaboration_calls
collaborator.middleware(**{**context, "tool_name": "group_collaborate", "args": collaboration_args},
    next_call=lambda next_args: collaboration_handler(next_args, task_id="fixture-task", session_id="fixture-session"))
assert collaboration_calls[0][0] == "group.adapter.call"
assert collaboration_calls[0][1]["name"] == "group_collaborate"
assert collaboration_calls[0][1]["arguments"] == collaboration_args
assert collaboration_calls[0][1]["agentId"] == "hermes-default"

# Actual registration retains the same specialized descriptions and nested schema.
from types import SimpleNamespace
registered = {}
collaborator.register(SimpleNamespace(register_middleware=lambda *args, **kwargs: None,
    register_hook=lambda *args, **kwargs: None,
    register_tool=lambda **kwargs: registered.update({kwargs["name"]: kwargs})))
for name in module.GROUP_NAMES:
    assert registered[name]["schema"]["description"] == module.GROUP_DESCRIPTIONS[name]
    assert registered[name]["schema"]["parameters"] == module.GROUP_SCHEMAS[name]
assert "taskId" in registered["group_task"]["schema"]["description"]
assert "completion_check" in registered["group_collaborate"]["schema"]["description"]

task_reader = collaborator.handler("group_task")
before_invalid = len(collaboration_calls)
missing_get = {"groupToken": "fixture-group-token", "action": "get"}
missing_result = collaborator.middleware(**{**context, "tool_name": "group_task", "args": missing_get, "tool_call_id": "missing-get"},
    next_call=lambda value: task_reader(value, task_id="fixture-task", session_id="fixture-session"))
assert "Missing taskId" in json.loads(missing_result)["problems"]
assert len(collaboration_calls) == before_invalid
fixed_get = {**missing_get, "taskId": "full-owned-task-id"}
collaborator.middleware(**{**context, "tool_name": "group_task", "args": fixed_get, "tool_call_id": "fixed-get"},
    next_call=lambda value: task_reader(value, task_id="fixture-task", session_id="fixture-session"))
assert collaboration_calls[-1][1]["arguments"] == fixed_get

before_finish = len(collaboration_calls)
bad_finish = {"groupToken": "fixture-group-token", "action": "finish", "clientActionId": "bad-finish", "summary": "PRIVATE_SUMMARY", "resultRefs": []}
invalid_finish = collaborator.middleware(**{**context, "tool_name": "group_collaborate", "args": bad_finish, "tool_call_id": "bad-finish"},
    next_call=lambda value: collaboration_handler(value, task_id="fixture-task", session_id="fixture-session"))
assert "summary or resultRefs" in invalid_finish and "PRIVATE_SUMMARY" not in invalid_finish
assert len(collaboration_calls) == before_finish
bad_reference = {"groupToken": "fixture-group-token", "action": "finish", "clientActionId": "bad-reference", "resultRefs": [
    {"itemId": "item", "revision": True, "messageId": "message", "seq": 1, "digest": "a" * 64}]}
invalid_reference = collaborator.middleware(**{**context, "tool_name": "group_collaborate", "args": bad_reference, "tool_call_id": "bad-reference"},
    next_call=lambda value: collaboration_handler(value, task_id="fixture-task", session_id="fixture-session"))
assert "resultRefs[0].revision" in invalid_reference
assert len(collaboration_calls) == before_finish
fixed_finish = {"groupToken": "fixture-group-token", "action": "finish", "clientActionId": "fixed-finish", "resultRefs": [
    {"itemId": "item", "revision": 1, "messageId": "message", "seq": 1, "digest": "a" * 64}]}
collaborator.middleware(**{**context, "tool_name": "group_collaborate", "args": fixed_finish, "tool_call_id": "fixed-finish"},
    next_call=lambda value: collaboration_handler(value, task_id="fixture-task", session_id="fixture-session"))
assert collaboration_calls[-1][1]["arguments"] == fixed_finish
print('plugin-hermes-group-discovery-unit: specialized registration, safe missing fields and finish forms ok')
assert collaboration_calls[0][1]["callId"] == "fixture-call"
print("plugin-hermes-group-collaboration: trusted forwarding ok")
