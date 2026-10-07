import base64
import importlib.util
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8uoAAAAASUVORK5CYII="
)


class ImageResponseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        spec = importlib.util.spec_from_file_location(
            "webchat_image_tests", Path(__file__).resolve().parents[1] / "app.py"
        )
        cls.backend = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"HOME": cls.home.name}):
            spec.loader.exec_module(cls.backend)
        cls.cli = Path(cls.home.name) / "fake-copilot"
        cls.cli.write_text(
            "#!/usr/bin/env python3\n"
            "import json, sys\n"
            "from pathlib import Path\n"
            "args = sys.argv[1:]\n"
            "flag = '--session-id' if '--session-id' in args else '--resume'\n"
            "chat = args[args.index(flag) + 1]\n"
            "folder = Path(__file__).parent / '.copilot' / 'session-state' / chat\n"
            "(folder / 'files').mkdir(parents=True, exist_ok=True)\n"
            f"(folder / 'files' / 'risposta.png').write_bytes({PNG_BYTES!r})\n"
            "prompt = args[args.index('-p') + 1]\n"
            "reply = f'![Diagramma](/api/chats/{chat}/images/risposta.png)'\n"
            "event = {'type': 'assistant.message', 'data': {'content': reply, 'model': 'gpt-test'}}\n"
            "with (folder / 'events.jsonl').open('a') as events:\n"
            " events.write(json.dumps({'type': 'user.message', 'data': {'content': prompt}}) + '\\n')\n"
            " events.write(json.dumps(event) + '\\n')\n"
            "Path(args[args.index('--usage-output-file') + 1]).write_text('{\"totalNanoAiu\":0}')\n"
            "print(json.dumps(event), flush=True)\n"
        )
        cls.cli.chmod(0o700)
        cls.backend.COPILOT_BIN = str(cls.cli)

    @classmethod
    def tearDownClass(cls):
        cls.home.cleanup()

    def setUp(self):
        self.chat_id = str(uuid.uuid4())
        self.directory = self.backend.SESSION_STATE_DIR / self.chat_id / "files"
        self.directory.mkdir(parents=True)
        self.png = PNG_BYTES
        (self.directory / "diagramma.png").write_bytes(self.png)
        self.url = f"/api/chats/{self.chat_id}/images/"
        self.client = self.backend.app.test_client()
        with self.client.session_transaction() as browser:
            browser["authenticated"] = True

    def test_images_require_login_and_have_private_headers(self):
        anonymous = self.backend.app.test_client()
        response = anonymous.get(self.url + "diagramma.png")
        self.assertEqual(response.status_code, 401)
        self.assertIn("error", response.json)
        with self.client.get(self.url + "diagramma.png") as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.data, self.png)
            self.assertEqual(response.mimetype, "image/png")
            self.assertEqual(response.headers["Cache-Control"], "private, no-store")
            self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")

    def test_nested_paths_and_encoded_filenames(self):
        nested = self.directory / "sotto"
        nested.mkdir()
        (nested / "immagine uno.PNG").write_bytes(self.png)
        with self.client.get(self.url + "sotto/immagine%20uno.PNG") as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, "image/png")

    def test_missing_invalid_and_active_formats_return_json_errors(self):
        (self.directory / "pagina.html").write_text("<script>alert(1)</script>")
        (self.directory / "diagramma.svg").write_text("<svg/>")
        for filename, status in [
            ("assente.png", 404), ("pagina.html", 415), ("diagramma.svg", 415)
        ]:
            with self.subTest(filename=filename):
                response = self.client.get(self.url + filename)
                self.assertEqual(response.status_code, status)
                self.assertIn("error", response.json)
        self.assertEqual(
            self.client.get("/api/chats/non-valida/images/x.png").status_code, 400
        )

    def test_traversal_and_symlink_escapes_are_rejected(self):
        outside = Path(self.home.name) / "privata.png"
        outside.write_bytes(self.png)
        (self.directory / "link.png").symlink_to(outside)
        (self.directory.parent / "privata.png").write_bytes(self.png)
        for filename in ("../privata.png", "%2e%2e/privata.png", "link.png"):
            with self.subTest(filename=filename):
                response = self.client.get(self.url + filename)
                self.assertEqual(response.status_code, 404)
                self.assertIn("error", response.json)
        other_id = str(uuid.uuid4())
        (self.backend.SESSION_STATE_DIR / other_id).symlink_to(self.directory.parent)
        self.assertEqual(self.client.get(
            f"/api/chats/{other_id}/images/diagramma.png"
        ).status_code, 404)
        linked_id = str(uuid.uuid4())
        linked_session = self.backend.SESSION_STATE_DIR / linked_id
        linked_session.mkdir()
        (linked_session / "files").symlink_to(self.directory)
        self.assertEqual(self.client.get(
            f"/api/chats/{linked_id}/images/diagramma.png"
        ).status_code, 404)

    def test_prompt_uses_the_current_session_without_changing_permissions(self):
        prompt = self.backend.image_response_prompt("Crea un diagramma", self.chat_id)
        self.assertTrue(prompt.startswith("Crea un diagramma\n"))
        self.assertIn(str(self.directory), prompt)
        self.assertIn(self.url, prompt)
        self.assertIn("rispetta i permessi disponibili", prompt)

    def test_normal_and_streaming_replies_keep_images_in_history(self):
        for endpoint in ("/api/chat", "/api/chat/stream"):
            with self.subTest(endpoint=endpoint):
                chat_id = str(uuid.uuid4())
                response = self.client.post(endpoint, data={
                    "chat_id": chat_id, "message": "Crea un diagramma",
                    "permissions": '["shell"]', "advanced": "true",
                })
                self.assertEqual(response.status_code, 200)
                if endpoint.endswith("/stream"):
                    events = [
                        json.loads(line.removeprefix("data: "))
                        for line in response.get_data(as_text=True).splitlines()
                        if line.startswith("data: ")
                    ]
                    result = events[-1]
                    self.assertEqual(result["type"], "done")
                else:
                    result = response.json
                image_url = f"/api/chats/{chat_id}/images/risposta.png"
                self.assertEqual(result["reply"], f"![Diagramma]({image_url})")
                with self.client.get(image_url) as image:
                    self.assertEqual(image.status_code, 200)
                    self.assertEqual(image.data, self.png)
                history = self.client.get(f"/api/chats/{chat_id}").json
                self.assertEqual(history[0]["content"], "Crea un diagramma")
                self.assertEqual(history[1]["content"], result["reply"])
                native = (self.backend.SESSION_STATE_DIR / chat_id / "events.jsonl").read_text()
                self.assertIn("Interfaccia webchat", native)


if __name__ == "__main__":
    unittest.main()
