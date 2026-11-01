"""Controlled Host using the actual Hermes adapter and its private-socket transport.

Only the Host execution context and the disposable Service root are injected.
No authorization function, Service controller, approval, or MCP client is mocked.
"""
import importlib.util
import json
from pathlib import Path
import sys
import types

config = json.loads(sys.stdin.readline())
folder = Path(__file__).resolve().parents[2] / "resources/external-plugin-adapters/hermes"
spec = importlib.util.spec_from_file_location("mcp_host_lane", folder / "__init__.py", submodule_search_locations=[str(folder)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
transport = sys.modules[spec.name + ".transport"]
# The real App supplies a protected managed descriptor. This controlled Host
# supplies only its already validated fixture paths, retaining transport _safe,
# credential-file checks, protocol framing and real Service pairing validation.
roots = {"shoggoth-core": Path(config["stateDir"]), "run": Path(config["runtimeDir"])}
transport._private_child_root = lambda name: roots[name]
adapter = module.Adapter(config["profile"], instance_id="hermes-p5-host")
handlers = {}
middleware = {}
adapter.register(types.SimpleNamespace(
    register_tool=lambda **entry: handlers.__setitem__(entry["name"], entry["handler"]),
    register_middleware=lambda name, handler: middleware.__setitem__(name, handler),
    register_hook=lambda *_args: None,
))
assert len(handlers) == 29 and set(middleware) == {"tool_execution", "llm_execution"}
assert "apple_calendar_create" in handlers and "apple_reminders_update" in handlers
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    if command.get("close"):
        break
    name = command["name"]
    identity = {"session_id": config["sessionId"], "task_id": "task-" + command["turn"],
                "turn_id": command["turn"], "tool_call_id": command["id"]}
    result = middleware["tool_execution"](tool_name=name, args=command["arguments"], **identity,
        next_call=lambda args: handlers[name](args, session_id=identity["session_id"], task_id=identity["task_id"]))
    print(json.dumps({"id": command["id"], "result": json.loads(result)}), flush=True)
