import type { PluginClientContext } from "@getpaseo/plugin/client";
import { contributePills } from "./client/pills";
import { createEffortExtension } from "./client/effort";
export default function contribute(client: PluginClientContext) {
  const effort = createEffortExtension(client);
  const cleanup = contributePills(client, effort);
  return async () => { effort.dispose(); await cleanup(); };
}
