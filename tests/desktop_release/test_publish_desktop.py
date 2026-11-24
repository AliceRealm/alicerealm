import importlib.util
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "publish_desktop", ROOT / "scripts" / "release" / "publish-desktop.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class PublishDesktopTest(unittest.TestCase):
    def make_stage(self, version="0.2.2"):
        temporary = tempfile.TemporaryDirectory()
        stage = Path(temporary.name)
        installer = stage / f"AliceRealm_{version}_x64-setup.exe"
        signature = Path(f"{installer}.sig")
        installer.write_bytes(b"installer")
        signature.write_text("trusted-signature", encoding="utf-8")
        (stage / "version.txt").write_text(f"{version}\n", encoding="ascii")
        (stage / "latest.json").write_text(
            json.dumps(
                {
                    "version": version,
                    "platforms": {
                        "windows-x86_64-nsis": {
                            "url": f"https://updates.alicerealm.com/desktop/windows/{version}/{installer.name}",
                            "signature": "trusted-signature",
                        }
                    },
                }
            ),
            encoding="utf-8",
        )
        return temporary, stage

    def test_validates_a_consistent_signed_release(self):
        temporary, stage = self.make_stage()
        self.addCleanup(temporary.cleanup)
        release = MODULE.load_release(stage)
        self.assertEqual(release.version, "0.2.2")
        self.assertEqual(release.installer.suffix, ".exe")

    def test_rejects_manifest_signature_mismatch(self):
        temporary, stage = self.make_stage()
        self.addCleanup(temporary.cleanup)
        metadata = json.loads((stage / "latest.json").read_text(encoding="utf-8"))
        metadata["platforms"]["windows-x86_64-nsis"]["signature"] = "tampered"
        (stage / "latest.json").write_text(json.dumps(metadata), encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "signature mismatch"):
            MODULE.load_release(stage)

    def test_loads_ci_credentials_from_environment(self):
        with mock.patch.dict(
            MODULE.os.environ,
            {
                "R2_ACCESS_KEY_ID": "ci-access",
                "R2_SECRET_ACCESS_KEY": "ci-secret",
            },
            clear=True,
        ):
            self.assertEqual(
                MODULE.load_credentials(None), ("ci-access", "ci-secret")
            )

    def test_local_secret_files_override_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            secrets = Path(temporary)
            (secrets / "r2_access_key_id.txt").write_text(
                "local-access\n", encoding="utf-8"
            )
            (secrets / "r2_secret_access_key.txt").write_text(
                "local-secret\n", encoding="utf-8"
            )
            with mock.patch.dict(
                MODULE.os.environ,
                {
                    "R2_ACCESS_KEY_ID": "ci-access",
                    "R2_SECRET_ACCESS_KEY": "ci-secret",
                },
            ):
                self.assertEqual(
                    MODULE.load_credentials(secrets),
                    ("local-access", "local-secret"),
                )


if __name__ == "__main__":
    unittest.main()
