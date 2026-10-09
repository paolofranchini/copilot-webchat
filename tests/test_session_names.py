import importlib
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch


class SessionNameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {"HOME": cls.home.name}):
            cls.backend = importlib.import_module("app")

    @classmethod
    def tearDownClass(cls):
        cls.home.cleanup()

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.state_dir = Path(self.tempdir.name)
        self.state_patch = patch.object(self.backend, "SESSION_STATE_DIR", self.state_dir)
        self.state_patch.start()
        self.addCleanup(self.state_patch.stop)
        self.session_id = str(uuid.uuid4())
        self.folder = self.state_dir / self.session_id
        self.folder.mkdir()
        self.workspace = self.folder / "workspace.yaml"

    def test_rename_removes_all_old_name_continuations(self):
        for old_name in (
            'name: Vecchio titolo\n  testo con # commento\n\n  [Istruzioni: testo]\n',
            'name: >-\n  Vecchio titolo\n  altre righe\n\n',
            'name: |\n  Vecchio titolo\n  altre righe\n',
            'name: Vecchio titolo\n',
        ):
            with self.subTest(old_name=old_name):
                self.workspace.write_text(
                    f"id: {self.session_id}\n{old_name}"
                    "user_named: false\ncreated_at: 2026-10-07T07:07:59.287Z\n"
                )
                self.backend.write_session_name(self.session_id, "Luna frontend")
                self.assertEqual(
                    self.workspace.read_text(),
                    f'id: {self.session_id}\nname: "Luna frontend"\n'
                    "user_named: false\ncreated_at: 2026-10-07T07:07:59.287Z\n",
                )

    def test_special_characters_round_trip(self):
        for title in (
            'Titolo: con # commento',
            '"Citazione" e \\percorso',
            'true',
            '[titolo]',
            'Prima riga\nSeconda riga\tfine',
            'Caff\u00e8 \U0001f319',
            'Separatori \u0085 \u2028 \u2029 e controllo \x80',
        ):
            with self.subTest(title=title):
                self.workspace.write_text(f"id: {self.session_id}\nname: Vecchio\n")
                self.backend.write_session_name(self.session_id, title)
                lines = self.workspace.read_text().splitlines()
                self.assertEqual(len(lines), 2)
                self.assertEqual(json.loads(lines[1].removeprefix("name: ")), title)
                self.assertEqual(self.backend.read_session_metadata(self.folder)["name"], title)

    def test_missing_name_preserves_other_metadata(self):
        self.workspace.write_text(f"id: {self.session_id}\nuser_named: false\n")
        self.backend.write_session_name(self.session_id, "Nuovo")
        self.assertEqual(
            self.workspace.read_text(),
            f'name: "Nuovo"\nid: {self.session_id}\nuser_named: false\n',
        )

    def test_legacy_unquoted_name_is_unchanged(self):
        self.workspace.write_text("name: webchat:Importata\n")
        self.assertEqual(
            self.backend.read_session_metadata(self.folder)["name"], "webchat:Importata"
        )

    def test_renamed_chat_keeps_its_display_title_and_messages(self):
        self.workspace.write_text(
            "name: Titolo originale\n  continuazione\n\n  [Istruzioni: testo]\n"
            "created_at: 2026-10-07T07:07:59.287Z\n"
        )
        event = {
            "type": "user.message",
            "timestamp": "2026-10-07T07:07:59.287Z",
            "data": {"content": "Messaggio da conservare"},
        }
        events = self.folder / "events.jsonl"
        events.write_text(json.dumps(event) + "\n")
        original_events = events.read_bytes()
        title = 'Luna: "frontend" #1'
        self.backend.write_session_name(self.session_id, title)
        chat = self.backend.read_native_chat(self.session_id, include_messages=False)
        self.assertEqual(chat["title"], title)
        self.assertEqual(chat["created_at"], event["timestamp"])
        self.assertEqual(events.read_bytes(), original_events)

    def test_multiline_yaml_name_is_read_as_one_line_chat_title(self):
        self.workspace.write_text(
            "name: |-\n"
            "  Un prompt lungo per una nuova chat\n"
            "  con altre righe\n"
            "  [Istruzioni: testo di sistema]\n"
            "user_named: false\n"
            "created_at: 2026-10-07T07:07:59.287Z\n"
        )
        event = {
            "type": "user.message",
            "timestamp": "2026-10-07T07:07:59.287Z",
            "data": {"content": "Un prompt lungo per una nuova chat"},
        }
        events = self.folder / "events.jsonl"
        events.write_text(json.dumps(event) + "\n")

        metadata = self.backend.read_session_metadata(self.folder)
        chat = self.backend.read_native_chat(self.session_id, include_messages=False)
        self.assertEqual(
            metadata["name"],
            "Un prompt lungo per una nuova chat\n"
            "con altre righe\n"
            "[Istruzioni: testo di sistema]",
        )
        self.assertEqual(
            chat["title"],
            "Un prompt lungo per una nuova chat con altre righe [Istruzioni: testo di sistema]",
        )
        self.assertNotIn("|-", chat["title"])


if __name__ == "__main__":
    unittest.main()
