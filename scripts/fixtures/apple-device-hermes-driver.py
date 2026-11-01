"""Actual Hermes middleware/adapter/private socket against an isolated Service."""
import importlib.util
import json
from pathlib import Path
import sys
import types

config = json.loads(sys.stdin.readline())
folder = Path(__file__).resolve().parents[2] / "resources/external-plugin-adapters/hermes"
spec = importlib.util.spec_from_file_location("apple_device_host_lane", folder / "__init__.py", submodule_search_locations=[str(folder)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
transport = sys.modules[spec.name + ".transport"]
roots = {"shoggoth-core": Path(config["stateDir"]), "run": Path(config["runtimeDir"])}
transport._private_child_root = lambda name: roots[name]
adapter = module.Adapter("device-fixture", instance_id="hermes-device-fixture-host")
handlers = {}
middleware = {}
adapter.register(types.SimpleNamespace(
    register_tool=lambda **entry: handlers.__setitem__(entry["name"], entry["handler"]),
    register_middleware=lambda name, handler: middleware.__setitem__(name, handler),
    register_hook=lambda *_args: None,
))
device_names = [name for name in handlers if name.startswith("apple_")]
assert len(device_names) == 12 and not any("contact" in name for name in device_names)
assert set(middleware) == {"tool_execution", "llm_execution"}
print(json.dumps({"ready": True, "deviceTools": device_names}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    if command.get("close"):
        break
    name = command["name"]
    identity = {"session_id": "hermes-device-fixture-session", "task_id": "task-" + command["turn"],
                "turn_id": command["turn"], "tool_call_id": command.get("callId", command["id"])}
    result = middleware["tool_execution"](tool_name=name, args=command["arguments"], **identity,
        next_call=lambda args: handlers[name](args, session_id=identity["session_id"], task_id=identity["task_id"]))
    print(json.dumps({"id": command["id"], "result": json.loads(result)}), flush=True)
