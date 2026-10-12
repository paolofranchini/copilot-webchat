import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.fernet import Fernet


class DirectLineSettingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        spec = importlib.util.spec_from_file_location(
            "webchat_directline_tests", Path(__file__).resolve().parents[1] / "app.py"
        )
        cls.backend = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"HOME": cls.home.name}):
            spec.loader.exec_module(cls.backend)

    @classmethod
    def tearDownClass(cls):
        cls.home.cleanup()

    def setUp(self):
        self.backend.DIRECTLINE_SECRET_FILE.unlink(missing_ok=True)
        self.client = self.backend.app.test_client()
        with self.client.session_transaction() as browser:
            browser["authenticated"] = True

    def test_secret_is_encrypted_and_never_returned(self):
        secret = "a-direct-line-secret-that-must-not-be-returned"
        response = self.client.post(
            "/api/directline/settings",
            base_url="https://localhost",
            json={"secret": secret},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"ok": True, "configured": True})
        self.assertNotIn(secret, response.get_data(as_text=True))

        encrypted = self.backend.DIRECTLINE_SECRET_FILE.read_bytes()
        key = self.backend.DIRECTLINE_KEY_FILE.read_bytes()
        self.assertNotIn(secret.encode(), encrypted)
        self.assertEqual(Fernet(key).decrypt(encrypted).decode(), secret)
        self.assertEqual(self.backend.DIRECTLINE_DIR.stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.backend.DIRECTLINE_KEY_FILE.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.backend.DIRECTLINE_SECRET_FILE.stat().st_mode & 0o777, 0o600)

        status = self.client.get("/api/directline/settings")
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json, {"configured": True})
        self.assertEqual(status.headers["Cache-Control"], "private, no-store")
        self.assertNotIn(secret, status.get_data(as_text=True))

    def test_secret_write_and_removal_require_https(self):
        write = self.client.post(
            "/api/directline/settings", json={"secret": "secret-value"}
        )
        remove = self.client.delete("/api/directline/settings")
        self.assertEqual(write.status_code, 400)
        self.assertEqual(remove.status_code, 400)
        self.assertFalse(self.backend.DIRECTLINE_SECRET_FILE.exists())

    def test_invalid_secret_is_rejected(self):
        for payload in ({}, {"secret": "  "}, {"secret": "x" * 4097}, []):
            with self.subTest(payload_type=type(payload).__name__):
                response = self.client.post(
                    "/api/directline/settings",
                    base_url="https://localhost",
                    json=payload,
                )
                self.assertEqual(response.status_code, 400)
        self.assertFalse(self.backend.DIRECTLINE_SECRET_FILE.exists())

    def test_remove_secret_and_authentication(self):
        anonymous = self.backend.app.test_client()
        self.assertEqual(
            anonymous.get("/api/directline/settings").status_code, 401
        )
        self.client.post(
            "/api/directline/settings",
            base_url="https://localhost",
            json={"secret": "secret-value"},
        )
        response = self.client.delete(
            "/api/directline/settings", base_url="https://localhost"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"ok": True, "configured": False})
        self.assertFalse(self.backend.DIRECTLINE_SECRET_FILE.exists())


if __name__ == "__main__":
    unittest.main()
