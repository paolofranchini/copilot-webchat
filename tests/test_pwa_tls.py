import importlib.util
import json
import os
import shutil
import ssl
import subprocess
import tempfile
import threading
import urllib.error
import urllib.request
import unittest
from pathlib import Path
from unittest.mock import patch


class PwaTlsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        spec = importlib.util.spec_from_file_location(
            "webchat_pwa_tls_tests", Path(__file__).resolve().parents[1] / "app.py"
        )
        cls.backend = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"HOME": cls.home.name}):
            spec.loader.exec_module(cls.backend)
        cls.tls_dir = Path(cls.home.name) / "tls"
        cls.ca_cert = cls.tls_dir / "ca.crt"
        cls.backend.TLS_CA_CERT = cls.ca_cert

    @classmethod
    def tearDownClass(cls):
        cls.home.cleanup()

    def setUp(self):
        self.client = self.backend.app.test_client()
        with self.client.session_transaction() as browser:
            browser["authenticated"] = True

    def test_manifest_and_icons_define_standalone_app(self):
        with self.client.get("/manifest.webmanifest") as manifest_response:
            self.assertEqual(manifest_response.status_code, 200)
            manifest = json.loads(manifest_response.get_data(as_text=True))
        self.assertEqual(manifest["display"], "standalone")
        self.assertEqual(manifest["start_url"], "/")
        self.assertIn(
            {"src": "/icon-maskable-512.png", "sizes": "512x512",
             "type": "image/png", "purpose": "maskable"},
            manifest["icons"],
        )

    def test_install_assets_are_public_even_before_login(self):
        anonymous = self.backend.app.test_client()
        paths = (
            ("/manifest.webmanifest", "application/manifest+json"),
            ("/pwa.js", "text/javascript"),
            ("/service-worker.js", "text/javascript"),
            ("/icon-180.png", "image/png"),
            ("/icon-192.png", "image/png"),
            ("/icon-512.png", "image/png"),
            ("/icon-maskable-512.png", "image/png"),
        )
        for path, mimetype in paths:
            with self.subTest(path=path):
                with anonymous.get(path) as response:
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.mimetype, mimetype)

        with anonymous.get("/") as response:
            self.assertIn(b"/manifest.webmanifest", response.data)

    def test_ca_download_requires_login_and_never_serves_private_key(self):
        self.tls_dir.mkdir(parents=True, exist_ok=True)
        self.ca_cert.write_text("public CA certificate")
        (self.tls_dir / "ca.key").write_text("private CA key")
        anonymous = self.backend.app.test_client()
        self.assertEqual(anonymous.get("/api/tls/ca").status_code, 401)
        with self.client.get("/api/tls/ca") as response:
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_data(as_text=True), "public CA certificate")
            self.assertEqual(response.headers["Cache-Control"], "private, no-store")
            self.assertIn("attachment", response.headers["Content-Disposition"])
            self.assertNotIn("private CA key", response.get_data(as_text=True))

    def test_ca_download_reports_when_certificate_is_unavailable(self):
        self.backend.TLS_CA_CERT = self.tls_dir / "missing.crt"
        response = self.client.get("/api/tls/ca")
        self.assertEqual(response.status_code, 503)
        self.assertIn("error", response.json)
        self.backend.TLS_CA_CERT = self.ca_cert

    @unittest.skipUnless(shutil.which("openssl"), "OpenSSL non installato")
    def test_local_ca_signs_private_server_certificate(self):
        names = ["DNS:raspberrypi", "IP:100.117.226.37"]
        tls_dir = self.tls_dir / "generated"
        ca_cert, server_cert, server_key = self.backend.ensure_tls_certificates(
            tls_dir, names
        )
        ca_before = ca_cert.read_bytes()
        self.assertEqual(tls_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual((tls_dir / "ca.key").stat().st_mode & 0o777, 0o600)
        self.assertEqual(server_key.stat().st_mode & 0o777, 0o600)

        result = subprocess.run(
            [
                shutil.which("openssl"), "verify", "-purpose", "sslserver",
                "-CAfile", str(ca_cert), str(server_cert),
            ],
            capture_output=True, text=True, check=True,
        )
        self.assertIn("OK", result.stdout)
        result = subprocess.run(
            [
                shutil.which("openssl"), "x509", "-in", str(server_cert),
                "-noout", "-ext", "subjectAltName",
            ],
            capture_output=True, text=True, check=True,
        )
        self.assertIn("DNS:raspberrypi", result.stdout)
        self.assertIn("IP Address:100.117.226.37", result.stdout)

        self.backend.ensure_tls_certificates(tls_dir, names)
        self.assertEqual(ca_cert.read_bytes(), ca_before)
        self.assertTrue((tls_dir / "ca.srl").is_file())

        server = self.backend.make_server(
            "127.0.0.1", 0, self.backend.app, threaded=True,
            ssl_context=(str(server_cert), str(server_key)),
        )
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            url = f"https://127.0.0.1:{server.server_port}/api/tls/ca"
            context = ssl.create_default_context(cafile=str(ca_cert))
            with self.assertRaises(urllib.error.HTTPError) as result:
                urllib.request.urlopen(url, context=context, timeout=3)
            self.assertEqual(result.exception.code, 401)
            result.exception.close()
        finally:
            server.shutdown()
            worker.join(timeout=3)
            server.server_close()


if __name__ == "__main__":
    unittest.main()
