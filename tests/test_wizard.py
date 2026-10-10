import os
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TEMPLATE = REPO / "skills/operations-integrations/wizard/template.sh"

# Always authenticated; logs every other call, and what a secret write read on stdin.
FAKE_GH = """#!/bin/sh
[ "$1" = auth ] && exit 0
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = secret ]; then cat >> "$GH_LOG"; echo >> "$GH_LOG"; fi
exit 0
"""

KEY_STAGE = 'ask_secret API_KEY "Paste the key:"\nwrite_env API_KEY "$API_KEY"\nset_secret API_KEY "$API_KEY"'


@unittest.skipIf(os.name == "nt", "the wizard is a bash script")
class WizardTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(os.path.realpath(tmp.name))
        self.project = self.base / "project-a"
        self.project.mkdir()
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        (bin_dir / "gh").write_text(FAKE_GH)
        (bin_dir / "gh").chmod(0o755)
        self.gh_log = self.base / "gh.log"
        self.env = {**os.environ, "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "GH_LOG": str(self.gh_log)}
        self.env.pop("ENV_FILE", None)

    def run_wizard(self, cwd, answers, stages):
        # Generated for project-a and saved outside it, as a scratch wizard is.
        library = TEMPLATE.read_text().split("# STAGES:")[0]
        script = self.base / "wizard.sh"
        script.write_text(library + "\n".join([
            "TOTAL_STAGES=1",
            f"PROJECT_ROOT={shlex.quote(str(self.project))}",
            "GITHUB_REPO=octo/project-a",
            'banner "Test setup"',
            'stage "Keys"',
            stages,
            "finish",
        ]) + "\n")
        return subprocess.run(["bash", str(script)], cwd=cwd, input=answers, env=self.env, capture_output=True,
                              text=True, timeout=60)

    def test_writes_only_the_project_and_repository_it_was_generated_for(self):
        # Run from another project, it once wrote that project's .env and its same-named GitHub secret.
        other = self.base / "project-b"
        other.mkdir()
        (other / ".env").write_text("API_KEY=b-own-key\n")
        done = self.run_wizard(other, "\nkey-for-a\n", KEY_STAGE)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertEqual((other / ".env").read_text(), "API_KEY=b-own-key\n")
        self.assertFalse((self.project / ".env").exists())
        self.assertFalse(self.gh_log.exists())
        # From inside its project it writes there and names its repository to gh.
        (self.project / "src").mkdir()
        done = self.run_wizard(self.project / "src", "\nkey-for-a\n", KEY_STAGE)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual((self.project / ".env").read_text(), "API_KEY=key-for-a\n")
        self.assertEqual(self.gh_log.read_text(), "secret set API_KEY --repo octo/project-a\nkey-for-a\n")


if __name__ == "__main__":
    unittest.main()
