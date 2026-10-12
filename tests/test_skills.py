from copy import deepcopy
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


class SkillPluginSettingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        spec = importlib.util.spec_from_file_location(
            "webchat_skill_tests", Path(__file__).resolve().parents[1] / "app.py"
        )
        cls.backend = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {"HOME": cls.home.name}):
            spec.loader.exec_module(cls.backend)
        cls.backend.COPILOT_BIN = "/copilot"
    @classmethod
    def tearDownClass(cls):
        cls.home.cleanup()

    def setUp(self):
        self.states = deepcopy({
            "skills": [
                {"name": "web-tests", "description": "Run web tests",
                 "source": "personal-copilot", "enabled": True},
                {"name": "builtin-example", "description": "Built in",
                 "source": "builtin", "enabled": True},
            ],
            "plugins": [
                {"name": "docs@marketplace", "description": "Documentation helpers",
                 "source": "marketplace", "enabled": True},
            ],
        })
        self.added_sources = []
        self.client = self.backend.app.test_client()
        with self.client.session_transaction() as browser:
            browser["authenticated"] = True

    def run_cli(self, command, *args, **kwargs):
        if command[1:3] == ["skill", "add"]:
            self.added_sources.append(command[3])
            return self.backend.subprocess.CompletedProcess(command, 0, "Skill aggiunta", "")
        if command[1:3] == ["skill", "remove"]:
            self.states["skills"] = [
                entry for entry in self.states["skills"]
                if entry["name"] != command[3]
            ]
            return self.backend.subprocess.CompletedProcess(command, 0, "", "")
        if command[1:3] == ["skill", "list"]:
            output = self.states["skills"]
        elif command[1:3] == ["plugin", "list"]:
            output = self.states["plugins"]
        elif command[1] in {"skill", "plugin"} and command[2] in {"enable", "disable"}:
            kind = f"{command[1]}s"
            entry = next(
                entry for entry in self.states[kind] if entry["name"] == command[3]
            )
            entry["enabled"] = command[2] == "enable"
            return self.backend.subprocess.CompletedProcess(command, 0, "", "")
        else:
            raise AssertionError(f"Comando CLI inatteso: {command}")
        return self.backend.subprocess.CompletedProcess(
            command, 0, json.dumps(output), ""
        )

    def test_listing_includes_cli_enabled_state(self):
        with patch.object(self.backend.subprocess, "run", side_effect=self.run_cli):
            response = self.client.get("/api/skills")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["skills"][0]["enabled"])
        self.assertTrue(response.json["skills"][0]["removable"])
        self.assertFalse(response.json["skills"][1]["removable"])
        self.assertEqual(response.json["plugins"][0]["name"], "docs@marketplace")

    def test_skill_and_plugin_toggles_use_native_cli_and_persist(self):
        with patch.object(self.backend.subprocess, "run", side_effect=self.run_cli) as run:
            skill = self.client.put("/api/skills/state", json={
                "kind": "skills", "name": "web-tests", "enabled": False,
            })
            self.assertEqual(skill.status_code, 200)
            self.assertFalse(skill.json["enabled"])
            self.assertIn(
                ["/copilot", "skill", "disable", "web-tests"],
                [call.args[0] for call in run.call_args_list],
            )

            plugin = self.client.put("/api/skills/state", json={
                "kind": "plugins", "name": "docs@marketplace", "enabled": False,
            })
            self.assertEqual(plugin.status_code, 200)
            self.assertFalse(plugin.json["enabled"])
            self.assertIn(
                ["/copilot", "plugin", "disable", "docs@marketplace"],
                [call.args[0] for call in run.call_args_list],
            )

            listing = self.client.get("/api/skills")
        self.assertFalse(listing.json["skills"][0]["enabled"])
        self.assertFalse(listing.json["plugins"][0]["enabled"])

    def test_add_skill_supports_https_url_and_absolute_server_path(self):
        with patch.object(self.backend.subprocess, "run", side_effect=self.run_cli) as run:
            url = "https://example.org/skills/sample/SKILL.md"
            response = self.client.post("/api/skills/add", json={"source": url})
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json["ok"])

            path = "/tmp/my custom skill/SKILL.md"
            response = self.client.post("/api/skills/add", json={"source": path})
            self.assertEqual(response.status_code, 200)

        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(commands, [
            ["/copilot", "skill", "add", url],
            ["/copilot", "skill", "add", path],
        ])
        self.assertTrue(all(
            call.kwargs["stdin"] is self.backend.subprocess.DEVNULL
            for call in run.call_args_list
        ))

    def test_add_skill_rejects_invalid_sources_and_requires_login(self):
        anonymous = self.backend.app.test_client()
        self.assertEqual(
            anonymous.post("/api/skills/add", json={
                "source": "https://example.org/SKILL.md",
            }).status_code,
            401,
        )
        with patch.object(self.backend.subprocess, "run") as run:
            invalid_body = self.client.post(
                "/api/skills/add", json=["not", "an object"]
            )
            self.assertEqual(invalid_body.status_code, 400)
            for source in (
                "",
                "relative/SKILL.md",
                "http://example.org/SKILL.md",
                "https://example.org/README.md",
                "https://user:secret@example.org/SKILL.md",
                "https://example.org/SKILL.md#fragment",
                "/tmp/SKILL.md\n--project",
                "x" * 2049,
                42,
            ):
                with self.subTest(source=source):
                    response = self.client.post(
                        "/api/skills/add", json={"source": source}
                    )
                    self.assertEqual(response.status_code, 400)
            run.assert_not_called()

    def test_add_skill_reports_cli_failures_and_timeout(self):
        with patch.object(
            self.backend.subprocess, "run",
            return_value=self.backend.subprocess.CompletedProcess(
                [], 1, "", "skill non attendibile"
            ),
        ):
            failed = self.client.post("/api/skills/add", json={
                "source": "https://example.org/SKILL.md",
            })
        self.assertEqual(failed.status_code, 500)
        self.assertIn("skill non attendibile", failed.json["error"])

        with patch.object(
            self.backend.subprocess, "run",
            side_effect=self.backend.subprocess.TimeoutExpired("copilot", 120),
        ):
            timeout = self.client.post("/api/skills/add", json={
                "source": "https://example.org/SKILL.md",
            })
        self.assertEqual(timeout.status_code, 504)

    def test_remove_personal_skill_and_verify_removal(self):
        with patch.object(self.backend.subprocess, "run", side_effect=self.run_cli) as run:
            response = self.client.post("/api/skills/remove", json={
                "name": "web-tests",
            })
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json["ok"])
        self.assertEqual(
            run.call_args_list[2].args[0],
            ["/copilot", "skill", "remove", "web-tests"],
        )
        self.assertNotIn(
            "web-tests", [entry["name"] for entry in self.states["skills"]]
        )

    def test_remove_rejects_non_personal_and_unknown_skills(self):
        with patch.object(self.backend.subprocess, "run", side_effect=self.run_cli) as run:
            builtin = self.client.post("/api/skills/remove", json={
                "name": "builtin-example",
            })
            missing = self.client.post("/api/skills/remove", json={
                "name": "not-installed",
            })
        self.assertEqual(builtin.status_code, 403)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(run.call_count, 4)
        self.assertFalse(any(
            call.args[0][1:3] == ["skill", "remove"]
            for call in run.call_args_list
        ))

    def test_remove_requires_login_and_reports_cli_errors(self):
        anonymous = self.backend.app.test_client()
        self.assertEqual(anonymous.post("/api/skills/remove", json={
            "name": "web-tests",
        }).status_code, 401)
        with patch.object(
            self.backend.subprocess, "run",
            side_effect=[
                self.backend.subprocess.CompletedProcess(
                    [], 0, json.dumps(self.states["skills"]), ""
                ),
                self.backend.subprocess.CompletedProcess(
                    [], 0, json.dumps(self.states["plugins"]), ""
                ),
                self.backend.subprocess.CompletedProcess(
                    [], 1, "", "rimozione negata"
                ),
            ],
        ):
            response = self.client.post("/api/skills/remove", json={
                "name": "web-tests",
            })
        self.assertEqual(response.status_code, 500)
        self.assertIn("rimozione negata", response.json["error"])

    def test_toggle_requires_login_and_valid_existing_entry(self):
        anonymous = self.backend.app.test_client()
        self.assertEqual(anonymous.put("/api/skills/state", json={
            "kind": "skills", "name": "web-tests", "enabled": False,
        }).status_code, 401)
        for payload in (
            {"kind": [], "name": "web-tests", "enabled": False},
            {"kind": "other", "name": "web-tests", "enabled": False},
            {"kind": "skills", "name": "web-tests", "enabled": 0},
            {"kind": "skills", "name": "", "enabled": False},
        ):
            with self.subTest(payload=payload):
                response = self.client.put("/api/skills/state", json=payload)
                self.assertEqual(response.status_code, 400)
        with patch.object(self.backend.subprocess, "run", side_effect=self.run_cli):
            missing = self.client.put("/api/skills/state", json={
                "kind": "skills", "name": "unlisted", "enabled": False,
            })
        self.assertEqual(missing.status_code, 404)

    def test_cli_rejection_is_returned_without_claiming_success(self):
        with patch.object(
            self.backend.subprocess, "run",
            side_effect=[
                self.backend.subprocess.CompletedProcess(
                    [], 0, json.dumps(self.states["skills"]), ""
                ),
                self.backend.subprocess.CompletedProcess(
                    [], 0, json.dumps(self.states["plugins"]), ""
                ),
                self.backend.subprocess.CompletedProcess(
                    [], 1, "", "managed by organization"
                ),
            ],
        ):
            response = self.client.put("/api/skills/state", json={
                "kind": "skills", "name": "web-tests", "enabled": False,
            })
        self.assertEqual(response.status_code, 500)
        self.assertIn("managed by organization", response.json["error"])

    def test_cli_listing_failure_returns_json_error(self):
        with patch.object(
            self.backend.subprocess, "run",
            side_effect=FileNotFoundError("copilot non disponibile"),
        ):
            response = self.client.get("/api/skills")
        self.assertEqual(response.status_code, 500)
        self.assertIn("error", response.json)


if __name__ == "__main__":
    unittest.main()
