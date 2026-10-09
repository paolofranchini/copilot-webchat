import io
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from werkzeug.security import generate_password_hash


class WebchatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import app
        cls.backend = app
        cls.tempdir = tempfile.TemporaryDirectory()
        cls.config_dir = Path(cls.tempdir.name)
        cls.original_paths = {
            name: getattr(cls.backend, name)
            for name in ("CONFIG_DIR", "DB_PATH", "SESSION_STATE_DIR", "UPLOAD_DIR")
        }
        cls.backend.CONFIG_DIR = cls.config_dir
        cls.backend.DB_PATH = cls.config_dir / "webchat.db"
        cls.backend.SESSION_STATE_DIR = cls.config_dir / "session-state"
        cls.backend.UPLOAD_DIR = cls.config_dir / "webchat_uploads"
        cls.backend.PASSWORD_HASH = generate_password_hash(
            "test-password", method="pbkdf2:sha256"
        )
        cls.backend.init_db()

    @classmethod
    def tearDownClass(cls):
        for name, value in cls.original_paths.items():
            setattr(cls.backend, name, value)
        cls.tempdir.cleanup()

    def setUp(self):
        self.session_tempdir = tempfile.TemporaryDirectory(dir=self.config_dir)
        self.addCleanup(self.session_tempdir.cleanup)
        self.session_path_patch = patch.object(
            self.backend, "SESSION_STATE_DIR", Path(self.session_tempdir.name)
        )
        self.session_path_patch.start()
        self.addCleanup(self.session_path_patch.stop)
        self.client = self.backend.app.test_client()
        with self.backend.app.app_context():
            db = self.backend.get_db()
            db.execute("DELETE FROM chat_jobs")
            db.execute("DELETE FROM mcp_servers")
            db.execute("DELETE FROM chats")
            db.commit()
        self.assertEqual(self.client.post(
            "/api/login", json={"password": "test-password"}
        ).status_code, 200)

    def insert_chat(self, chat_id=None, title="Chat"):
        chat_id = chat_id or str(uuid.uuid4())
        with self.backend.app.app_context():
            db = self.backend.get_db()
            db.execute(
                "INSERT INTO chats (id, title, created_at) VALUES (?, ?, ?)",
                (chat_id, title, "2026-01-01T00:00:00+00:00"),
            )
            db.commit()
        return chat_id

    def select_chat(self, chat_id):
        with self.client.session_transaction() as session:
            session["copilot_session_id"] = chat_id

    def test_login_and_missing_chat(self):
        anonymous = self.backend.app.test_client()
        self.assertEqual(anonymous.get("/api/chats").status_code, 401)
        self.assertEqual(
            anonymous.post("/api/login", json={"password": "wrong"}).status_code, 401
        )
        self.assertEqual(
            self.client.get(f"/api/chats/{uuid.uuid4()}").status_code, 404
        )

    def test_running_job_rejects_another_chat_request(self):
        chat_id = self.insert_chat()
        self.select_chat(chat_id)
        job_id = str(uuid.uuid4())
        with self.backend.app.app_context():
            db = self.backend.get_db()
            db.execute(
                "INSERT INTO chat_jobs (id, chat_id, status, owner_pid) "
                "VALUES (?, ?, 'running', ?)",
                (job_id, chat_id, os.getpid()),
            )
            db.commit()
        result = self.client.post("/api/chat/stream", data={"message": "ciao",
                                          "permissions": "[]"})
        self.assertEqual(result.status_code, 409)
        self.assertIn("error", result.json)

    def test_model_command_updates_current_chat_without_mode_flag(self):
        chat_id = self.insert_chat()
        self.select_chat(chat_id)
        result = self.client.post("/api/command", json={"command": "/model gpt-6-sol"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["model"], "gpt-6-sol")
        help_response = self.client.post("/api/command", json={"command": "/help"})
        self.assertEqual(help_response.status_code, 200)
        self.assertIn("/chronicle", help_response.json["reply"])
        with self.backend.app.app_context():
            model = self.backend.get_db().execute(
                "SELECT model FROM chats WHERE id = ?", (chat_id,)
            ).fetchone()["model"]
        self.assertEqual(model, "gpt-6-sol")

    def test_stream_returns_done_event(self):
        chat_id = self.insert_chat()
        self.select_chat(chat_id)

        def fake_stream(*args, **kwargs):
            yield self.backend.sse({"type": "done", "reply": "ok", "chat_id": chat_id})

        with patch.object(self.backend, "run_copilot_stream", side_effect=fake_stream):
            response = self.client.post(
                "/api/chat/stream", data={"message": "ciao", "permissions": "[]"},
                buffered=False
            )
            self.assertEqual(response.status_code, 200)
            events = b"".join(response.response).decode()
            self.assertIn('"type": "done"', events)
            response.close()

    def test_native_session_listing_imports_without_overwriting_chat_settings(self):
        chat_id = self.insert_chat(title="Titolo personalizzato")
        other_id = str(uuid.uuid4())
        with self.backend.app.app_context():
            db = self.backend.get_db()
            db.execute(
                "UPDATE chats SET permissions = ?, model = ?, tool_permissions = ? WHERE id = ?",
                ('["shell"]', "gpt-6-sol", '["shell(git status)"]', chat_id),
            )
            db.commit()
        for session_id in (chat_id, other_id):
            folder = self.backend.SESSION_STATE_DIR / session_id
            folder.mkdir(parents=True, exist_ok=True)
            (folder / "workspace.yaml").write_text(
                "name: webchat:Importata\ncreated_at: 2026-01-01T00:00:00+00:00\n"
            )
            (folder / "events.jsonl").write_text(json.dumps({
                "type": "user.message", "data": {"content": "Messaggio importato"},
                "timestamp": "2026-01-01T00:00:00+00:00",
            }) + "\n")
        listed = self.client.get("/api/chats")
        self.assertEqual(listed.status_code, 200)
        self.assertEqual({chat["id"] for chat in listed.json}, {chat_id, other_id})
        self.assertEqual(
            self.client.get(f"/api/chats/{other_id}").json[0]["content"],
            "Messaggio importato",
        )
        with self.backend.app.app_context():
            db = self.backend.get_db()
            existing = db.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
        self.assertEqual(existing["title"], "Titolo personalizzato")
        self.assertEqual(existing["permissions"], '["shell"]')
        self.assertEqual(existing["model"], "gpt-6-sol")
        self.assertEqual(existing["tool_permissions"], '["shell(git status)"]')

    def test_chat_history_is_read_from_native_session_files(self):
        chat_id = str(uuid.uuid4())
        folder = self.backend.SESSION_STATE_DIR / chat_id
        folder.mkdir()
        (folder / "workspace.yaml").write_text("name: Chat nativa\n")
        messages = [
            {"type": "user.message", "data": {"content": "parola%letterale"}},
            {"type": "assistant.message", "data": {"content": "Risposta"}},
        ]
        (folder / "events.jsonl").write_text(
            "".join(json.dumps(message) + "\n" for message in messages)
        )
        history = self.client.get(f"/api/chats/{chat_id}")
        self.assertEqual(history.status_code, 200)
        self.assertEqual([message["content"] for message in history.json],
                         ["parola%letterale", "Risposta"])
        self.assertEqual([message["role"] for message in history.json], ["user", "bot"])

    def test_attachment_limit(self):
        files = [(io.BytesIO(b"x"), f"{index}.txt") for index in range(6)]
        response = self.client.post("/api/chat/stream", data={
            "message": "ciao", "files": files, "permissions": "[]"
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json)


if __name__ == "__main__":
    unittest.main()
