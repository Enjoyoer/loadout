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


EXAMPLE = Path(__file__).resolve().parent.parent / "skills/orchestration/personal-skills/fleet/example"


def fleet_doc(*hosts, **top):
    doc = {"source_host": "a", "hosts": list(hosts) or [host("a")]}
    doc.update(top)
    return doc


def host(name, **fields):
    return {"name": name, "os": "linux", "checkout": None, "clients": ["codex"], **fields}


class ValidateTest(unittest.TestCase):
    def check_error(self, doc, fragment):
        with self.assertRaises(fleet.FleetError) as caught:
            fleet.validate(doc)
        self.assertIn(fragment, str(caught.exception))

    def test_example_is_valid(self):
        got = fleet.load(EXAMPLE)
        by_name = {h["name"]: h for h in got["hosts"]}
        self.assertEqual(got["schema_version"], 2)
        self.assertEqual(by_name["laptop"]["sync"], ["skills", "plugins", "providers", "client-config"])
        self.assertEqual(by_name["desktop"]["sync"], ["skills", "plugins", "client-config"])
        self.assertEqual(by_name["devbox"]["sync"], ["skills"])
        self.assertEqual(by_name["tablet"]["transport"], "paseo-relay")
        self.assertEqual([h["name"] for h in fleet.hosts_for(got, "skills")], ["laptop", "desktop", "devbox"])
        self.assertEqual([h["name"] for h in fleet.hosts_for(got, "providers")], ["laptop", "tablet"])

    def test_version_1_keeps_free_text_transport_and_default_sync(self):
        paseo = {"plugin_root": None, "stage": [], "install": []}
        got = fleet.validate(fleet_doc(host("a", paseo=paseo), host("b"), transport="ssh over a VPN"))
        self.assertEqual([(h["transport"], h["sync"]) for h in got["hosts"]],
                         [("ssh", ["skills", "plugins"]), ("ssh", ["skills"])])

    def test_version_2_rejects_unknown_transport(self):
        self.check_error(fleet_doc(schema_version=2, transport="ssh over a VPN"), "transport")

    def test_unknown_schema_version(self):
        self.check_error(fleet_doc(schema_version=3), "schema_version")

    def test_unknown_host_transport(self):
        self.check_error(fleet_doc(host("a"), host("b", transport="ftp")), "transport 'ftp'")

    def test_unknown_sync_scope(self):
        self.check_error(fleet_doc(host("a"), host("b", sync=["skills", "secrets"])), "['secrets']")

    def test_empty_or_duplicate_sync(self):
        self.check_error(fleet_doc(host("a"), host("b", sync=[])), "must not be empty")
        self.check_error(fleet_doc(host("a"), host("b", sync=["skills", "skills"])), "duplicates")

    def test_unknown_keys(self):
        self.check_error(fleet_doc(host("a"), host("b", synk=["skills"])), "unknown keys ['synk']")
        self.check_error(fleet_doc(extra=1), "unknown keys ['extra']")

    def test_relay_host_rules(self):
        relay = {"name": "r", "os": "linux", "transport": "paseo-relay", "paseo_offer": "r.offer"}
        self.assertEqual(fleet.validate(fleet_doc(host("a"), {**relay, "sync": ["providers"]}))["hosts"][1]["sync"],
                         ["providers"])
        self.check_error(fleet_doc(host("a"), relay), "explicit sync")
        self.check_error(fleet_doc(host("a"), {**relay, "sync": ["skills", "providers"]}), "no file transport")
        self.check_error(fleet_doc(host("a"), {**relay, "sync": ["client-config"]}), "['client-config']")
        no_offer = {k: v for k, v in relay.items() if k != "paseo_offer"}
        self.check_error(fleet_doc(host("a"), {**no_offer, "sync": ["providers"]}), "paseo_offer")

    def test_source_host_must_be_listed_and_local(self):
        self.check_error(fleet_doc(source_host="z"), "source_host")
        relay = {"name": "a", "os": "linux", "transport": "paseo-relay", "sync": ["providers"], "paseo_offer": "a.offer"}
        self.check_error(fleet_doc(relay), "source_host must use the ssh transport")

    def test_skills_scope_needs_clients(self):
        bare = {"name": "b", "os": "linux", "sync": ["skills"]}
        self.check_error(fleet_doc(host("a"), bare), "clients")
        self.check_error(fleet_doc(host("a"), host("b", clients=["cursor"])), "['cursor']")

    def test_plugins_scope_needs_paseo(self):
        self.check_error(fleet_doc(host("a"), host("b", sync=["plugins"])), "no paseo entry")

    def test_install_subset_of_stage(self):
        paseo = {"plugin_root": None, "stage": ["x"], "install": ["y"]}
        self.check_error(fleet_doc(host("a", paseo=paseo)), "subset")

    def test_duplicate_host_and_bad_os(self):
        self.check_error(fleet_doc(host("a"), host("a")), "listed twice")
        self.check_error(fleet_doc(host("a", os="beos")), "os 'beos'")

    def test_host_name_cannot_start_with_a_dash(self):
        self.check_error(fleet_doc(host("a"), host("-oProxyCommand=x")), "not start with '-'")

    def test_global_clients(self):
        self.check_error(fleet_doc(**{"global": {"cursor": "~/x"}}), "unknown keys ['cursor']")


if __name__ == "__main__":
    unittest.main()
