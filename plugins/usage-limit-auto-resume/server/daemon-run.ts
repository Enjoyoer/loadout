// Which daemon run this plugin process belongs to. Paseo forks every plugin from the daemon worker, so the parent process
// is the run: a daemon restart replaces it, a plugin reload does not. A pid alone can come back after a host reboot, so
// the parent's start is added where the host shows it: on Linux the boot id and the start tick from /proc, on macOS the
// start time `ps` reports. Elsewhere, or when neither can be read, the run is the pid alone.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function parentStart(ppid: number, platform: NodeJS.Platform): string | null {
  if (platform === "linux") {
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    // Fields after the command name, which ends at the last ")": state is field 3, starttime field 22.
    const stat = readFileSync(`/proc/${ppid}/stat`, "utf8");
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return boot && start && /^\d+$/.test(start) ? `${boot}:${start}` : null;
  }
  if (platform === "darwin") {
    const start = execFileSync("ps", ["-o", "lstart=", "-p", String(ppid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).trim().replace(/\s+/g, " ");
    return start || null;
  }
  return null;
}

export function daemonRun(ppid = process.ppid, platform = process.platform): string {
  let start: string | null = null;
  try {
    start = parentStart(ppid, platform);
  } catch {
    // An unreadable start leaves the pid alone, as before.
  }
  return start ? `pid:${ppid}@${start}` : `pid:${ppid}`;
}

/**
 * The same daemon run. A run stored by plugin 0.3.6 or earlier is the pid alone, so it matches the same pid with a start:
 * an upgrade without a daemon restart keeps its closes.
 */
export function sameDaemonRun(a: string, b: string): boolean {
  if (a === b) return true;
  const [pidA, startA] = a.split("@", 2);
  const [pidB, startB] = b.split("@", 2);
  return pidA === pidB && (startA === undefined || startB === undefined);
}
