"""Real Hermes middleware with synthetic content and loopback transports only."""
import importlib.util
import json
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import urllib.request

root = Path(__file__).resolve().parents[2]
host = Path(os.environ.get("SHOGGOTH_HERMES_TEST_SOURCE", str(Path.home() / ".hermes/hermes-agent")))
sys.path.insert(0, str(host))
from hermes_cli import middleware

adapter_root = root / "resources/external-plugin-adapters/hermes"
spec = importlib.util.spec_from_file_location("shoggoth_secret_test", adapter_root / "__init__.py", submodule_search_locations=[str(adapter_root)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
endpoint = sys.argv[1]

def post(route, body):
    call = urllib.request.Request(endpoint + route, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(call, timeout=15) as response:
        return json.loads(response.read())

adapter = module.Adapter("default", credential=lambda: "synthetic-local-pairing", instance_id="fixture-instance",
                         request=lambda method, params, **_kwargs: post("/service", {"method": method, "params": params}))
manager = SimpleNamespace(_middleware={"llm_execution": [adapter.model_middleware]},
                          _report_hook_failure=lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("projection must never fall through")))
plugins = ModuleType("hermes_cli.plugins")
plugins._delivery_manager = lambda: manager
sys.modules["hermes_cli.plugins"] = plugins
context = {"session_id": "session-a", "task_id": "task-a", "turn_id": "turn-a", "api_request_id": "api-a"}
request = {"model": "local-fixture", "messages": [{"role": "user", "content": "password: 123456\nPublic receipt"}], "temperature": 0}
result = middleware.run_llm_execution_middleware(request, lambda safe: post("/model", safe), **context)
assert result == {"ok": True}
assert "123456" in request["messages"][0]["content"], "projection must not rewrite native execution history"
post("/revoke", {})
try:
    middleware.run_llm_execution_middleware(request, lambda safe: post("/model", safe), **context)
except RuntimeError as error:
    assert str(error) == "SECRET_MODEL_PROJECTION_UNAVAILABLE"
else:
    raise AssertionError("revoked projection reached provider")
print(json.dumps({"pass": True, "actualHermesMiddleware": str(Path(middleware.__file__).name), "providerCalls": 1, "failureProviderCalls": 0}))
