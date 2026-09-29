import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "skills/orchestration/personal-skills/scripts"))
import fleet  # noqa: E402


class ResolveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.skill = self.root / "skill"
        self.home = self.root / "home"
        self.skill.mkdir()
        self.home.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def make(self, path):
        path.mkdir(parents=True)
        return path

    def resolve(self, env, windows=False):
        return fleet.resolve(env={"HOME": str(self.home), **env}, skill_dir=self.skill, windows=windows)

    def test_env_wins_over_config_and_legacy(self):
        env_dir = self.make(self.root / "custom")
        self.make(self.home / ".config/loadout/fleet")
        self.make(self.skill / "fleet/local")
        self.assertEqual(self.resolve({"LOADOUT_FLEET": str(env_dir)}), ("env", env_dir))

    def test_missing_env_dir_is_an_error_not_a_fallback(self):
        self.make(self.skill / "fleet/local")
        with self.assertRaises(SystemExit):
            self.resolve({"LOADOUT_FLEET": str(self.root / "absent")})

    def test_xdg_config_home(self):
        xdg = self.make(self.root / "xdg/loadout/fleet")
        self.make(self.skill / "fleet/local")
        self.assertEqual(self.resolve({"XDG_CONFIG_HOME": str(self.root / "xdg")}), ("config", xdg))

    def test_default_config_dir(self):
        config = self.make(self.home / ".config/loadout/fleet")
        self.assertEqual(self.resolve({}), ("config", config))

    def test_windows_appdata(self):
        appdata = self.make(self.root / "AppData/Roaming/loadout/fleet")
        self.make(self.home / ".config/loadout/fleet")
        got = self.resolve({"APPDATA": str(self.root / "AppData/Roaming")}, windows=True)
        self.assertEqual(got, ("config", appdata))

    def test_legacy_fallback(self):
        legacy = self.make(self.skill / "fleet/local")
        self.assertEqual(self.resolve({}), ("legacy", legacy))

    def test_none(self):
        source = self.resolve({})
        self.assertEqual(source, ("none", None))
        self.assertEqual(fleet.describe(source), "fleet: none (current host only)")

    def test_describe_names_the_source(self):
        legacy = self.make(self.skill / "fleet/local")
        self.assertEqual(fleet.describe(self.resolve({})), f"fleet: legacy {legacy}")


if __name__ == "__main__":
    unittest.main()
