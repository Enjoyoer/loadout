import datetime
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
import check_daemon_env  # noqa: E402

BUNDLE_REL = "plugins/usage-limit-auto-resume/dist/pace-read.mjs"
ADJACENT_REL = "plugins/usage-limit-auto-resume/dist/other.mjs"
SUSPECT = 'export const home = process.env.PASEO_HOME || ".paseo";\n'


class CheckDaemonEnvTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args: str) -> None:
        subprocess.run(
            ["git", "-C", str(self.repo), *args],
            check=True,
            capture_output=True,
            text=True,
        )

    def init_repo(self, gitignore: str = "plugins/usage-limit-auto-resume/dist/\n") -> None:
        self.git("init")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        if gitignore is not None:
            (self.repo / ".gitignore").write_text(gitignore, encoding="utf-8")
            self.git("add", ".gitignore")
            self.git("commit", "-m", "init")

    def write_rel(self, rel: str, text: str) -> Path:
        target = self.repo / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        return target

    def test_generated_ignored_untracked_bundle_passes(self):
        self.init_repo()
        real_bundle = REPO / BUNDLE_REL
        target = self.repo / BUNDLE_REL
        target.parent.mkdir(parents=True, exist_ok=True)
        if real_bundle.is_file():
            shutil.copyfile(real_bundle, target)
        else:
            target.write_text(SUSPECT, encoding="utf-8")
        self.assertEqual(check_daemon_env.problems(datetime.date.today(), root=self.repo), [])

    def test_force_added_and_committed_exact_path_fails(self):
        self.init_repo()
        self.write_rel(BUNDLE_REL, SUSPECT)
        self.git("add", "-f", BUNDLE_REL)
        staged = check_daemon_env.problems(datetime.date.today(), root=self.repo)
        self.assertEqual(len(staged), 1)
        self.assertTrue(staged[0].startswith(f"{BUNDLE_REL}:1:"), staged)

        self.git("commit", "-m", "track handwritten file at bundle path")
        committed = check_daemon_env.problems(datetime.date.today(), root=self.repo)
        self.assertEqual(len(committed), 1)
        self.assertTrue(committed[0].startswith(f"{BUNDLE_REL}:1:"), committed)

    def test_adjacent_dist_path_fails_ignored_and_force_added(self):
        self.init_repo()
        self.write_rel(ADJACENT_REL, SUSPECT)
        ignored_hits = check_daemon_env.problems(datetime.date.today(), root=self.repo)
        self.assertEqual(len(ignored_hits), 1)
        self.assertTrue(ignored_hits[0].startswith(f"{ADJACENT_REL}:1:"), ignored_hits)

        self.git("add", "-f", ADJACENT_REL)
        staged_hits = check_daemon_env.problems(datetime.date.today(), root=self.repo)
        self.assertEqual(len(staged_hits), 1)
        self.assertTrue(staged_hits[0].startswith(f"{ADJACENT_REL}:1:"), staged_hits)

    def test_unignored_exact_path_and_unknown_git_state_fail_closed(self):
        # Not a git checkout -> unknown Git state must fail closed.
        self.write_rel(BUNDLE_REL, SUSPECT)
        unknown = check_daemon_env.problems(datetime.date.today(), root=self.repo)
        self.assertEqual(len(unknown), 1)
        self.assertTrue(unknown[0].startswith(f"{BUNDLE_REL}:1:"), unknown)

        # Git checkout where the path is NOT ignored -> must fail.
        self.init_repo(gitignore="")
        unignored = check_daemon_env.problems(datetime.date.today(), root=self.repo)
        self.assertEqual(len(unignored), 1)
        self.assertTrue(unignored[0].startswith(f"{BUNDLE_REL}:1:"), unignored)


if __name__ == "__main__":
    unittest.main()
