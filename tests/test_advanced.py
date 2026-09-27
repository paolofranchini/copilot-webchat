import importlib
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class AdvancedChatTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        cls.home_patch = patch.dict(os.environ, {"HOME": cls.home.name})
        cls.home_patch.start()
        cls.backend = importlib.import_module("app")
        cls.cli = Path(cls.home.name) / "fake-copilot"
        cls.cli.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, sys\n"
            "from pathlib import Path\n"
            "args = sys.argv[1:]\n"
            "Path(os.environ['FAKE_ARGS']).write_text(json.dumps(args))\n"
            "if 'list' in args:\n"
            "    print('[]')\n"
            "    sys.exit(0)\n"
            "if '--additional-mcp-config' in args:\n"
            "    config = args[args.index('--additional-mcp-config') + 1]\n"
            "    Path(os.environ['FAKE_CONFIG']).write_text(Path(config[1:]).read_text())\n"
            "Path(args[args.index('--usage-output-file') + 1]).write_text("
            "json.dumps({'totalNanoAiu': 1000000000}))\n"
            "reply = 'Piano' if '--plan' in args else 'Risposta'\n"
            "print(json.dumps({'type': 'tool.execution_start', 'data': {'name': 'read'}}), flush=True)\n"
            "if 'attesa' in args[args.index('-p') + 1]:\n"
            "    import time\n"
            "    time.sleep(2)\n"
            "print(json.dumps({'type': 'assistant.message', "
            "'data': {'content': reply, 'model': 'gpt-test'}}), flush=True)\n"
        )
        cls.cli.chmod(0o700)
        cls.backend.COPILOT_BIN = str(cls.cli)
        cls.args_path = Path(cls.home.name) / "args.json"
        cls.config_path = Path(cls.home.name) / "mcp.json"
        cls.args_patch = patch.dict(os.environ, {
            "FAKE_ARGS": str(cls.args_path), "FAKE_CONFIG": str(cls.config_path)
        })
        cls.args_patch.start()

    @classmethod
    def tearDownClass(cls):
        cls.args_patch.stop()
        cls.home_patch.stop()
        cls.home.cleanup()

    def setUp(self):
        self.client = self.backend.app.test_client()
        with self.client.session_transaction() as browser:
            browser["authenticated"] = True

    def events(self, response):
        return [json.loads(line.removeprefix("data: "))
                for line in response.get_data(as_text=True).splitlines()
                if line.startswith("data: ")]

    def test_stream_keeps_history_usage_and_legacy_unchanged(self):
        res = self.client.post("/api/chat/stream", data={
            "advanced": "true", "message": "ciao", "permissions": "[]"
        })
        self.assertEqual(res.status_code, 200)
        events = self.events(res)
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["reply"], "Risposta")
        self.assertEqual(events[-1]["usage"], {"ai_credits": 1})
        self.assertEqual(events[0]["type"], "tool.execution_start")
        chat_id = events[-1]["chat_id"]
        self.assertEqual([row["role"] for row in self.client.get(
            f"/api/chats/{chat_id}").json], ["user", "bot"])
        self.assertIn("--stream", json.loads(self.args_path.read_text()))
        self.client.post("/api/new-chat")
        legacy = self.client.post("/api/chat", json={
            "message": "legacy", "permissions": []
        })
        self.assertEqual(legacy.status_code, 200)
        self.assertNotIn("--stream", json.loads(self.args_path.read_text()))

    def test_plan_requires_explicit_approval(self):
        self.assertEqual(self.client.post("/api/chat/plan/approve",
                                          json={"advanced": True}).status_code, 409)
        result = self.events(self.client.post("/api/chat/stream", data={
            "advanced": "true", "message": "progetto", "permissions": '["all"]',
            "plan": "true"
        }))[-1]
        self.assertTrue(result["pending_plan"])
        args = json.loads(self.args_path.read_text())
        self.assertIn("--plan", args)
        self.assertNotIn("--allow-all", args)
        self.assertEqual(self.client.post("/api/chat/stream", data={
            "advanced": "true", "message": "ancora"
        }).status_code, 409)
        approved = self.client.post("/api/chat/plan/approve", json={"advanced": True})
        self.assertEqual(approved.status_code, 200)
        self.assertEqual(approved.json["reply"], "Risposta")
        args = json.loads(self.args_path.read_text())
        self.assertEqual(args[args.index("--mode") + 1], "interactive")
        self.assertIn("--resume", args)
        self.assertIn("--allow-all", args)
        chat = next(c for c in self.client.get("/api/chats").json
                    if c["id"] == result["chat_id"])
        self.assertFalse(chat["pending_plan"])
        self.assertEqual([m["role"] for m in self.client.get(
            f"/api/chats/{result['chat_id']}").json], ["user", "plan", "user", "bot"])

    def test_plan_cancellation_allows_following_message(self):
        plan = self.events(self.client.post("/api/chat/stream", data={
            "advanced": "true", "message": "piano", "plan": "true"
        }))[-1]
        self.assertEqual(self.client.post("/api/chat/plan/cancel",
                                          json={"advanced": True}).status_code, 200)
        self.assertEqual(self.events(self.client.post("/api/chat/stream", data={
            "advanced": "true", "message": "riprendi"
        }))[-1]["type"], "done")
        self.assertEqual([message["role"] for message in self.client.get(
            f"/api/chats/{plan['chat_id']}").json], ["user", "plan", "user", "bot"])

    def test_mcp_granular_and_fleet(self):
        invalid = self.client.post("/api/mcp-servers", json={
            "advanced": True, "name": "test", "config": {"command": "sh -c echo fail"}
        })
        self.assertEqual(invalid.status_code, 400)
        created = self.client.post("/api/mcp-servers", json={
            "advanced": True, "name": "test", "config": {
                "command": "/bin/cat", "args": [], "env": {}
            }
        })
        self.assertEqual(created.status_code, 201)
        server_id = created.json["id"]
        created_chat = self.events(self.client.post("/api/chat/stream", data={
            "advanced": "true", "message": "prima"
        }))[-1]["chat_id"]
        self.assertEqual(self.client.put(
            f"/api/chats/{created_chat}/mcp-servers",
            json={"advanced": True, "servers": [server_id]}).status_code, 200)
        self.assertEqual(self.client.put(
            f"/api/chats/{created_chat}/tool-permissions",
            json={"advanced": True, "tools": ["shell(git status)"]}).status_code, 200)
        self.assertEqual(self.client.put(
            f"/api/chats/{created_chat}/tool-permissions",
            json={"advanced": True, "tools": ["shell(; rm -rf /)"]}).status_code, 400)
        response = self.events(self.client.post("/api/chat/stream", data={
            "advanced": "true", "message": "lavoro", "fleet": "true",
            "mcp_servers": json.dumps([server_id]),
            "tool_permissions": '["shell(git status)"]'
        }))[-1]
        self.assertEqual(response["type"], "done")
        args = json.loads(self.args_path.read_text())
        self.assertIn("--fleet", args)
        self.assertIn("--allow-tool=shell(git status)", args)
        self.assertNotIn("--deny-tool=shell", args)
        self.assertEqual(json.loads(self.config_path.read_text())["mcpServers"]["test"]["command"],
                         "/bin/cat")
        self.assertFalse(list(self.backend.CONFIG_DIR.glob("webchat-mcp-*.json")))
        self.assertEqual(self.client.put(f"/api/mcp-servers/{server_id}", json={
            "advanced": True, "enabled": False
        }).status_code, 200)
        self.assertEqual(self.client.get("/api/mcp-servers").json[0]["enabled"], False)
        self.assertEqual(self.client.delete(f"/api/mcp-servers/{server_id}", json={
            "advanced": True
        }).status_code, 200)
        self.assertEqual(self.client.get("/api/mcp-servers").json, [])

    def test_new_chat_stores_advanced_selections_on_first_turn(self):
        server_id = self.client.post("/api/mcp-servers", json={
            "advanced": True, "name": "first", "config": {
                "command": "/bin/cat", "args": [], "env": {}
            }
        }).json["id"]
        result = self.events(self.client.post("/api/chat/stream", data={
            "advanced": "true", "message": "usa tool", "permissions": "[]",
            "mcp_servers": json.dumps([server_id]),
            "tool_permissions": json.dumps(["url(github.com)"])
        }))[-1]
        self.assertEqual(result["type"], "done")
        args = json.loads(self.args_path.read_text())
        self.assertIn("--allow-tool=url(github.com)", args)
        chat = next(chat for chat in self.client.get("/api/chats").json
                    if chat["id"] == result["chat_id"])
        self.assertEqual(chat["mcp_servers"], [server_id])
        self.assertEqual(chat["tool_permissions"], ["url(github.com)"])

    def test_commands_and_skills(self):
        self.assertEqual(self.backend.app.test_client().get("/api/skills").status_code, 401)
        self.assertEqual(self.client.get("/api/skills").json,
                         {"skills": [], "plugins": []})
        self.assertEqual(self.client.post("/api/command", json={
            "advanced": True, "command": "/help"
        }).status_code, 200)
        self.assertEqual(self.client.post("/api/command", json={
            "advanced": True, "command": "/unsupported"
        }).status_code, 400)
        self.assertEqual(self.client.post("/api/chat/stream", data={
            "message": "senza modalita'"
        }).status_code, 400)
        self.assertEqual(self.backend.app.test_client().post("/api/chat/stream", data={
            "advanced": "true", "message": "non autenticato"
        }).status_code, 401)

    def test_migration_preserves_existing_chats(self):
        legacy_path = Path(self.home.name) / "legacy.db"
        with sqlite3.connect(legacy_path) as db:
            db.execute("CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, "
                       "created_at TEXT NOT NULL)")
            db.execute("INSERT INTO chats VALUES ('originale', 'Titolo', '2026-01-01')")
            db.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, "
                       "role TEXT NOT NULL, content TEXT NOT NULL, ts TEXT NOT NULL)")
        with patch.object(self.backend, "DB_PATH", legacy_path):
            self.backend.init_db()
        with sqlite3.connect(legacy_path) as db:
            chat = db.execute(
                "SELECT title, mcp_servers, tool_permissions, pending_plan FROM chats"
            ).fetchone()
            self.assertEqual(chat, ("Titolo", "[]", "[]", None))

    def test_stream_timeout_and_client_disconnect_close_process(self):
        with patch.object(self.backend, "TIMEOUT_SECONDS", 0.1):
            timed_out = self.events(self.client.post("/api/chat/stream", data={
                "advanced": "true", "message": "attesa"
            }))
        self.assertEqual(timed_out[-1]["type"], "error")
        self.assertIn("timeout", timed_out[-1]["error"])
        processes = []
        original_popen = subprocess.Popen

        def track_process(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            processes.append(process)
            return process

        with patch.object(self.backend.subprocess, "Popen", side_effect=track_process):
            response = self.client.post("/api/chat/stream", data={
                "advanced": "true", "message": "attesa"
            }, buffered=False)
            self.assertIn("tool.execution_start", next(response.response).decode())
            response.close()
        self.assertIsNotNone(processes[0].poll())
        self.assertFalse(list(self.backend.CONFIG_DIR.glob("webchat-usage-*.json")))


if __name__ == "__main__":
    unittest.main()
