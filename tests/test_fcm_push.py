import base64
import importlib.util
import json
import os
import tempfile
import time
import unittest
from urllib.parse import parse_qs
import uuid
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


class FcmPushTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        spec = importlib.util.spec_from_file_location(
            "webchat_fcm_push_tests",
            Path(__file__).resolve().parents[1] / "app.py",
        )
        cls.backend = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"HOME": cls.home.name}):
            spec.loader.exec_module(cls.backend)
        cls.backend.app.config["TESTING"] = True
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.credentials_path = Path(cls.home.name) / "service-account.json"
        cls.write_credentials()

    @classmethod
    def write_credentials(cls):
        cls.credentials_path.write_text(json.dumps({
            "type": "service_account",
            "project_id": "webchat-test",
            "client_email": "webchat@test.iam.gserviceaccount.com",
            "private_key": cls.key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            ).decode("ascii"),
            "token_uri": cls.backend.FCM_OAUTH_TOKEN_URL,
        }))
        cls.credentials_path.chmod(0o600)

    @classmethod
    def tearDownClass(cls):
        cls.home.cleanup()

    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "GOOGLE_APPLICATION_CREDENTIALS": str(self.credentials_path),
        })
        self.environment.start()
        self.backend.FCM_ACCESS_TOKEN_CACHE = None
        with self.backend.app.app_context():
            db = self.backend.get_db()
            db.execute("DELETE FROM android_push_tokens")
            db.execute("DELETE FROM chat_jobs")
            db.commit()
        self.client = self.backend.app.test_client()
        with self.client.session_transaction() as browser:
            browser["authenticated"] = True

    def tearDown(self):
        self.environment.stop()

    def register(self, token="test-fcm-device-token"):
        return self.client.post(
            "/api/push/android/register", json={"token": token},
            base_url="https://localhost",
        )

    def test_push_api_requires_login_and_reports_configuration(self):
        unauthenticated = self.backend.app.test_client()
        self.assertEqual(
            unauthenticated.get("/api/push/android/status").status_code, 401
        )
        response = self.client.get("/api/push/android/status")
        self.assertEqual(response.json, {"configured": True})

    def test_register_encrypts_tokens_and_unregisters_by_token(self):
        token = "test-fcm-device-token"
        response = self.register(token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"registered": True})
        self.assertNotIn(token, response.get_data(as_text=True))
        with self.backend.app.app_context():
            row = self.backend.get_db().execute(
                "SELECT token_hash, token_enc FROM android_push_tokens"
            ).fetchone()
            self.assertNotIn(token, row["token_enc"])
            self.assertEqual(
                self.backend.fcm_token_cipher().decrypt(
                    row["token_enc"].encode("ascii")
                ).decode("utf-8"),
                token,
            )
        self.assertEqual(
            self.client.get("/api/push/android/status").json,
            {"configured": True},
        )
        removed = self.client.post(
            "/api/push/android/unregister", json={"token": token},
            base_url="https://localhost",
        )
        self.assertEqual(removed.json, {"registered": False})

    def test_registration_requires_fcm_configuration_and_valid_token(self):
        with patch.dict(os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": ""}):
            response = self.register()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json["error"], "FCM non configurato sul server")
        self.assertEqual(
            self.client.post(
                "/api/push/android/register", json={"token": "bad\nvalue"},
                base_url="https://localhost",
            ).status_code,
            400,
        )
        self.assertEqual(
            self.client.post(
                "/api/push/android/register",
                json={"token": "valid-token"},
                base_url="http://localhost",
            ).status_code,
            400,
        )

    def test_notification_uses_oauth_and_contains_no_conversation_text(self):
        token = "test-fcm-device-token"
        self.assertEqual(self.register(token).status_code, 200)
        captured = []

        class Response:
            def __init__(self, content):
                self.content = content

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return self.content

        def urlopen(request, timeout):
            self.assertEqual(timeout, 15)
            captured.append(request)
            if request.full_url == self.backend.FCM_OAUTH_TOKEN_URL:
                return Response(b'{"access_token":"oauth-access","expires_in":3600}')
            return Response(b'{"name":"projects/webchat-test/messages/1"}')

        with patch.object(self.backend.urllib.request, "urlopen", side_effect=urlopen):
            with self.backend.app.app_context():
                self.backend.send_android_push_notifications(
                    "chat-123",
                    {
                        "type": "done",
                        "reply": "testo privato della conversazione",
                    },
                )
        self.assertEqual(len(captured), 2)
        oauth_fields = parse_qs(captured[0].data.decode("ascii"))
        self.assertEqual(
            oauth_fields["grant_type"][0],
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
        )
        assertion = oauth_fields["assertion"][0]
        header, claims, signature = assertion.split(".")
        self.key.public_key().verify(
            base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4)),
            f"{header}.{claims}".encode("ascii"),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
        jwt_claims = json.loads(
            base64.urlsafe_b64decode(claims + "=" * (-len(claims) % 4))
        )
        self.assertEqual(jwt_claims["scope"], self.backend.FCM_MESSAGING_SCOPE)
        self.assertEqual(jwt_claims["aud"], self.backend.FCM_OAUTH_TOKEN_URL)
        payload = json.loads(captured[1].data)
        message = payload["message"]
        self.assertEqual(message["token"], token)
        self.assertEqual(message["data"], {"chat_id": "chat-123", "type": "response"})
        self.assertNotIn("testo privato", captured[1].data.decode("utf-8"))
        self.assertEqual(message["notification"]["body"], "Una risposta è pronta.")

    def test_unregistered_token_is_removed_but_transient_failure_is_kept(self):
        self.assertEqual(self.register().status_code, 200)
        with patch.object(
            self.backend, "load_fcm_service_account", return_value=()
        ), patch.object(
            self.backend, "fcm_access_token", return_value=("access", "project")
        ), patch.object(
            self.backend,
            "send_fcm_message",
            side_effect=self.backend.FCMUnregisteredToken(404, "UNREGISTERED"),
        ):
            with self.backend.app.app_context():
                self.backend.send_android_push_notifications(
                    "chat-123", {"type": "done"}
                )
        with self.backend.app.app_context():
            count = self.backend.get_db().execute(
                "SELECT count(*) FROM android_push_tokens"
            ).fetchone()[0]
        self.assertEqual(count, 0)

        self.assertEqual(self.register("another-device-token").status_code, 200)
        with patch.object(
            self.backend, "load_fcm_service_account", return_value=()
        ), patch.object(
            self.backend, "fcm_access_token", return_value=("access", "project")
        ), patch.object(
            self.backend,
            "send_fcm_message",
            side_effect=self.backend.FCMDeliveryError(503, "UNAVAILABLE"),
        ):
            with self.backend.app.app_context():
                self.backend.send_android_push_notifications(
                    "chat-123", {"type": "done"}
                )
        with self.backend.app.app_context():
            count = self.backend.get_db().execute(
                "SELECT count(*) FROM android_push_tokens"
            ).fetchone()[0]
        self.assertEqual(count, 1)

    def test_completed_async_job_triggers_push_once(self):
        job_id, chat_id = str(uuid.uuid4()), str(uuid.uuid4())
        events = lambda: iter([
            "data: " + json.dumps({"type": "done", "chat_id": chat_id}) + "\n\n"
        ])
        with patch.object(
            self.backend, "send_android_push_notifications"
        ) as send_push:
            with self.backend.app.app_context():
                response, status_code = self.backend.create_chat_job(
                    {"request_id": job_id}, chat_id, events, (), ()
                )
            self.assertEqual(status_code, 202)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with self.backend.app.app_context():
                    row = self.backend.get_db().execute(
                        "SELECT status FROM chat_jobs WHERE id = ?", (job_id,)
                    ).fetchone()
                if row["status"] != "running":
                    break
                time.sleep(0.01)
            self.assertEqual(row["status"], "done")
            send_push.assert_called_once_with(
                chat_id, {"type": "done", "chat_id": chat_id}
            )


if __name__ == "__main__":
    unittest.main()
