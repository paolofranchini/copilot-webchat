import importlib
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class ChatFeatureTests(unittest.TestCase):
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
            "session_flag = '--session-id' if '--session-id' in args else '--resume'\n"
            "folder = Path.home() / '.copilot' / 'session-state' / args[args.index(session_flag) + 1]\n"
            "folder.mkdir(parents=True, exist_ok=True)\n"
            "if '--additional-mcp-config' in args:\n"
            "    config = args[args.index('--additional-mcp-config') + 1]\n"
            "    Path(os.environ['FAKE_CONFIG']).write_text(Path(config[1:]).read_text())\n"
            "Path(args[args.index('--usage-output-file') + 1]).write_text("
            "json.dumps({'totalNanoAiu': 1000000000}))\n"
            "prompt = args[args.index('-p') + 1]\n"
            "with (folder / 'events.jsonl').open('a') as events:\n"
            "    events.write(json.dumps({'type': 'user.message', 'data': {'content': prompt}}) + '\\n')\n"
            "reply = 'Piano' if '--plan' in args else 'Risposta'\n"
            "tool_event = {'type': 'tool.execution_start', 'data': {'name': 'read'}}\n"
            "print(json.dumps(tool_event), flush=True)\n"
            "if 'attesa' in prompt:\n"
            "    import time\n"
            "    time.sleep(2)\n"
            "assistant_event = {'type': 'assistant.message', "
            "'data': {'content': reply, 'model': 'gpt-test'}}\n"
            "with (folder / 'events.jsonl').open('a') as events:\n"
            "    events.write(json.dumps(assistant_event) + '\\n')\n"
            "print(json.dumps(assistant_event), flush=True)\n"
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

    def test_stream_handles_chat_requests_and_old_endpoint_is_removed(self):
        res = self.client.post("/api/chat/stream", data={
            "message": "ciao", "permissions": "[]"
        })
        self.assertEqual(res.status_code, 200)
        events = self.events(res)
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["reply"], "Risposta")
        self.assertEqual(events[-1]["usage"], {"ai_credits": 1})
        self.assertIn("tool.execution_start", [event["type"] for event in events])
        chat_id = events[-1]["chat_id"]
        self.assertEqual([row["role"] for row in self.client.get(
            f"/api/chats/{chat_id}").json], ["user", "bot"])
        self.assertIn("--stream", json.loads(self.args_path.read_text()))
        self.assertEqual(self.client.post("/api/chat", json={
            "message": "old endpoint"
        }).status_code, 405)

    def test_plan_requires_explicit_approval(self):
        self.assertEqual(self.client.post("/api/chat/plan/approve",
                                          json={}).status_code, 409)
        result = self.events(self.client.post("/api/chat/stream", data={
            "message": "progetto", "permissions": '["all"]',
            "plan": "true"
        }))[-1]
        self.assertTrue(result["pending_plan"])
        args = json.loads(self.args_path.read_text())
        self.assertIn("--plan", args)
        self.assertNotIn("--allow-all", args)
        self.assertEqual(self.client.post("/api/chat/stream", data={
            "message": "ancora"
        }).status_code, 409)
        approved = self.client.post("/api/chat/plan/approve", json={})
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
            f"/api/chats/{result['chat_id']}").json], ["user", "bot", "user", "bot"])

    def test_plan_cancellation_allows_following_message(self):
        plan = self.events(self.client.post("/api/chat/stream", data={
            "message": "piano", "plan": "true"
        }))[-1]
        self.assertEqual(self.client.post("/api/chat/plan/cancel",
                                          json={}).status_code, 200)
        self.assertEqual(self.events(self.client.post("/api/chat/stream", data={
            "message": "riprendi"
        }))[-1]["type"], "done")
        self.assertEqual([message["role"] for message in self.client.get(
            f"/api/chats/{plan['chat_id']}").json], ["user", "bot", "user", "bot"])

    def test_mcp_and_granular_permissions(self):
        invalid = self.client.post("/api/mcp-servers", json={
            "name": "test", "config": {"command": "sh -c echo fail"}
        })
        self.assertEqual(invalid.status_code, 400)
        invalid_http = self.client.post("/api/mcp-servers", json={
            "name": "invalid-http", "config": {
                "type": "http", "url": "http://example.com/api/mcp"
            }
        })
        self.assertEqual(invalid_http.status_code, 400)
        created = self.client.post("/api/mcp-servers", json={
            "name": "test", "config": {
                "command": "/bin/cat", "args": [], "env": {}
            }
        })
        self.assertEqual(created.status_code, 201)
        server_id = created.json["id"]
        created_chat = self.events(self.client.post("/api/chat/stream", data={
            "message": "prima"
        }))[-1]["chat_id"]
        self.assertEqual(self.client.put(
            f"/api/chats/{created_chat}/mcp-servers",
            json={"servers": [server_id]}).status_code, 200)
        self.assertEqual(self.client.put(
            f"/api/chats/{created_chat}/tool-permissions",
            json={"tools": ["shell(git status)"]}).status_code, 200)
        self.assertEqual(self.client.put(
            f"/api/chats/{created_chat}/tool-permissions",
            json={"tools": ["shell(; rm -rf /)"]}).status_code, 400)
        response = self.events(self.client.post("/api/chat/stream", data={
            "message": "lavoro", "permissions": '["shell"]',
            "mcp_servers": json.dumps([server_id]),
            "tool_permissions": '["shell(git status)"]'
        }))[-1]
        self.assertEqual(response["type"], "done")
        args = json.loads(self.args_path.read_text())
        self.assertNotIn("--fleet", args)
        self.assertIn("--allow-tool=shell(git status)", args)
        self.assertNotIn("--deny-tool=shell", args)
        self.assertEqual(json.loads(self.config_path.read_text())["mcpServers"]["test"]["command"],
                         "/bin/cat")
        self.assertFalse(list(self.backend.CONFIG_DIR.glob("webchat-mcp-*.json")))
        http_config = {
            "type": "http",
            "url": "https://learn.microsoft.com/api/mcp",
            "headers": {"X-Test": "value"},
            "tools": ["*"],
        }
        http_server = self.client.post("/api/mcp-servers", json={
            "name": "microsoft-docs", "config": http_config
        })
        self.assertEqual(http_server.status_code, 201)
        http_server_id = http_server.json["id"]
        http_result = self.events(self.client.post("/api/chat/stream", data={
            "message": "cerca nei docs", "permissions": '["shell"]',
            "mcp_servers": json.dumps([http_server_id]),
        }))[-1]
        self.assertEqual(http_result["type"], "done")
        args = json.loads(self.args_path.read_text())
        self.assertIn("--additional-mcp-config", args)
        self.assertEqual(
            json.loads(self.config_path.read_text())["mcpServers"]["microsoft-docs"],
            http_config,
        )
        self.assertFalse(list(self.backend.CONFIG_DIR.glob("webchat-mcp-*.json")))
        self.assertEqual(self.client.put(f"/api/mcp-servers/{server_id}", json={
            "enabled": False
        }).status_code, 200)
        servers = {server["id"]: server
                   for server in self.client.get("/api/mcp-servers").json}
        self.assertFalse(servers[server_id]["enabled"])
        self.assertEqual(self.client.delete(
            f"/api/mcp-servers/{server_id}", json={}
        ).status_code, 200)
        self.assertEqual(self.client.delete(
            f"/api/mcp-servers/{http_server_id}", json={}
        ).status_code, 200)
        self.assertEqual(self.client.get("/api/mcp-servers").json, [])

    def test_fleet_request_is_rejected(self):
        response = self.client.post("/api/chat/stream", data={
            "message": "lavoro", "fleet": "true"
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json, {"error": "fleet non supportato"})

    def test_new_chat_stores_tool_and_server_selections_on_first_turn(self):
        server_id = self.client.post("/api/mcp-servers", json={
            "name": "first", "config": {
                "command": "/bin/cat", "args": [], "env": {}
            }
        }).json["id"]
        result = self.events(self.client.post("/api/chat/stream", data={
            "message": "usa tool", "permissions": '["shell"]',
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
            "command": "/help"
        }).status_code, 200)
        self.assertEqual(self.client.post("/api/command", json={
            "command": "/unsupported"
        }).status_code, 400)
        without_flag = self.client.post("/api/chat/stream", data={
            "message": "senza flag"
        })
        self.assertEqual(without_flag.status_code, 200)
        self.assertEqual(self.backend.app.test_client().post("/api/chat/stream", data={
            "message": "non autenticato"
        }).status_code, 401)

    def test_cwd_command_is_used_for_new_chat_and_persisted(self):
        working_directory = Path(self.home.name) / "project with spaces"
        working_directory.mkdir()
        new_chat = self.client.post("/api/new-chat")
        chat_id = new_chat.json["chat_id"]
        result = self.client.post("/api/command", json={
            "command": f"/cwd {working_directory}", "chat_id": chat_id
        })
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["cwd"], str(working_directory.resolve()))

        response = self.client.post("/api/chat/stream", data={
            "message": "prova directory", "chat_id": chat_id, "permissions": "[]"
        })
        self.assertEqual(self.events(response)[-1]["type"], "done")
        args = json.loads(self.args_path.read_text())
        self.assertEqual(args[args.index("-C") + 1], str(working_directory.resolve()))

        current = self.client.post("/api/command", json={
            "command": "/cwd", "chat_id": chat_id
        })
        self.assertEqual(current.status_code, 200)
        self.assertEqual(current.json["cwd"], str(working_directory.resolve()))

    def test_migration_preserves_existing_chats(self):
        legacy_path = Path(self.home.name) / "legacy.db"
        with sqlite3.connect(legacy_path) as db:
            db.execute("CREATE TABLE chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, "
                       "created_at TEXT NOT NULL)")
            db.execute("INSERT INTO chats VALUES ('originale', 'Titolo', '2026-01-01')")
            db.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, "
                       "role TEXT NOT NULL, content TEXT NOT NULL, ts TEXT NOT NULL, model TEXT)")
            db.execute("INSERT INTO messages (chat_id, role, content, ts, model) "
                       "VALUES ('originale', 'bot', 'Risposta legacy', '2026-01-01', 'gpt-legacy')")
        with patch.object(self.backend, "DB_PATH", legacy_path):
            self.backend.init_db()
        with sqlite3.connect(legacy_path) as db:
            chat = db.execute(
                "SELECT title, model, mcp_servers, tool_permissions, pending_plan FROM chats"
            ).fetchone()
            self.assertEqual(chat, ("Sessione Copilot", "gpt-legacy", "[]", "[]", None))
            self.assertIsNone(db.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'"
            ).fetchone())

    def test_chat_history_comes_from_native_session_events(self):
        chat_id = self.events(self.client.post("/api/chat/stream", data={
            "message": "messaggio recente"
        }))[-1]["chat_id"]
        session_dir = self.backend.SESSION_STATE_DIR / chat_id
        session_dir.mkdir(parents=True, exist_ok=True)
        events = [
            {"type": "user.message", "timestamp": "2026-01-01T00:00:00+00:00",
             "data": {"content": "messaggio recente"}},
            {"type": "assistant.message", "timestamp": "2026-01-01T00:00:01+00:00",
             "data": {"content": "risposta nativa", "model": "gpt-test"}},
        ]
        (session_dir / "events.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in events)
        )
        messages = self.client.get(f"/api/chats/{chat_id}").json
        self.assertEqual([message["content"] for message in messages],
                         ["messaggio recente", "risposta nativa"])
        self.assertEqual([message["role"] for message in messages], ["user", "bot"])

    def test_stream_timeout_and_client_disconnect_close_process(self):
        with patch.object(self.backend, "TIMEOUT_SECONDS", 0.1):
            timed_out = self.events(self.client.post("/api/chat/stream", data={
                "message": "attesa"
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
                "message": "attesa"
            }, buffered=False)
            next(response.response)
            self.assertIn("tool.execution_start", next(response.response).decode())
            response.close()
        self.assertIsNotNone(processes[0].poll())
        self.assertFalse(list(self.backend.CONFIG_DIR.glob("webchat-usage-*.json")))


if __name__ == "__main__":
    unittest.main()
