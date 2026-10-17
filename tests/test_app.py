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
        folder = self.backend.SESSION_STATE_DIR / chat_id
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "workspace.yaml").write_text(
            "name: webchat:Attiva\ncreated_at: 2026-01-01T00:00:00+00:00\n"
        )
        (folder / "events.jsonl").write_text(json.dumps({
            "type": "user.message", "data": {"content": "Ciao"},
            "timestamp": "2026-01-01T00:00:00+00:00",
        }) + "\n")
        listed = next(chat for chat in self.client.get("/api/chats").json
                      if chat["id"] == chat_id)
        self.assertTrue(listed["running"])
        self.assertEqual(listed["job_id"], job_id)

    def test_model_command_updates_current_chat_without_mode_flag(self):
        chat_id = self.insert_chat()
        self.select_chat(chat_id)
        result = self.client.post("/api/command", json={"command": "/model gpt-6-sol"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["model"], "gpt-6-sol")
        help_response = self.client.post("/api/command", json={"command": "/help"})
        self.assertEqual(help_response.status_code, 200)
        self.assertIn("/chronicle", help_response.json["reply"])
        self.assertIn("/cwd", help_response.json["reply"])
        with self.backend.app.app_context():
            model = self.backend.get_db().execute(
                "SELECT model FROM chats WHERE id = ?", (chat_id,)
            ).fetchone()["model"]
        self.assertEqual(model, "gpt-6-sol")

    def test_cwd_command_persists_valid_directory_per_chat(self):
        chat_id = self.insert_chat()
        self.select_chat(chat_id)
        working_directory = self.config_dir / "directory with spaces"
        working_directory.mkdir()

        result = self.client.post("/api/command", json={
            "command": f"/cwd {working_directory}", "chat_id": chat_id
        })
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["cwd"], str(working_directory.resolve()))
        self.assertEqual(self.client.post("/api/command", json={
            "command": "/cwd", "chat_id": chat_id
        }).json["cwd"], str(working_directory.resolve()))
        with self.backend.app.app_context():
            saved_directory = self.backend.get_db().execute(
                "SELECT working_directory FROM chats WHERE id = ?", (chat_id,)
            ).fetchone()["working_directory"]
        self.assertEqual(saved_directory, str(working_directory.resolve()))

        invalid = self.client.post("/api/command", json={
            "command": "/cwd /path/that/does/not/exist", "chat_id": chat_id
        })
        self.assertEqual(invalid.status_code, 400)
        mismatch = self.client.post("/api/command", json={
            "command": "/cwd", "chat_id": str(uuid.uuid4())
        })
        self.assertEqual(mismatch.status_code, 400)

    def test_directory_picker_lists_only_directories_inside_available_roots(self):
        chat_id = self.insert_chat()
        self.select_chat(chat_id)
        project_root = self.config_dir / "projects"
        (project_root / "webchat").mkdir(parents=True)
        (project_root / "android-client").mkdir()
        outside_root = self.config_dir / "outside"
        outside_root.mkdir()
        try:
            (project_root / "outside-link").symlink_to(outside_root, target_is_directory=True)
        except OSError:
            pass
        with self.backend.app.app_context():
            db = self.backend.get_db()
            db.execute(
                "UPDATE chats SET working_directory = ? WHERE id = ?",
                (str(project_root), chat_id),
            )
            db.commit()

        response = self.client.get(
            "/api/directories",
            query_string={"chat_id": chat_id, "path": str(project_root)},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["current"], str(project_root.resolve()))
        self.assertIsNone(response.json["parent"])
        self.assertEqual(
            [item["name"] for item in response.json["directories"]],
            ["android-client", "webchat"],
        )
        self.assertEqual(
            self.client.get(
                "/api/directories",
                query_string={"chat_id": chat_id},
            ).json["current"],
            str(project_root.resolve()),
        )

        outside = self.client.get(
            "/api/directories",
            query_string={"chat_id": chat_id, "path": str(self.config_dir.parent)},
        )
        self.assertEqual(outside.status_code, 403)

    def test_directory_picker_requires_selected_chat_and_authentication(self):
        chat_id = self.insert_chat()
        mismatch = self.client.get(
            "/api/directories", query_string={"chat_id": str(uuid.uuid4())}
        )
        self.assertEqual(mismatch.status_code, 400)
        unauthenticated = self.backend.app.test_client().get("/api/directories")
        self.assertEqual(unauthenticated.status_code, 401)
        self.select_chat(chat_id)
        invalid = self.client.get(
            "/api/directories",
            query_string={"chat_id": chat_id, "path": "/path/that/does/not/exist"},
        )
        self.assertEqual(invalid.status_code, 404)

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
            {"type": "assistant.message", "data": {"content": "Prima risposta"}},
            {"type": "assistant.message", "data": {"content": "Risposta"}},
        ]
        (folder / "events.jsonl").write_text(
            "".join(json.dumps(message) + "\n" for message in messages)
        )
        history = self.client.get(f"/api/chats/{chat_id}")
        self.assertEqual(history.status_code, 200)
        self.assertEqual([message["content"] for message in history.json],
                         ["parola%letterale", "Prima risposta", "Risposta"])
        self.assertEqual([message["role"] for message in history.json],
                         ["user", "bot", "bot"])

    def test_attachment_limit(self):
        files = [(io.BytesIO(b"x"), f"{index}.txt") for index in range(6)]
        response = self.client.post("/api/chat/stream", data={
            "message": "ciao", "files": files, "permissions": "[]"
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.json)


if __name__ == "__main__":
    unittest.main()
