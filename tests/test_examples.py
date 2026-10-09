import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


class MarketplaceTest(unittest.TestCase):
    def test_every_portable_skill_is_in_exactly_one_plugin(self):
        market = json.loads((REPO / ".claude-plugin/marketplace.json").read_text())
        manifest = json.loads((REPO / "MANIFEST.json").read_text())
        published = {e["path"].split("/")[1] + "/" + e["skill"] for e in manifest["files"]}
        listed = [path.removeprefix("./skills/") for plugin in market["plugins"] for path in plugin["skills"]]
        self.assertEqual(len(listed), len(set(listed)), "a skill is listed twice")
        # personal-skills runs from a clone with a private fleet, so it is not a marketplace plugin.
        self.assertEqual(set(listed), published - {"orchestration/personal-skills"})
        for plugin in market["plugins"]:
            self.assertTrue(plugin["name"].startswith("loadout-"))
            self.assertEqual(plugin["source"], "./")
            for path in plugin["skills"]:
                self.assertTrue((REPO / path / "SKILL.md").is_file(), path)
        self.assertEqual(len({p["version"] for p in market["plugins"]}), 1, "plugins share one release version")


class FleetDemoTest(unittest.TestCase):
    def test_demo_runs_offline_and_shows_the_conflict(self):
        if not shutil.which("node"):
            self.skipTest("node is required")
        done = subprocess.run([sys.executable, str(REPO / "examples/fleet_demo.py")], capture_output=True,
                              text=True, timeout=300)
        self.assertEqual(done.returncode, 0, done.stderr)
        out = done.stdout
        self.assertIn("desktop: skills updated", out)
        self.assertIn("desktop: skills conflict: local edits, nothing written: claude:grilling/SKILL.md", out)
        self.assertEqual(out.count("desktop: skills same"), 2, out)
        self.assertNotIn("'pake'", out.splitlines()[-1])


if __name__ == "__main__":
    unittest.main()
