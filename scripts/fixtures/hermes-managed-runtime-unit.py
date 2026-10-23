"""Unit negatives for the private managed gate; actual closure is the Node real fixture."""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
import types
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "resources/external-plugin-host-patches/hermes/managed-v1/patched/shoggoth_managed_runtime.py"
spec = importlib.util.spec_from_file_location("sgh_managed_unit", SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ManagedGateTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="sgh-hermes-managed-unit-", dir="/private/tmp"))
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.descriptor = {"version": 1, "backend_id": "hermes", "runtime_root": str(self.root),
            "runtime_tree_sha256": "a"*64, "data_root": str(self.home), "nonce": "b"*64,
            "control_token": "c"*64, "required_adapter_id": "shoggoth_shared_capabilities", "adapter_tree_sha256": "d"*64}
        self.state = m._ManagedState(self.descriptor)
        self.state.verify_imports = lambda: None  # Closure is separately verified on the genuine candidate.
        self.fence = self.home / "shoggoth-managed-writer.fence"
        self.fence.write_text(json.dumps({"version": 1, "data_root": str(self.home), "runtime_root": str(self.root), "nonce": "b"*64}))
        self.fence.chmod(0o600)
        self.state.fence_fd = os.open(self.fence, os.O_RDONLY)
        m._STATE = self.state

    def tearDown(self):
        m._CURRENT_PERMIT.set(None)
        m._STATE = None
        os.close(self.state.fence_fd)
        for directory, dirs, files in os.walk(self.root):
            os.chmod(directory, 0o700)
            for file in files:
                p = Path(directory) / file
                if not p.is_symlink():
                    p.chmod(0o600)
        shutil.rmtree(self.root)

    def test_disabled_normal_chat_unchanged(self):
        m._STATE = None
        self.assertTrue(m.admission_allowed())
        self.assertIsNone(m.capture_permit())
        m.assert_model_agent(object())
        with m.rpc_scope("prompt.submit"), m.turn_scope("unused", {}):
            self.assertTrue(m.admission_allowed())

    def test_paused_new_admission_refused(self):
        self.assertFalse(m.admission_allowed())
        with self.assertRaisesRegex(m.ManagedRuntimeError, "MANAGED_ADMISSION_PAUSED"):
            with m.rpc_scope("prompt.submit"):
                self.fail("paused request ran")

    def test_dict_permit_cannot_forge_admission(self):
        token = m._CURRENT_PERMIT.set({"generation": self.state.generation, "state": self.state})
        try:
            self.assertFalse(m.admission_allowed())
        finally:
            m._CURRENT_PERMIT.reset(token)

    def test_real_opaque_permit_preserves_preaccepted_queue(self):
        self.state.paused = False
        with m.rpc_scope("prompt.submit"):
            queued = {"shoggoth_managed_permit": m.capture_permit()}
        self.state.paused = True
        with m.queue_scope(queued):
            self.assertTrue(m.admission_allowed())
        self.assertFalse(m.admission_allowed())

    def test_old_generation_queue_refused(self):
        permit = m._Permit(self.state)
        self.state.generation = "different"
        with self.assertRaisesRegex(m.ManagedRuntimeError, "MANAGED_QUEUED_OWNER_UNAVAILABLE"):
            with m.queue_scope({"shoggoth_managed_permit": permit}):
                self.fail("stale queue ran")

    def test_missing_queue_owner_refused(self):
        with self.assertRaisesRegex(m.ManagedRuntimeError, "MANAGED_QUEUED_OWNER_UNAVAILABLE"):
            with m.queue_scope({"text": "caller text"}):
                self.fail("unowned queue ran")

    def test_model_outside_actual_turn_refused(self):
        with self.assertRaisesRegex(m.ManagedRuntimeError, "MANAGED_MODEL_OWNER_UNAVAILABLE"):
            m.authorize_model(object(), "task", "turn")

    def test_exact_model_task_turn_immutable(self):
        agent = type("Agent", (), {"session_id": "physical"})()
        session = {"agent": agent, "_shoggoth_managed_pending_permit": m._Permit(self.state)}
        with m.turn_scope("actual-ui", session):
            m.authorize_model(agent, "actual-task", "actual-turn")
            m.authorize_model(agent, "actual-task", "actual-turn")
            with self.assertRaisesRegex(m.ManagedRuntimeError, "MANAGED_MODEL_IDENTITY_CHANGED"):
                m.authorize_model(agent, "neighbor-task", "actual-turn")
        self.assertFalse(self.state.active)

    def test_duplicate_actual_agent_turn_refused(self):
        agent = object()
        session = {"agent": agent, "_shoggoth_managed_pending_permit": m._Permit(self.state)}
        with m.turn_scope("ui", session):
            with self.assertRaisesRegex(m.ManagedRuntimeError, "MANAGED_TURN_OWNER_UNAVAILABLE"):
                with m.turn_scope("neighbor", session):
                    self.fail("duplicate agent started")

    def test_delayed_thread_receives_admitted_permit(self):
        self.state.paused = False
        with m.rpc_scope("prompt.submit"):
            run = m.contextual(lambda: m.admission_allowed())
        self.state.paused = True
        self.assertTrue(run())
        self.assertFalse(m.admission_allowed())

    def test_writer_fence_replacement_refused(self):
        self.fence.unlink()
        self.fence.write_text("{}")
        self.fence.chmod(0o600)
        with self.assertRaisesRegex(m.ManagedRuntimeError, "MANAGED_WRITER_FENCE_CHANGED"):
            m.admission_allowed()

    def test_private_control_symlink_refused(self):
        target = self.home / "control"
        target.symlink_to(self.fence)
        with self.assertRaisesRegex(m.ManagedRuntimeError, "MANAGED_CONTROL_UNSAFE"):
            m._private_json(target)

    def test_wrong_token_deadline_and_generation_fail_closed(self):
        base = {"version": 1, "control_token": "c"*64, "nonce": "b"*64,
            "operation_id": "unit-proof", "deadline_at": 9999999999999, "generation": self.state.generation}
        for extra in ({"control_token": "e"*64}, {"deadline_at": 0}, {"generation": "neighbor"}, {"version": True}):
            r = m.control_rpc({"jsonrpc": "2.0", "id": "test", "method": "runtime.managed.resume", "params": {**base, **extra}})
            self.assertIn("error", r)
            self.assertTrue(self.state.paused)

    def test_authenticated_resume_failed_proof_stays_paused(self):
        base = {"version": 1, "control_token": "c"*64, "nonce": "b"*64,
            "operation_id": "unit-proof", "deadline_at": 9999999999999, "generation": self.state.generation}
        retirement = types.SimpleNamespace(_lock=__import__("threading").Lock(), _active=0)
        module = types.ModuleType("hermes_cli.backend_retirement")
        module.retirement = retirement
        with patch.dict(__import__("sys").modules, {"hermes_cli.backend_retirement": module}):
            for proof in ({"selection_supported": False, "snapshot": {"complete": True, "idle": True}},
                          {"selection_supported": True, "snapshot": {"complete": False, "idle": False}}):
                self.state.proof = lambda: proof
                result = m.control_rpc({"id": "unit", "method": "runtime.managed.resume", "params": base})
                self.assertEqual(result["error"]["message"], "MANAGED_RESUME_NOT_READY")
                self.assertTrue(self.state.paused)
            calls = [0]
            def failed_after_open():
                calls[0] += 1
                if calls[0] == 1:
                    return {"selection_supported": True, "snapshot": {"complete": True, "idle": True}}
                raise m.ManagedRuntimeError("MANAGED_IMPORT_ESCAPE")
            self.state.proof = failed_after_open
            result = m.control_rpc({"id": "unit", "method": "runtime.managed.resume", "params": base})
            self.assertEqual(result["error"]["message"], "MANAGED_IMPORT_ESCAPE")
            self.assertTrue(self.state.paused)

    def test_same_private_bootstrap_is_idempotent(self):
        control = self.home / "managed-control.json"
        control.write_text(json.dumps(self.descriptor))
        control.chmod(0o600)
        with patch.dict(os.environ, {"SHOGGOTH_HERMES_MANAGED_CONTROL_FILE": str(control)}):
            m.bootstrap()
            self.assertIs(m._STATE, self.state)
            control.write_text(json.dumps({**self.descriptor, "nonce": "f"*64}))
            with self.assertRaisesRegex(m.ManagedRuntimeError, "MANAGED_BOOTSTRAP_CHANGED"):
                m.bootstrap()

    def test_immutable_tree_digest_matches_canonical_rows(self):
        tree = self.root / "runtime"
        tree.mkdir(mode=0o700)
        file = tree / "code.py"
        file.write_bytes(b"print(1)\n")
        file.chmod(0o400)
        tree.chmod(0o500)
        rows = [{"path": "code.py", "kind": "file", "executable": False, "size": 9, "sha256": hashlib.sha256(b"print(1)\n").hexdigest()}]
        expected = hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()
        self.assertEqual(m._tree_digest(tree), expected)
        file.chmod(0o600)
        with self.assertRaisesRegex(m.ManagedRuntimeError, "MANAGED_RUNTIME_MUTABLE"):
            m._tree_digest(tree)


if __name__ == "__main__":
    unittest.main()
