import os
import shlex
import shutil
import subprocess
import tempfile
import time
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

    def wizard(self, stages, name="wizard.sh"):
        # Generated for project-a and saved outside it, as a scratch wizard is.
        library = TEMPLATE.read_text().split("# STAGES:")[0]
        script = self.base / name
        script.write_text(library + "\n".join([
            "TOTAL_STAGES=1",
            f"PROJECT_ROOT={shlex.quote(str(self.project))}",
            "GITHUB_REPO=octo/project-a",
            'banner "Test setup"',
            'stage "Keys"',
            stages,
            "finish",
        ]) + "\n")
        return script

    def run_wizard(self, cwd, answers, stages, env=None):
        return subprocess.run(["bash", str(self.wizard(stages))], cwd=cwd, input=answers, env=env or self.env,
                              capture_output=True, text=True, timeout=60)

    def stub(self, name, before):
        # A PATH stub that runs `before`, then the real command.
        stubs = self.base / "stubs"
        stubs.mkdir(exist_ok=True)
        (stubs / name).write_text(f'#!/bin/sh\n{before}\nexec {shlex.quote(shutil.which(name))} "$@"\n')
        (stubs / name).chmod(0o755)
        return {**self.env, "PATH": f"{stubs}{os.pathsep}{self.env['PATH']}"}

    def wait_for(self, path):
        deadline = time.monotonic() + 30
        while not path.exists():
            self.assertLess(time.monotonic(), deadline, f"{path.name} never appeared")
            time.sleep(0.02)

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

    @unittest.skipIf(hasattr(os, "geteuid") and os.geteuid() == 0, "root reads a write-only file")
    def test_an_unreadable_env_file_is_left_unchanged(self):
        env_file = self.project / ".env"
        env_file.write_text("OTHER=keep\n")
        env_file.chmod(0o200)
        done = self.run_wizard(self.project, "\nnew-key\n", KEY_STAGE)
        env_file.chmod(0o600)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertEqual(env_file.read_text(), "OTHER=keep\n")
        self.assertFalse(self.gh_log.exists())

    def test_env_values_load_back_as_entered(self):
        env_file = self.project / ".env"
        done = self.run_wizard(self.project, "\nalpha # beta\n", KEY_STAGE)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        loaded = subprocess.run(["bash", "-c", 'set -a; . ./.env; printf %s "$API_KEY"'], cwd=self.project,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(loaded.stdout, "alpha # beta")
        # Enter keeps the stored value on a re-run, and CI gets that same value.
        stored = env_file.read_text()
        done = self.run_wizard(self.project, "\n\n", KEY_STAGE)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(env_file.read_text(), stored)
        sent = "secret set API_KEY --repo octo/project-a\nalpha # beta\n"
        self.assertEqual(self.gh_log.read_text(), sent * 2)
        # A value dotenv loaders read differently stops the wizard before either write.
        done = self.run_wizard(self.project, "\nit's\n", KEY_STAGE)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertNotIn("it's", done.stdout + done.stderr)
        self.assertEqual(env_file.read_text(), stored)
        self.assertEqual(self.gh_log.read_text(), sent * 2)

    def test_a_held_env_file_lock_refuses_the_write(self):
        env_file = self.project / ".env"
        env_file.write_text("OTHER=keep\n")
        (self.project / ".env.lock").mkdir()
        done = self.run_wizard(self.project, "\nnew-key\n", KEY_STAGE)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertEqual(env_file.read_text(), "OTHER=keep\n")
        self.assertFalse(self.gh_log.exists())

    def test_two_overlapping_writers_keep_both_keys(self):
        env_file = self.project / ".env"
        env_file.write_text("OTHER=keep\n")
        ready, waiting, go = (self.base / name for name in ("ready", "waiting", "go"))
        # The first writer makes its temp file only while it holds the lock: there it says so and waits for go.
        # The second writer sleeps only while it waits for that lock: there it says so.
        self.stub("mktemp", f'if [ -n "$HOLD" ]; then : > {shlex.quote(str(ready))}; i=0; '
                            f'while [ ! -e {shlex.quote(str(go))} ] && [ $i -lt 600 ]; do '
                            f'{shlex.quote(shutil.which("sleep"))} 0.05; i=$((i+1)); done; fi')
        env = self.stub("sleep", f'[ -n "$HOLD" ] || : > {shlex.quote(str(waiting))}')
        writers = []

        def start(key, extra):
            script = self.wizard(f'ask {key} "Value:"\nwrite_env {key} "${key}"', f"{key}.sh")
            answers = self.base / f"{key}.in"
            answers.write_text(f"\n{key.lower()}\n")
            with answers.open() as stdin:
                writers.append(subprocess.Popen(["bash", str(script)], cwd=self.project, stdin=stdin,
                                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                                env={**env, **extra}))

        start("KEY_A", {"HOLD": "1"})
        self.wait_for(ready)
        start("KEY_B", {})
        self.wait_for(waiting)
        go.touch()
        for writer in writers:
            out, err = writer.communicate(timeout=60)
            self.assertEqual(writer.returncode, 0, out + err)
        self.assertEqual(sorted(env_file.read_text().splitlines()), ["KEY_A=key_a", "KEY_B=key_b", "OTHER=keep"])
        self.assertEqual(sorted(p.name for p in self.project.iterdir()), [".env"])

    def test_an_env_symlink_is_refused_before_any_read(self):
        other = self.base / "project-b"
        other.mkdir()
        (other / ".env").write_text("API_KEY=b-secret\n")
        (self.project / ".env").symlink_to(other / ".env")
        done = self.run_wizard(self.project, "\n\n", KEY_STAGE)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertNotIn("Paste the key", done.stdout)
        self.assertNotIn("b-secret", done.stdout + done.stderr)
        self.assertEqual(os.readlink(self.project / ".env"), str(other / ".env"))
        self.assertEqual((other / ".env").read_text(), "API_KEY=b-secret\n")
        self.assertFalse(self.gh_log.exists())

    def test_an_env_symlink_to_an_unreadable_target_is_not_replaced(self):
        hidden = self.base / "hidden"
        hidden.mkdir()
        (hidden / ".env").write_text("OTHER=keep\n")
        hidden.chmod(0)
        self.addCleanup(hidden.chmod, 0o700)
        (self.project / ".env").symlink_to(hidden / ".env")
        done = self.run_wizard(self.project, "\nnew-key\n", KEY_STAGE)
        hidden.chmod(0o700)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertEqual(os.readlink(self.project / ".env"), str(hidden / ".env"))
        self.assertEqual((hidden / ".env").read_text(), "OTHER=keep\n")
        self.assertEqual(sorted(p.name for p in self.project.iterdir()), [".env"])
        self.assertFalse(self.gh_log.exists())

    def test_a_stat_failure_other_than_enoent_stops_the_wizard(self):
        env_file = self.project / ".env"
        env_file.write_text("API_KEY=old\nOTHER=keep\n")
        env = self.stub("stat", 'for arg; do last=$arg; done\n'
                                'case "$last" in */.env) echo "stat: cannot statx \'$last\': Permission denied" >&2; exit 1;; esac')
        done = self.run_wizard(self.project, "\nnew-key\n", KEY_STAGE, env)
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertIn("Permission denied", done.stderr)
        self.assertEqual(env_file.read_text(), "API_KEY=old\nOTHER=keep\n")
        self.assertEqual(sorted(p.name for p in self.project.iterdir()), [".env"])
        self.assertFalse(self.gh_log.exists())

    def test_enter_keeps_a_line_in_another_form_and_sends_nothing(self):
        env_file = self.project / ".env"
        env_file.write_text('API_KEY="keep-me"\nOTHER=x\n')
        done = self.run_wizard(self.project, "\n\n", KEY_STAGE)
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(env_file.read_text(), 'API_KEY="keep-me"\nOTHER=x\n')
        self.assertFalse(self.gh_log.exists())


if __name__ == "__main__":
    unittest.main()
