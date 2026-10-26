import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CwdBridge } from "./server/bridge.ts";
import { paseoHome } from "./server/vendor/daemon-target.ts";

// Server-only plugin. When Paseo opens an archived agent's history (agent.session_open with
// purpose "history") and the agent's stored cwd no longer exists, the provider spawn would fail
// with ENOENT. For that open only, put a link to an empty read-only directory at the missing
// path; remove it a minute later. An interactive open of that path meanwhile is refused, as Paseo
// refuses a missing directory. Present directories are untouched, and the hook never changes the
// request. See README.md.

const HOLD_MS = 60_000;

export default function contribute(server: PluginServerContext) {
  const bridge = new CwdBridge({
    stateDir: path.join(paseoHome(), "plugin-state", "history-cwd-fallback"),
    holdMs: HOLD_MS,
    log: (line) => console.log(line),
  });
  void bridge.sweep();

  const removeBefore = server.before("agent.session_open", async ({ request }) => {
    if (request.purpose === "history") await bridge.open(request.cwd, request.agentId);
    else await bridge.refuseStandIn(request.cwd);
  });

  return async () => {
    removeBefore();
    await bridge.stop();
  };
}
