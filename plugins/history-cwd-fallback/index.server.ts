import path from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { CwdBridge } from "./server/bridge.ts";
import { paseoHome } from "./server/vendor/daemon-target.ts";

// Server-only plugin. When Paseo opens an archived agent's history (agent.session_open with
// purpose "history") and the agent's stored cwd, a Paseo worktree, no longer exists, the provider
// spawn would fail with ENOENT. For that open, put a link to an empty read-only directory at the
// missing path and remove it once the provider has started (see HOLD_MS). Only paths strictly inside the worktrees root whose
// parent still exists are linked; no directory is ever created there. Any other open of a linked
// path is refused, as Paseo refuses a missing directory. The hook never changes the request.
// See README.md.

// Paseo 0.11.1 and 0.13.0 emit no hook or event after a resume spawn, so the link lives for a fixed time that
// covers Pi's start: its MCP probe spawn, its real spawn, and its session cwd check. Measured on a Mac, from link
// to the timeline response (an upper bound on that check): at most 1.7 s idle and 3.0 s under heavy CPU load.
// Holds of 1.0 s (0.13.0) and 1.5 s (0.11.1) sometimes failed. 6 s is about twice the worst case. Paseo itself
// does not need the link after that: the provider keeps running in the stand-in and a loaded agent does not
// respawn for later timeline reads.
const HOLD_MS = 6_000;

export default function contribute(server: PluginServerContext) {
  const home = paseoHome();
  const bridge = new CwdBridge({
    paseoHome: home,
    stateDir: path.join(home, "plugin-state", "history-cwd-fallback"),
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
