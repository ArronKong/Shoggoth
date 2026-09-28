"""Exercise the production Hermes adapter against one isolated Shoggoth Service.

Only the canonical root lookup is replaced, so the real private-socket transport,
credential read, middleware and handler run without touching the user's Service.
"""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys


def main() -> None:
    root = Path(__file__).resolve().parents[1] / "resources/external-plugin-adapters/hermes"
    spec = importlib.util.spec_from_file_location(
        "shoggoth_three_host_hermes", root / "__init__.py",
        submodule_search_locations=[str(root)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Hermes adapter unavailable")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    transport = sys.modules[f"{spec.name}.transport"]
    transport._root = lambda: Path(os.environ["SHOGGOTH_THREE_HOST_SERVICE_ROOT"])

    request = json.load(sys.stdin)
    adapter = module.Adapter("default", instance_id="hermes-three-host-fixture")
    answers = []
    for index, command in enumerate(request["commands"]):
        name = command["name"]
        args = command["args"]
        handler = adapter.handler(name)
        result = adapter.middleware(
            tool_name=name,
            args=args,
            session_id="hermes-three-host-session",
            task_id="hermes-three-host-task",
            turn_id=f"hermes-three-host-turn-{index}",
            tool_call_id=f"hermes-three-host-call-{index}",
            next_call=lambda value: handler(
                value,
                session_id="hermes-three-host-session",
                task_id="hermes-three-host-task",
            ),
        )
        answers.append(json.loads(result))
    print(json.dumps(answers))


if __name__ == "__main__":
    main()
