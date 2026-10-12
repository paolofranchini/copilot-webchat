import importlib.util
import io
import json
import os
import tempfile
import time
import unittest
import urllib.request
import uuid
from pathlib import Path
from unittest.mock import patch


class CopilotStudioTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        spec = importlib.util.spec_from_file_location(
            "webchat_copilot_studio_tests",
            Path(__file__).resolve().parents[1] / "app.py",
        )
        cls.backend = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"HOME": cls.home.name}):
            spec.loader.exec_module(cls.backend)

    @classmethod
    def tearDownClass(cls):
        cls.home.cleanup()

    def setUp(self):
        self.backend.DIRECTLINE_SECRET_FILE.unlink(missing_ok=True)
        with self.backend.app.app_context():
            db = self.backend.get_db()
            db.execute("DELETE FROM studio_messages")
            db.execute("DELETE FROM chat_jobs")
            db.execute("DELETE FROM chats WHERE provider = 'studio'")
            db.commit()
        self.client = self.backend.app.test_client()
        with self.client.session_transaction() as browser:
            browser["authenticated"] = True

    def configure_secret(self):
        self.backend.store_directline_secret("test-direct-line-secret")

    def create_studio_chat(self):
        response = self.client.post("/api/new-chat", json={"provider": "studio"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["provider"], "studio")
        return response.json["chat_id"]

    def wait_for_job(self, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            response = self.client.get(f"/api/chat/jobs/{job_id}")
            self.assertEqual(response.status_code, 200)
            if response.json["status"] != "running":
                return response.json
            time.sleep(0.01)
        self.fail("Il job Copilot Studio non è terminato")

    def test_studio_mode_requires_configured_secret(self):
        response = self.client.post("/api/new-chat", json={"provider": "studio"})
        self.assertEqual(response.status_code, 409)
        self.assertIn("secret Direct Line", response.json["error"])
        self.assertEqual(
            self.client.post("/api/new-chat", json={"provider": "unknown"}).status_code,
            400,
        )

    def test_directline_request_uses_authorization_bearer(self):
        captured = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"ok": true}'

        def open_url(request, timeout):
            captured.append((request, timeout))
            return Response()

        with patch.object(self.backend.urllib.request, "urlopen", side_effect=open_url):
            result = self.backend.directline_request(
                "tokens/generate", "POST", "example-token",
                {"user": {"id": "dl_test"}},
            )
        self.assertEqual(result, {"ok": True})
        request, timeout = captured[0]
        self.assertEqual(request.get_header("Authorization"), "Bearer example-token")
        self.assertEqual(
            request.full_url,
            "https://europe.directline.botframework.com/v3/directline/tokens/generate",
        )
        self.assertEqual(timeout, 20)

    def test_directline_403_reports_operation_without_credentials(self):
        error = urllib.error.HTTPError(
            "https://directline.example", 403, "Forbidden", {},
            io.BytesIO(b'{"error":{"code":"RegionNotAllowed"}}'),
        )
        with patch.object(self.backend.urllib.request, "urlopen", side_effect=error):
            with self.assertRaises(self.backend.DirectLineError) as raised:
                self.backend.directline_request(
                    "tokens/generate", "POST", "private-secret"
                )
        self.assertIn("generazione token", str(raised.exception))
        self.assertIn("403", str(raised.exception))
        self.assertIn("RegionNotAllowed", str(raised.exception))
        self.assertNotIn("private-secret", str(raised.exception))

    def test_studio_chat_sends_and_resumes_directline_conversation(self):
        self.configure_secret()
        chat_id = self.create_studio_chat()
        next_reply = ["Risposta uno", "Risposta due"]
        calls = []

        def directline(path, method, token, body=None):
            calls.append((path, method, token, body))
            if path == "tokens/generate":
                self.assertEqual(token, "test-direct-line-secret")
                self.assertEqual(body["user"]["id"], f"dl_{chat_id}")
                return {"token": "session-token"}
            if path == "tokens/refresh":
                self.assertEqual(token, "started-token")
                return {"token": "refreshed-token"}
            if path == "conversations":
                self.assertEqual(token, "session-token")
                return {
                    "token": "started-token",
                    "conversationId": "conversation-1",
                }
            if method == "POST":
                self.assertEqual(body["type"], "message")
                return {"id": "activity-1"}
            if "watermark" not in path:
                return {"watermark": "1", "activities": []}
            return {
                "watermark": "2",
                "activities": [{
                    "type": "message", "from": {"id": "studio-agent"},
                    "text": next_reply.pop(0),
                }],
            }

        with patch.object(self.backend, "directline_request", side_effect=directline):
            for prompt in ("ciao", "ancora"):
                request_id = str(uuid.uuid4())
                response = self.client.post("/api/chat/stream", data={
                    "message": prompt,
                    "chat_id": chat_id,
                    "permissions": "[]",
                    "async": "true",
                    "request_id": request_id,
                })
                self.assertEqual(response.status_code, 202)
                result = self.wait_for_job(request_id)
                self.assertEqual(result["status"], "done")
                self.assertEqual(result["result"]["model"], "Copilot Studio")

        sent = [call[3]["text"] for call in calls
                if call[0].endswith("/activities") and call[1] == "POST"]
        self.assertEqual(sent, ["ciao", "ancora"])
        generated_token = next(call for call in calls if call[0] == "tokens/generate")
        self.assertEqual(
            generated_token[3]["user"]["id"], f"dl_{chat_id}"
        )
        started_call = next(call for call in calls if call[0] == "conversations")
        self.assertEqual(started_call[1], "POST")
        self.assertTrue(any(call[0] == "tokens/refresh" for call in calls))
        with self.backend.app.app_context():
            db = self.backend.get_db()
            row = db.execute(
                "SELECT directline_conversation_id, directline_token_enc, title "
                "FROM chats WHERE id = ?", (chat_id,)
            ).fetchone()
            self.assertEqual(row["directline_conversation_id"], "conversation-1")
            self.assertNotIn("started-token", row["directline_token_enc"])
            self.assertEqual(row["title"], "ciao")
            messages = db.execute(
                "SELECT role, content FROM studio_messages WHERE chat_id = ? ORDER BY id",
                (chat_id,),
            ).fetchall()
            self.assertEqual(
                [(message["role"], message["content"]) for message in messages],
                [("user", "ciao"), ("bot", "Risposta uno"),
                 ("user", "ancora"), ("bot", "Risposta due")],
            )
        chats = self.client.get("/api/chats").json
        listed = next(chat for chat in chats if chat["id"] == chat_id)
        self.assertEqual(listed["provider"], "studio")
        self.assertEqual(listed["title"], "ciao")
        history = self.client.get(f"/api/chats/{chat_id}").json
        self.assertEqual(len(history), 4)

    def test_legacy_conversation_404_starts_before_sending_prompt(self):
        self.configure_secret()
        chat_id = self.create_studio_chat()
        encrypted = self.backend.directline_cipher().encrypt(
            b"legacy-token"
        ).decode("ascii")
        with self.backend.app.app_context():
            db = self.backend.get_db()
            db.execute(
                "UPDATE chats SET directline_conversation_id = ?, "
                "directline_token_enc = ? WHERE id = ?",
                ("legacy-conversation", encrypted, chat_id),
            )
            db.commit()

        calls = []
        reply = {"pending": True}

        def directline(path, method, token, body=None):
            calls.append((path, method, token, body))
            if path == "tokens/refresh":
                return {"token": "legacy-refreshed"}
            if path == "conversations":
                return {
                    "conversationId": "repaired-conversation",
                    "token": "repaired-token",
                }
            if "/activities" in path and method == "GET":
                if "legacy-conversation" in path:
                    raise self.backend.DirectLineError(
                        "HTTP 404 ResourceNotFound",
                        status_code=404,
                        error_code="ResourceNotFound",
                    )
                if "watermark" not in path:
                    return {"watermark": "1", "activities": []}
                if reply["pending"]:
                    reply["pending"] = False
                    return {
                        "watermark": "2",
                        "activities": [{
                            "type": "message",
                            "from": {"id": "studio-agent"},
                            "text": "Risposta ripristinata",
                        }],
                    }
            if method == "POST":
                return {"id": "activity-legacy"}
            return {"activities": []}

        with patch.object(self.backend, "directline_request", side_effect=directline):
            request_id = str(uuid.uuid4())
            response = self.client.post("/api/chat/stream", data={
                "message": "riprendi",
                "chat_id": chat_id,
                "permissions": "[]",
                "async": "true",
                "request_id": request_id,
            })
            self.assertEqual(response.status_code, 202)
            result = self.wait_for_job(request_id)
        self.assertEqual(result["status"], "done")
        sent = [call for call in calls
                if call[0].endswith("/activities") and call[1] == "POST"]
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][3]["text"], "riprendi")
        started = next(call for call in calls if call[0] == "conversations")
        self.assertEqual(started[1], "POST")
        self.assertEqual(started[2], "legacy-refreshed")
        with self.backend.app.app_context():
            row = self.backend.get_db().execute(
                "SELECT directline_conversation_id FROM chats WHERE id = ?",
                (chat_id,),
            ).fetchone()
            self.assertEqual(row["directline_conversation_id"], "repaired-conversation")

    def test_studio_rejects_attachments_and_plan(self):
        self.configure_secret()
        chat_id = self.create_studio_chat()
        attachment = self.client.post("/api/chat/stream", data={
            "message": "analizza", "chat_id": chat_id, "permissions": "[]",
            "files": (io.BytesIO(b"contenuto"), "document.txt"),
        })
        self.assertEqual(attachment.status_code, 400)
        plan = self.client.post("/api/chat/stream", data={
            "message": "pianifica", "chat_id": chat_id, "permissions": "[]",
            "plan": "true",
        })
        self.assertEqual(plan.status_code, 400)


if __name__ == "__main__":
    unittest.main()
