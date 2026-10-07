import importlib.util
import json
import os
import sqlite3
import tempfile
import unittest
import uuid
from contextlib import closing
from pathlib import Path
from unittest.mock import patch


class MessageUsageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        spec = importlib.util.spec_from_file_location(
            "webchat_message_usage", Path(__file__).resolve().parents[1] / "app.py"
        )
        cls.backend = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"HOME": cls.home.name}):
            spec.loader.exec_module(cls.backend)
        cls.usage_db = cls.backend.CONFIG_DIR / "session-store.db"
        with closing(sqlite3.connect(cls.usage_db)) as db, db:
            db.execute("CREATE TABLE assistant_usage_events "
                       "(session_id TEXT, created_at TEXT, total_nano_aiu INTEGER)")

    @classmethod
    def tearDownClass(cls):
        cls.home.cleanup()

    def setUp(self):
        self.chat_id = str(uuid.uuid4())
        self.client = self.backend.app.test_client()
        with self.client.session_transaction() as browser:
            browser["authenticated"] = True

    def write_chat(self, messages):
        folder = self.backend.SESSION_STATE_DIR / self.chat_id
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "events.jsonl").write_text("".join(
            json.dumps({"type": f"{role}.message", "timestamp": ts,
                        "data": {"content": content, "model": "gpt-test"}}) + "\n"
            for role, ts, content in messages
        ))

    def billing(self, rows):
        with closing(sqlite3.connect(self.usage_db)) as db, db:
            db.executemany("INSERT INTO assistant_usage_events VALUES (?, ?, ?)",
                           [(self.chat_id, ts, amount) for ts, amount in rows])

    def test_history_aggregates_turn_only_on_final_response(self):
        self.write_chat([
            ("user", "2026-10-07T10:00:00Z", "uno"),
            ("assistant", "2026-10-07T10:00:01Z", "lavoro"),
            ("assistant", "2026-10-07T10:00:05Z", "risposta uno"),
            ("user", "2026-10-07T12:01:00+02:00", "due"),
            ("assistant", "2026-10-07T10:01:05Z", "risposta due"),
            ("user", "2026-10-07T10:02:00Z", "tre"),
            ("assistant", "2026-10-07T10:02:05Z", "senza consumo"),
        ])
        self.billing([
            ("2026-10-07T09:59:59Z", 9000000000),
            ("2026-10-07T10:00:01.100Z", 1000000000),
            ("2026-10-07 10:00:03", 250000000),
            ("2026-10-07T10:01:00Z", 0),
            ("2026-10-07T10:02:01Z", None),
            ("2026-10-07T10:02:02Z", -1),
            ("invalid", 1000000000),
        ])
        response = self.client.get(f"/api/chats/{self.chat_id}")
        self.assertEqual(response.status_code, 200)
        messages = response.json
        self.assertEqual(messages[2]["usage"], {"ai_credits": 1.25})
        self.assertEqual(messages[4]["usage"], {"ai_credits": 0})
        for index in (0, 1, 3, 5, 6):
            self.assertNotIn("usage", messages[index])
        self.assertIsNone(self.backend.latest_message_usage(self.chat_id))

    def test_live_reply_and_reloaded_history_have_same_credits(self):
        self.write_chat([
            ("user", "2026-10-07T10:00:00Z", "ciao"),
            ("assistant", "2026-10-07T10:00:05Z", "risposta"),
        ])
        self.billing([("2026-10-07T10:00:04Z", 1234567890)])
        with patch.object(self.backend, "run_copilot",
                          return_value=("risposta", "gpt-test", {"ai_credits": 99})):
            response = self.client.post("/api/chat", json={
                "chat_id": self.chat_id, "message": "ciao"
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["usage"]["ai_credits"], 99)
        self.assertEqual(response.json["message_usage"]["ai_credits"], 1.23456789)
        self.assertEqual(self.client.get(f"/api/chats/{self.chat_id}").json[-1]["usage"],
                         response.json["message_usage"])

    def test_missing_timestamps_and_database_do_not_invent_zero(self):
        self.write_chat([("user", "", "ciao"), ("assistant", "", "risposta")])
        messages = self.client.get(f"/api/chats/{self.chat_id}").json
        self.assertTrue(all("usage" not in message for message in messages))
        with patch.object(self.backend, "CONFIG_DIR", Path(self.home.name) / "missing"):
            messages = [{"role": "user", "ts": "2026-10-07T10:00:00Z"},
                        {"role": "bot", "ts": "2026-10-07T10:00:01Z"}]
            self.backend.attach_message_usage(self.chat_id, messages)
        self.assertNotIn("usage", messages[-1])

    def test_pending_new_turn_does_not_reuse_previous_cost(self):
        self.write_chat([
            ("user", "2026-10-07T10:00:00Z", "uno"),
            ("assistant", "2026-10-07T10:00:05Z", "risposta"),
            ("user", "2026-10-07T10:01:00Z", "due"),
        ])
        self.billing([("2026-10-07T10:00:04Z", 1000000000)])
        self.assertIsNone(self.backend.latest_message_usage(self.chat_id))


if __name__ == "__main__":
    unittest.main()
