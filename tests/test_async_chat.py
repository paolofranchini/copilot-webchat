import importlib.util
import io
import json
import os
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


class AsyncChatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        spec = importlib.util.spec_from_file_location(
            "async_webchat", Path(__file__).resolve().parents[1] / "app.py"
        )
        cls.backend = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"HOME": cls.home.name}):
            spec.loader.exec_module(cls.backend)
        cls.backend.app.config["TESTING"] = True
        cls.cli = Path(cls.home.name) / "fake-copilot"
        cls.cli.write_text(
            "#!/usr/bin/env python3\n"
            "import json, sys, time\n"
            "from pathlib import Path\n"
            "args = sys.argv[1:]\n"
            "key = '--session-id' if '--session-id' in args else '--resume'\n"
            "folder = Path(__file__).parent / '.copilot' / 'session-state' / args[args.index(key)+1]\n"
            "folder.mkdir(parents=True, exist_ok=True)\n"
            "with (folder / 'events.jsonl').open('a') as f:\n"
            " f.write(json.dumps({'type':'user.message','data':{'content':args[args.index('-p')+1]}})+'\\n')\n"
            "print(json.dumps({'type':'tool.execution_start','data':{'name':'read'}}), flush=True)\n"
            "print(json.dumps({'type':'assistant.message.delta','data':{'content':'Parziale'}}), flush=True)\n"
            "time.sleep(0.4)\n"
            "reply = 'Piano' if '--plan' in args else 'Risposta'\n"
            "event = {'type':'assistant.message','data':{'content':reply,'model':'gpt-test'}}\n"
            "with (folder / 'events.jsonl').open('a') as f:\n"
            " f.write(json.dumps(event)+'\\n')\n"
            "Path(args[args.index('--usage-output-file')+1]).write_text(json.dumps({'totalNanoAiu':1000000000}))\n"
            "print(json.dumps(event), flush=True)\n"
        )
        cls.cli.chmod(0o700)
        cls.backend.COPILOT_BIN = str(cls.cli)

    @classmethod
    def tearDownClass(cls):
        cls.home.cleanup()

    def setUp(self):
        self.client = self.backend.app.test_client()
        with self.client.session_transaction() as browser:
            browser["authenticated"] = True

    def start(self, **extra):
        job_id = str(uuid.uuid4())
        data = {"message": "ciao", "async": "true", "request_id": job_id, **extra}
        response = self.client.post("/api/chat/stream", data=data)
        self.assertEqual(response.status_code, 202)
        self.assertEqual(response.json["job_id"], job_id)
        return job_id, response.json["chat_id"]

    def wait(self, job_id, client=None):
        client = client or self.client
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            response = client.get(f"/api/chat/jobs/{job_id}")
            self.assertEqual(response.status_code, 200)
            if response.json["status"] != "running":
                return response.json
            time.sleep(0.02)
        self.fail("Il lavoro non e' terminato")

    def test_stream_job_survives_closed_response_and_browser_change(self):
        job_id, chat_id = self.start(files=(io.BytesIO(b"contenuto"), "test.txt"))
        other = self.backend.app.test_client()
        with other.session_transaction() as browser:
            browser["authenticated"] = True
        result = self.wait(job_id, other)
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["result"]["reply"], "Risposta")
        self.assertTrue(result["result"]["auto_model"])
        self.assertEqual(result["result"]["usage"], {"ai_credits": 1})
        with self.backend.app.app_context():
            marked = self.backend.get_db().execute(
                "SELECT count(*) FROM auto_model_responses WHERE chat_id = ?",
                (chat_id,),
            ).fetchone()[0]
        self.assertEqual(marked, 1)
        self.assertEqual([m["role"] for m in other.get(f"/api/chats/{chat_id}").json],
                         ["user", "bot"])
        self.assertFalse(list(self.backend.UPLOAD_DIR.glob("*")))
        self.assertEqual(other.get(f"/api/chat/jobs/{job_id}").json, result)

    def test_idempotent_submission_and_busy_chat(self):
        entered = threading.Event()
        release = threading.Event()

        def run(*args):
            entered.set()
            release.wait(5)
            return "ok", "gpt-test", None

        def fake_stream(*args, **kwargs):
            run()
            yield self.backend.sse({
                "type": "done", "reply": "ok", "model": "gpt-test",
                "chat_id": args[2], "usage": None,
            })

        with patch.object(self.backend, "run_copilot_stream", side_effect=fake_stream) as invocation:
            job_id, chat_id = self.start()
            self.assertTrue(entered.wait(2))
            try:
                duplicate = self.client.post("/api/chat/stream", data={
                    "async": "true", "request_id": job_id, "message": "ciao"
                })
                self.assertEqual(duplicate.status_code, 202)
                self.assertEqual(duplicate.json["chat_id"], chat_id)
                self.assertEqual(self.client.post("/api/chat/stream", data={
                    "async": "true", "request_id": str(uuid.uuid4()),
                    "chat_id": chat_id, "message": "secondo",
                }).status_code, 409)
                self.assertEqual(self.client.delete(f"/api/chats/{chat_id}").status_code, 409)
                self.assertEqual(invocation.call_count, 1)
            finally:
                release.set()
                self.wait(job_id)

    def test_distinct_chats_can_run_concurrently_and_are_marked_running(self):
        first_id, first_chat = self.start()
        second_chat_id = str(uuid.uuid4())
        second_id, returned_chat = self.start(chat_id=second_chat_id)
        self.assertNotEqual(first_chat, returned_chat)

        running = {}
        running_job_ids = {}
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            chats = self.client.get("/api/chats").json
            running = {chat["id"]: chat["running"] for chat in chats}
            running_job_ids = {chat["id"]: chat["job_id"] for chat in chats}
            if running.get(first_chat) and running.get(second_chat_id):
                break
            time.sleep(0.02)
        self.assertTrue(running.get(first_chat))
        self.assertTrue(running.get(second_chat_id))
        self.assertEqual(running_job_ids[first_chat], first_id)
        self.assertEqual(running_job_ids[second_chat_id], second_id)

        self.assertEqual(self.wait(first_id)["status"], "done")
        self.assertEqual(self.wait(second_id)["status"], "done")

    def test_first_message_persists_agent_permissions(self):
        job_id, chat_id = self.start(permissions=json.dumps(["all"]))
        self.assertEqual(self.wait(job_id)["status"], "done")
        with self.backend.app.app_context():
            row = self.backend.get_db().execute(
                "SELECT permissions FROM chats WHERE id = ?", (chat_id,)
            ).fetchone()
        self.assertEqual(json.loads(row["permissions"]), ["all"])

    def test_stream_progress_plan_and_async_approval_without_mode_flag(self):
        job_id, chat_id = self.start(stream=True, plan="true")
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            job = self.client.get(f"/api/chat/jobs/{job_id}").json
            if job["progress"].get("content"):
                break
            time.sleep(0.01)
        self.assertEqual(job["status"], "running")
        self.assertEqual(job["progress"]["content"], "Parziale")
        self.assertEqual(job["progress"]["tools"][0]["data"]["name"], "read")
        self.assertTrue(self.wait(job_id)["result"]["pending_plan"])
        approval_id = str(uuid.uuid4())
        approved = self.client.post("/api/chat/plan/approve", json={
            "async": True, "request_id": approval_id, "chat_id": chat_id
        })
        self.assertEqual(approved.status_code, 202)
        self.assertEqual(self.wait(approval_id)["result"]["reply"], "Risposta")
        with self.backend.app.app_context():
            row = self.backend.get_db().execute(
                "SELECT pending_plan FROM chats WHERE id = ?", (chat_id,)
            ).fetchone()
            self.assertIsNone(row["pending_plan"])
        self.assertEqual(self.client.delete(f"/api/chats/{chat_id}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/chat/jobs/{job_id}").status_code, 404)

    def test_stream_error_is_persisted_and_releases_chat(self):
        def error_stream(*args, **kwargs):
            yield self.backend.sse({
                "type": "error", "chat_id": args[2],
                "error": "timeout: risposta troppo lenta",
            })

        with patch.object(self.backend, "run_copilot_stream", side_effect=error_stream):
            job_id, chat_id = self.start()
            result = self.wait(job_id)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["result"]["error"], "timeout: risposta troppo lenta")
        with self.backend.app.app_context():
            self.assertIsNone(self.backend.running_chat_job(chat_id))

    def test_auth_validation_and_restart_detection(self):
        self.assertEqual(self.backend.app.test_client().get(
            f"/api/chat/jobs/{uuid.uuid4()}").status_code, 401)
        self.assertEqual(self.client.post("/api/chat/stream", data={
            "async": "true", "message": "ciao", "request_id": "invalid"
        }).status_code, 400)
        job_id, chat_id = str(uuid.uuid4()), str(uuid.uuid4())
        with self.backend.app.app_context():
            db = self.backend.get_db()
            db.execute("INSERT INTO chat_jobs (id, chat_id, status, owner_pid) "
                       "VALUES (?, ?, 'running', ?)", (job_id, chat_id, os.getpid()))
            db.commit()
        with patch.object(self.backend.os, "kill", side_effect=ProcessLookupError):
            result = self.client.get(f"/api/chat/jobs/{job_id}").json
        self.assertEqual(result["status"], "error")
        self.assertIn("riavvio", result["result"]["error"])

    def test_stream_endpoint_is_primary_and_old_endpoint_is_removed(self):
        self.assertEqual(self.client.post("/api/chat", json={
            "message": "no longer supported"
        }).status_code, 405)
        result = self.client.post("/api/chat/stream", data={
            "message": "stream"
        })
        self.assertEqual(result.status_code, 200)
        events = [json.loads(line.removeprefix("data: "))
                  for line in result.get_data(as_text=True).splitlines()
                  if line.startswith("data: ")]
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["reply"], "Risposta")


if __name__ == "__main__":
    unittest.main()
