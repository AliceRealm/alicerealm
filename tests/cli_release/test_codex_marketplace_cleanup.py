"""Opt-in native Codex cleanup/reinstall regression; all state and Git are local."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.environ.get("ALICEREALM_TEST_CODEX"), "set ALICEREALM_TEST_CODEX to a native Codex CLI")
class CodexMarketplaceCleanup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ef marketplace cleanup ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.codex = str(Path(os.environ["ALICEREALM_TEST_CODEX"]).resolve(strict=True))
        self.home = self.root / "host home"
        self.home.mkdir()
        self.env = {
            "HOME": str(self.home), "USERPROFILE": str(self.home),
            "CODEX_HOME": str(self.home / ".codex"),
            "PATH": os.pathsep.join([str(Path(shutil.which("git")).parent), "/usr/bin", "/bin"]),
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
        }
        self.source = self.root / "official fixture"
        self.source.mkdir()
        manifest = self.source / ".agents/plugins/marketplace.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text(json.dumps({"name": "alicerealm", "plugins": [{
            "name": "codex-alicerealm", "source": {"source": "local", "path": "."},
            "policy": {"installation": "AVAILABLE", "authentication": "ON_USE"},
            "category": "Productivity",
        }]}))
        plugin = self.source / ".codex-plugin/plugin.json"
        plugin.parent.mkdir()
        plugin.write_text(json.dumps({"name": "codex-alicerealm", "version": "0.0.1"}))
        for args in (["init"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]):
            subprocess.run(["git", *args], cwd=self.source, env=self.env,
                           check=True, capture_output=True, timeout=15)
        # Download no external code. Redirect the canonical source to this local
        # catalog; allow only file transport so a missed rewrite fails closed.
        self.env.update({
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "url." + self.source.as_uri() + ".insteadOf",
            "GIT_CONFIG_VALUE_0": "https://github.com/GardenVilla/codex-alicerealm.git",
            "GIT_ALLOW_PROTOCOL": "file",
        })
        self.config = self.home / ".codex/config.toml"
        self.config.parent.mkdir()
        self.unrelated = 'model = "unchanged-model"\n[plugins."other@other"]\nenabled = false\n'
        self.config.write_text(self.unrelated)
        self.market = self.config.parent / ".tmp/marketplaces/alicerealm"
        self.other = self.config.parent / ".tmp/marketplaces/other/keep.txt"
        self.other.parent.mkdir(parents=True)
        self.other.write_text("unrelated marketplace")

    def call(self, *args, success=True):
        return self.run_command([self.codex, "plugin", "marketplace", *args], success=success)

    def run_command(self, args, success=True):
        result = subprocess.run(args,
                                cwd=self.root, env=self.env, capture_output=True,
                                text=True, stdin=subprocess.DEVNULL,
                                start_new_session=True, timeout=60)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def verify_remove_and_readd(self):
        self.call("remove", "alicerealm")
        self.assertFalse(self.market.exists())
        self.assertNotIn("[marketplaces.alicerealm]", self.config.read_text())
        self.assertIn('model = "unchanged-model"', self.config.read_text())
        self.assertIn('[plugins."other@other"]', self.config.read_text())
        self.assertEqual(self.other.read_text(), "unrelated marketplace")
        self.call("add", "GardenVilla/codex-alicerealm")
        self.assertIn("alicerealm", self.call("list").stdout)
        self.assertTrue((self.market / ".agents/plugins/marketplace.json").is_file())

    def test_registered_marketplace_removal_clears_installed_root(self):
        self.call("add", "GardenVilla/codex-alicerealm")
        self.verify_remove_and_readd()

    def test_orphan_hidden_from_list_still_needs_native_marketplace_removal(self):
        self.call("add", "GardenVilla/codex-alicerealm")
        # Reproduce removal of configuration without its installed checkout.
        self.config.write_text(self.unrelated)
        self.assertNotIn("alicerealm", self.call("list").stdout)
        rejected = self.call("add", "GardenVilla/codex-alicerealm", success=False)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("different source", rejected.stderr)
        self.verify_remove_and_readd()

    @unittest.skipUnless(os.name == "posix" and os.environ.get("ALICEREALM_TEST_CLI"),
                         "set ALICEREALM_TEST_CLI to a native AliceRealm CLI on POSIX")
    def test_complete_uninstall_then_reinstall(self):
        cli_source = str(Path(os.environ["ALICEREALM_TEST_CLI"]).resolve(strict=True))
        agent = self.home / "agent data/.alicerealm"
        target = self.home / ".agents/skills"
        binary = self.home / "bin/alicerealm"
        self.env.update({"ALICEREALM_HOME": str(agent), "ALICEREALM_SKILLS_DIR": str(target),
                         "CODEX_APP_RUNTIME_CLI_PATH": self.codex})

        # Execute the production host-setup functions with real native CLIs.
        # Omit OS notification setup and scheduling: these affect the logged-in
        # OS user even when HOME is isolated.
        source = (ROOT / "static/install.sh").read_text()
        gate = source[source.index("note_skipped_host() {"):source.index("# ── Step 1:")]
        setup = source[source.index("setup_codex_cli() {"):source.index("# ── Report install attribution")]
        harness = self.root / "setup.sh"
        harness.write_text('set -eu\ninfo() { printf "%s\\n" "$1"; }\n'
                           'ok() { printf "%s\\n" "$1"; }\nerr() { printf "%s\\n" "$1" >&2; }\n'
                           'INVOKING_HOST=codex\nSKIPPED_HOSTS=""\n' + gate + setup + '\nsetup_agents\n')

        def ef(*args):
            return self.run_command([str(binary), "--homedir", str(agent), "--format", "json", *args])

        def install():
            self.run_command([cli_source, "--homedir", str(agent), "installation", "replace",
                              "--destination", str(binary), "--host", "codex", "--skills-target", ""])
            ef("skills", "install", "--host", "codex", "--from-bundle", str(ROOT / "skills"))
            ef("installation", "record", "--host", "codex", "--skills-target", str(target))
            result = self.run_command(["sh", str(harness)])
            receipts = [json.loads(line) for line in result.stdout.splitlines()
                        if line.startswith('{"component":"codex-alicerealm"')]
            self.assertEqual(len(receipts), 1, result.stdout + result.stderr)
            self.assertEqual(receipts[0]["status"], "installed")
            self.assertEqual(receipts[0]["codex_path"], self.codex)
            self.assertEqual(receipts[0]["codex_home"], self.env["CODEX_HOME"])
            installed = self.run_command([self.codex, "plugin", "list", "--json"]).stdout
            self.assertIn('"codex-alicerealm@alicerealm"', installed)
            self.assertTrue((target / "ar-uninstall/SKILL.md").is_file())
            self.assertTrue(Path(str(binary) + ".uninstall.sh").is_file())

        def wrapper(*args):
            return self.run_command(["sh", str(binary) + ".uninstall.sh", str(binary),
                                     "--homedir", str(agent), "--scope", "all", "--source", "agent",
                                     "--format", "json", *args])

        install()
        unrelated_skill = target / "unrelated/SKILL.md"
        unrelated_skill.parent.mkdir()
        unrelated_skill.write_text("preserve unrelated Skill")
        owned = [entry["name"] for entry in json.loads((target / ".ef-manifest.json").read_text())["skills"]]
        for name in ("credentials.json", "identity.json", "cached-history.json", "scripts/owned.sh"):
            path = agent / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}")
        # Complete removal must also delete edited managed instructions.
        with (target / "ar-uninstall/SKILL.md").open("a") as output:
            output.write("\nlocal fixture edit\n")
        config_before = self.config.read_bytes()
        skill_before = (target / "ar-uninstall/SKILL.md").read_bytes()
        wrapper()
        self.assertEqual(self.config.read_bytes(), config_before)
        self.assertEqual((target / "ar-uninstall/SKILL.md").read_bytes(), skill_before)
        started = json.loads(wrapper("--begin").stdout)

        # Apply the Skill's ownership checks before the native removal commands.
        origin = self.run_command(["git", "-C", str(self.market), "config", "--get", "remote.origin.url"]).stdout.strip()
        self.assertEqual(origin, "https://github.com/GardenVilla/codex-alicerealm.git")
        catalog = json.loads((self.market / ".agents/plugins/marketplace.json").read_text())
        self.assertEqual([entry["name"] for entry in catalog["plugins"]], ["codex-alicerealm"])
        self.assertIn("GardenVilla/codex-alicerealm", self.config.read_text())
        self.run_command([self.codex, "plugin", "remove", "codex-alicerealm@alicerealm"])
        self.call("remove", "alicerealm")
        self.assertFalse(self.market.exists())
        self.assertNotIn("alicerealm", self.call("list").stdout)
        self.assertNotIn("codex-alicerealm", self.run_command([self.codex, "plugin", "list", "--json"]).stdout)
        result = json.loads(wrapper("--attempt", started["attempt_id"], "--apply", "--host-cleanup-confirmed").stdout)
        self.assertFalse(result.get("executable_removal_pending", False))
        for suffix in ("", ".install.json", ".uninstall.sh", ".uninstall.ps1"):
            self.assertFalse(Path(str(binary) + suffix).exists(), suffix)
        for name in owned:
            self.assertFalse((target / name).exists(), name)
        for name in ("credentials.json", "identity.json", "cached-history.json", "scripts/owned.sh", "uninstall.json"):
            self.assertFalse((agent / name).exists(), name)
        self.assertEqual(unrelated_skill.read_text(), "preserve unrelated Skill")
        self.assertEqual(self.other.read_text(), "unrelated marketplace")
        self.assertIn('model = "unchanged-model"', self.config.read_text())
        self.assertIn('[plugins."other@other"]', self.config.read_text())

        install()
        self.assertEqual(unrelated_skill.read_text(), "preserve unrelated Skill")
        self.assertEqual(self.other.read_text(), "unrelated marketplace")
        self.assertEqual((target / "ar-uninstall/SKILL.md").read_bytes(),
                         (ROOT / "skills/ar-uninstall/SKILL.md").read_bytes())


if __name__ == "__main__":
    unittest.main()
