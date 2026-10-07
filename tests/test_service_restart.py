import importlib.util
import os
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


class ServiceRestartTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        spec = importlib.util.spec_from_file_location(
            "webchat_restart_tests", Path(__file__).resolve().parents[1] / "app.py"
        )
        cls.backend = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"HOME": cls.home.name}):
            spec.loader.exec_module(cls.backend)

    @classmethod
    def tearDownClass(cls):
        cls.home.cleanup()

    def setUp(self):
        self.backend.service_restarting = False
        self.client = self.backend.app.test_client()
        with self.client.session_transaction() as browser:
            browser["authenticated"] = True
        with self.backend.app.app_context():
            db = self.backend.get_db()
            db.execute("DELETE FROM chat_jobs")
            db.commit()

    def properties(self, pid=None, policy="on-failure"):
        return subprocess.CompletedProcess([], 0,
            f"MainPID={os.getpid() if pid is None else pid}\nRestart={policy}\n", "")

    def test_restart_requires_login(self):
        anonymous = self.backend.app.test_client()
        self.assertEqual(anonymous.get("/api/service").status_code, 401)
        self.assertEqual(anonymous.post("/api/service/restart").status_code, 401)

    def test_supervised_restart_is_delayed_and_reports_instance(self):
        before = self.client.get("/api/service").json
        with patch.object(self.backend.subprocess, "run", return_value=self.properties()) as run, \
                patch.object(self.backend.threading, "Timer") as timer:
            result = self.client.post("/api/service/restart")
            self.assertEqual(result.status_code, 202)
            self.assertEqual(result.json["instance_id"], before["instance_id"])
            timer.assert_called_once_with(1.5, self.backend.os._exit, args=(1,))
            timer.return_value.start.assert_called_once()
            self.assertEqual(run.call_args.args[0][0], "/usr/bin/systemctl")
        self.assertTrue(self.client.get("/api/service").json["restarting"])
        self.assertEqual(self.client.post("/api/service/restart").status_code, 409)
        self.assertEqual(self.client.post("/api/chat", data={"message": "ciao"}).status_code, 503)
        with self.backend.app.app_context():
            result = self.backend.start_chat_job({}, str(uuid.uuid4()), lambda: [])
            self.assertEqual(result[1], 503)

    def test_manual_process_or_wrong_restart_policy_does_not_exit(self):
        for properties in (self.properties(pid=0), self.properties(policy="no")):
            with patch.object(self.backend.subprocess, "run", return_value=properties), \
                    patch.object(self.backend.threading, "Timer") as timer:
                result = self.client.post("/api/service/restart")
            self.assertEqual(result.status_code, 503)
            self.assertIn("error", result.json)
            timer.assert_not_called()
            self.assertFalse(self.backend.service_restarting)

    def test_running_job_blocks_restart(self):
        with self.backend.app.app_context():
            db = self.backend.get_db()
            db.execute("INSERT INTO chat_jobs (id, chat_id, status, owner_pid) "
                       "VALUES (?, ?, 'running', ?)",
                       (str(uuid.uuid4()), str(uuid.uuid4()), os.getpid()))
            db.commit()
        with patch.object(self.backend.threading, "Timer") as timer:
            self.assertEqual(self.client.post("/api/service/restart").status_code, 409)
        timer.assert_not_called()

    def test_native_cli_session_blocks_restart(self):
        folder = self.backend.SESSION_STATE_DIR / str(uuid.uuid4())
        folder.mkdir(parents=True)
        marker = folder / f"inuse.{os.getpid()}.lock"
        marker.touch()
        try:
            with patch.object(self.backend.threading, "Timer") as timer:
                self.assertEqual(self.client.post("/api/service/restart").status_code, 409)
            timer.assert_not_called()
        finally:
            marker.unlink()

    def test_systemctl_and_timer_failures_are_explicit(self):
        with patch.object(self.backend.subprocess, "run", side_effect=OSError("failure")):
            self.assertEqual(self.client.post("/api/service/restart").status_code, 503)
        with patch.object(self.backend.subprocess, "run", return_value=self.properties()), \
                patch.object(self.backend.threading, "Timer") as timer:
            timer.return_value.start.side_effect = RuntimeError("failure")
            self.assertEqual(self.client.post("/api/service/restart").status_code, 500)
        self.assertFalse(self.backend.service_restarting)


if __name__ == "__main__":
    unittest.main()
