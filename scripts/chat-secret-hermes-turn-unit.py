"""Exercise the real managed turn permits across adjacent native turns."""
import contextvars
import importlib.util
from pathlib import Path
import threading
import types
import unittest

source = Path(__file__).resolve().parents[1] / "resources/external-plugin-host-patches/hermes/managed-v4/patched/shoggoth_managed_runtime.py"
spec = importlib.util.spec_from_file_location("managed_turn_fixture", source)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class TurnPermits(unittest.TestCase):
    def test_released_old_turn_cannot_remove_or_use_new_turn(self):
        state = types.SimpleNamespace(generation="fixture", active={}, lock=threading.RLock(),
                                      validate_fence=lambda: None, verify_imports=lambda: None)
        state.valid_permit = lambda: isinstance(runtime._CURRENT_PERMIT.get(), runtime._Permit)
        runtime._STATE = state
        agent = types.SimpleNamespace(session_id="stored", _current_task_id="task", _current_turn_id="turn")
        session = {"agent": agent}
        old, new = contextvars.Context(), contextvars.Context()
        for ctx in (old, new):
            ctx.run(runtime._CURRENT_PERMIT.set, runtime._Permit(state))
        first = old.run(runtime.turn_scope, "native", session)
        second = new.run(runtime.turn_scope, "native", session)
        old.run(first.__enter__)
        with self.assertRaises(runtime.ManagedRuntimeError):
            old.run(runtime.release_model_turn, {"agent": agent})
        old.run(runtime.release_model_turn, session)
        new.run(second.__enter__)
        row = state.active[id(agent)]
        with self.assertRaises(runtime.ManagedRuntimeError):
            old.run(runtime.model_projection_owner)
        old.run(first.__exit__, None, None, None)
        self.assertIs(state.active[id(agent)], row)
        self.assertEqual(new.run(runtime.model_projection_owner)["session_id"], "stored")
        new.run(second.__exit__, None, None, None)
        self.assertEqual(state.active, {})
        runtime._STATE = None


if __name__ == "__main__":
    unittest.main()
