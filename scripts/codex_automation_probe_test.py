import importlib.util
from pathlib import Path
import tempfile
import sqlite3
import unittest

spec = importlib.util.spec_from_file_location("probe", Path(__file__).with_name("codex_automation_probe.py"))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
OWNER = {"profileId": "generated-codex", "agentId": "codex", "runtimeAccountId": "native-codex"}
TEXT = '''version = 1
id = "sample"
kind = "cron"
name = "每日简报"
prompt = "只生成测试文本"
status = "PAUSED"
rrule = "RRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=0"
model = "fixture-model"
target = { type = "projectless" }
cwds = ["~"]
future_field = { keep = true }
created_at = 1
updated_at = 2
'''


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.path = self.home / "automations/sample/automation.toml"
        self.path.parent.mkdir(parents=True)
        self.path.write_text(TEXT)
        self.path.chmod(0o600)

    def tearDown(self):
        self.tmp.cleanup()

    def test_owner_rename_does_not_move_tasks_to_clone(self):
        rows = probe.discover(self.home, OWNER)["items"]
        renamed = {"id": OWNER["profileId"], "name": "我的助理", "bindings": [
            {"runtime": "codex", "runtimeAccountId": OWNER["runtimeAccountId"]}]}
        clone = {**renamed, "id": "new-agent", "name": "Codex"}
        self.assertEqual(len(probe.for_profile(rows, renamed, OWNER)), 1)
        self.assertEqual(probe.for_profile(rows, clone, OWNER), [])

    def test_managed_harness_is_not_the_native_account(self):
        profile = {"id": OWNER["profileId"], "bindings": [
            {"runtime": "codex", "runtimeAccountId": "managed-harness"}]}
        self.assertEqual(probe.for_profile([{}], profile, OWNER), [])

    def test_rename_preserves_status_schedule_unknown_fields_and_permissions(self):
        before = probe.read_automation(self.home, "sample")
        result = probe.rename_legacy(self.home, "sample", before[3], "每天简报")
        after = probe.read_automation(self.home, "sample")
        self.assertEqual(result["changedFields"], ["name", "updated_at"])
        self.assertEqual(after[2]["status"], "PAUSED")
        self.assertEqual(after[2]["future_field"], before[2]["future_field"])
        self.assertEqual(after[2]["rrule"], before[2]["rrule"])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_stale_edit_keeps_external_writer_change(self):
        old = probe.read_automation(self.home, "sample")[3]
        self.path.write_text(TEXT.replace("只生成测试文本", "用户刚编辑的提示词"))
        changed = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "changed"):
            probe.rename_legacy(self.home, "sample", old, "每天简报")
        self.assertEqual(self.path.read_bytes(), changed)

    def test_path_traversal_and_symlink_are_rejected(self):
        with self.assertRaises(ValueError):
            probe.read_automation(self.home, "../sample")
        linked = self.home / "automations/linked"
        linked.symlink_to(self.path.parent, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            probe.read_automation(self.home, "linked")

    def test_wrong_id_is_reported_as_unavailable(self):
        self.path.write_text(TEXT.replace('id = "sample"', 'id = "other"'))
        result = probe.discover(self.home, OWNER)
        self.assertEqual(result["items"], [])
        self.assertEqual(result["unavailable"][0]["id"], "sample")

    def test_noncanonical_layout_is_not_rewritten(self):
        self.path.write_text("# externally formatted\n" + TEXT)
        before = probe.read_automation(self.home, "sample")
        with self.assertRaisesRegex(ValueError, "layout"):
            probe.rename_legacy(self.home, "sample", before[3], "每天简报")
        self.assertEqual(self.path.read_bytes(), before[1])

    def test_multiline_prompt_and_duplicate_name_text_are_preserved(self):
        body = TEXT.replace('prompt = "只生成测试文本"', 'prompt = """第一行\nname = \\"诱导行\\"\nupdated_at = 9\n最后一行"""')
        self.path.write_text(body)
        before = probe.read_automation(self.home, "sample")
        probe.rename_legacy(self.home, "sample", before[3], "每天简报")
        after = probe.read_automation(self.home, "sample")
        self.assertEqual(after[2]["prompt"], before[2]["prompt"])

    def test_existing_heartbeat_is_distinguished_from_standalone_cron(self):
        self.path.write_text(TEXT.replace('kind = "cron"', 'kind = "heartbeat"'))
        self.assertEqual(probe.discover(self.home, OWNER)["items"][0]["kind"], "heartbeat")

    def test_client_account_owned_or_deleted_task_is_not_edited(self):
        directory = self.home / "sqlite"
        directory.mkdir()
        with sqlite3.connect(directory / "codex-dev.db") as db:
            db.execute("CREATE TABLE automations (id TEXT, account_id TEXT, user_id TEXT, installation_id TEXT, status TEXT)")
            db.execute("INSERT INTO automations VALUES ('sample', 'account', NULL, NULL, 'PAUSED')")
        before = probe.read_automation(self.home, "sample")
        with self.assertRaisesRegex(ValueError, "account-owned"):
            probe.rename_legacy(self.home, "sample", before[3], "每天简报")
        with sqlite3.connect(directory / "codex-dev.db") as db:
            db.execute("UPDATE automations SET account_id=NULL, status='DELETED'")
        with self.assertRaisesRegex(ValueError, "deleted"):
            probe.rename_legacy(self.home, "sample", before[3], "每天简报")
        self.assertEqual(self.path.read_bytes(), before[1])

    def test_review_status_is_not_misreported_as_execution_success(self):
        directory = self.home / "sqlite"
        directory.mkdir()
        with sqlite3.connect(directory / "codex-dev.db") as db:
            db.execute("CREATE TABLE automations (id TEXT, account_id TEXT, user_id TEXT, installation_id TEXT, status TEXT)")
            db.execute("INSERT INTO automations VALUES ('sample', NULL, NULL, NULL, 'PAUSED')")
            db.execute("CREATE TABLE automation_runs (thread_id TEXT, automation_id TEXT, status TEXT, created_at INTEGER, updated_at INTEGER, inbox_summary TEXT, archived_assistant_message TEXT)")
            db.execute("INSERT INTO automation_runs VALUES ('thread', 'sample', 'PENDING_REVIEW', 1, 2, '私有结果摘要', NULL)")
        result = probe.native_run_metadata(self.home, "sample")
        self.assertTrue(result["available"])
        self.assertEqual(result["items"][0]["presentationStatus"], "PENDING_REVIEW")
        self.assertEqual(result["items"][0]["completionStatus"], "unknown")
        self.assertTrue(result["items"][0]["hasSummary"])
        self.assertNotIn("私有结果摘要", str(result))

    def test_missing_result_source_is_unavailable_not_an_empty_success(self):
        result = probe.native_run_metadata(self.home, "sample")
        self.assertFalse(result["available"])
        self.assertEqual(result["reason"], "client database unavailable")


if __name__ == "__main__":
    unittest.main(verbosity=2)
