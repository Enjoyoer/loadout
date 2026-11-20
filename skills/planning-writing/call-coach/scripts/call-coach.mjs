#!/usr/bin/env node
// call-coach: prep page, live bar and transcript reader for coaching the owner during a call.
// Node only; playwright-core is found at run time for `poll` and never vendored.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SCRIPT = fileURLToPath(import.meta.url);
const WIN = process.platform === "win32";
const TTL_HOURS = 6; // a forgotten server or poller ends on its own after this long
const HELP = `call-coach: coach the owner live during a call.

Usage: node call-coach.mjs <command> (--call <name> | --dir <folder>) [options]

The call folder holds all state. --call <name> uses <root>/call-coach/<name>, where <root>
is $FLEET_SCRATCH if set, else the OS temp folder. --dir <folder> names it directly.

Commands:
  page <source.md>        Write the prep page from a source file (see SKILL.md for the format).
  serve                   Serve the page on the tailnet address only, on a free port; print the URL.
  live - | live --clear   Set the one-line live bar from stdin (or live "<html>"), or clear it.
  poll                    Take the live-share link from <call folder>/link.txt (written with a file-write
                          tool, never a shell command), delete that file, and start the poller.
      --wrap "<cmd>"      Start it through a wrapper command your fleet rules name.
      --playwright <dir>  playwright-core package folder (or CALL_COACH_PLAYWRIGHT).
      --browser <x>       Chromium executable path or channel such as chrome (or CALL_COACH_BROWSER).
      --stale <s>         Reload the share page after this many quiet seconds (default 45). Live words
                          arrive as the page's own WebSocket updates; the reload is a fallback.
  poll --replay <file>    Test hook: feed one saved transcript response, or JSON lines of responses and
                          WebSocket messages, through the source.
  poll --status           Print the poller state.
  next [--wait <s>]       Wait until new transcript lines exist or <s> seconds pass (default 20);
                          print only the new lines as "m:ss text". Empty output: nothing new.
      --settle <s>        Once new text arrives, wait until it stops growing for <s> seconds
                          (default 1) so one turn sees the whole sentence. The wait ends 3 s after
                          the new text at most, and never past --wait.
  stop --project <dir>    Stop poller and server, save <dir>/calls/<date>/transcript.txt,
                          and drop the share link from state.
`;

// ---------- transcript sources: one small interface, Otter only for now ----------
// A source says which share links it reads (match), which responses may hold the transcript
// (wants), and whether the page was sent to a sign-in wall (revoked). reader() starts the state for
// one page load; its read(body) takes each JSON response body and each JSON WebSocket message the
// page receives, and returns the segments that changed (or null when the body is not its kind).
const SOURCES = {
  otter: {
    match: (url) => /^https:\/\/([a-z0-9-]+\.)?otter\.ai\//i.test(url),
    wants: (url) => /\/speech\b|transcript/i.test(url),
    // The page loads the transcript once from /speech (each segment with its words and a signature),
    // then gets live words only as WebSocket "speech_pieces" deltas: per segment, word deletions and
    // insertions on top of the signature they were made from (bs). Apply them as the page does.
    // Offsets are 16 kHz sample counts. Deltas apply only on top of a loaded transcript: ones that
    // arrive first wait for it. A message index at or below the last one applied (or the loaded
    // transcript's own index) is a repeat: the socket re-sends recent indexes. The index does not reset
    // on a new socket: the page passes the loaded index when it connects, and the count carries on.
    reader() {
      const segs = new Map();
      const EMPTY = /^1B2M2Y8AsgTpg/; // the signature of an empty segment (base64 MD5 of ""), plus a counter
      let loaded = false, last = 0;
      const early = [];
      const out = (s) => ({ id: s.uuid, start: Math.round(s.start / 16), end: Math.round(s.end / 16), text: s.words.join(" ").trim(), speaker: s.speaker });
      return {
        mismatch: false,
        read(body) {
          if (body?.type === "speech_pieces") {
            if (!loaded) { if (early.length < 1000) early.push(body); return []; }
            const index = Number(body.index);
            if (Number.isFinite(index)) { if (index <= last) return []; last = index; }
            const changed = new Map();
            for (const p of body.speech_pieces?.transcript_pieces ?? []) {
              let s = segs.get(p.uuid);
              if (s && s.sig === p.sig) continue; // already applied
              if (s ? s.sig !== p.bs : !EMPTY.test(String(p.bs))) { this.mismatch = true; continue; }
              if (!s) segs.set(p.uuid, (s = { uuid: p.uuid, words: [] }));
              Object.assign(s, { sig: p.sig, start: Number(p.start_offset) || 0, end: Number(p.end_offset) || 0, speaker: p.speaker_id ?? null });
              for (const d of p.deletions ?? []) s.words.splice(d.begin, d.end - d.begin);
              for (const i of p.insertions ?? []) s.words.splice(i.at, 0, ...i.pieces.map((x) => x.t));
              changed.set(p.uuid, s);
            }
            return [...changed.values()].map(out);
          }
          const list = body?.speech?.transcripts ?? body?.transcripts;
          if (!Array.isArray(list)) return null;
          this.mismatch = false;
          loaded = true;
          last = Number(body?.speech?.pubsub_v2_index) || 0;
          segs.clear();
          const loadedSegs = list
            .filter((t) => t && (t.uuid ?? t.id) != null && typeof t.transcript === "string")
            .map((t) => {
              const s = { uuid: String(t.uuid ?? t.id), sig: t.sig, start: Number(t.start_offset) || 0, end: Number(t.end_offset) || 0, speaker: t.speaker_id ?? null,
                words: Array.isArray(t.alignment) ? t.alignment.map((a) => a.word) : t.transcript.trim().split(/\s+/) };
              segs.set(s.uuid, s);
              // The text printed is the page's transcript field; later deltas edit the alignment words. On a
              // live capture (Nov 2026) the joined alignment words equalled the transcript for every segment.
              return { ...out(s), text: t.transcript.trim() };
            });
          return [...loadedSegs, ...early.splice(0).flatMap((b) => this.read(b))];
        },
      };
    },
    revoked(pageUrl) {
      try { return new URL(pageUrl).pathname.startsWith("/signin"); } catch { return false; }
    },
    revokedMessage: "Otter sent the share link to its sign-in page: the share was revoked or is not public. Ask the owner for a new live-share link.",
  },
};

// ---------- small helpers ----------
function die(msg, code = 1) {
  process.stderr.write(`call-coach: ${msg}\n`);
  process.exit(code);
}

function readJson(file, fallback) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
  return JSON.parse(text);
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      // Windows refuses a rename over a file another process is reading; retry briefly.
      if (!WIN || i >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

const writeJson = (file, value) => writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// The command line of a live process, or null when it cannot be read.
function commandLine(pid) {
  const r = WIN
    ? spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true })
    : spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() ? r.stdout : null;
}

// A pid in state is ours only while its command line names this call's internal subcommand
// (_server or _poller) and this call's folder; a reused pid never matches. "gone", "ours" or "other".
function procState(pid, sub, dir) {
  if (!alive(pid)) return "gone";
  const cmd = commandLine(pid);
  const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The exact folder after "<sub> --dir", ended by a space, a quote or the line end: "pre" never matches "pre2".
  const re = new RegExp(`(^|\\s)${sub}\\s+--dir\\s+"?${esc}"?(\\s|$)`);
  return cmd && re.test(cmd) ? "ours" : "other";
}
const ours = (pid, sub, dir) => procState(pid, sub, dir) === "ours";

async function killTree(pid, sub, dir) {
  const found = procState(pid, sub, dir);
  if (found !== "ours") return found;
  if (WIN) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    const signal = (sig) => { try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} } };
    signal("SIGTERM");
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    if (alive(pid)) signal("SIGKILL");
  }
  for (let i = 0; i < 30 && alive(pid); i++) await sleep(100);
  return "killed";
}

function spawnDetached(argv, logFile) {
  const out = fs.openSync(logFile, "a", 0o600);
  const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ["ignore", out, out], windowsHide: true });
  child.unref();
  fs.closeSync(out);
  return child.pid;
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.setTimeout(1000);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(false));
  });
}

const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const localDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- the call folder ----------
function callPaths(dir) {
  return {
    dir,
    state: path.join(dir, "state.json"),
    server: path.join(dir, "server.json"),
    poll: path.join(dir, "poll.json"),
    lines: path.join(dir, "transcript.jsonl"),
    link: path.join(dir, "link.txt"),
    cursor: path.join(dir, "next.json"),
    site: path.join(dir, "site"),
    page: path.join(dir, "site", "index.html"),
    live: path.join(dir, "site", "live.txt"),
    rev: path.join(dir, "site", "rev.txt"),
  };
}

function resolveDir(values) {
  if (values.dir) return path.resolve(values.dir);
  if (values.call) {
    if (!/^[\w.-]+$/.test(values.call) || values.call.startsWith(".")) die("--call takes a plain name (letters, digits, . _ -)");
    // Under the user's own home, never the shared temp folder: the folder holds the share link and transcript.
    return path.join(process.env.FLEET_SCRATCH || path.join(os.homedir(), ".cache"), "call-coach", values.call);
  }
  die("name the call folder with --call <name> or --dir <folder>");
}

function mkdirPrivate(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
}

// Use a folder only if it is a real folder (not a symlink) owned by this user and not writable by
// group or others; then make it owner-only. Windows has no POSIX owner or mode bits to check.
function checkPrivate(dir, label) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) die(`${label} ${dir} is a symlink; refusing to use it`);
  if (!st.isDirectory()) die(`${label} ${dir} is not a folder`);
  if (WIN) return;
  if (st.uid !== process.getuid()) die(`${label} ${dir} belongs to another user; refusing to use it`);
  if (st.mode & 0o022) die(`${label} ${dir} is writable by group or others; refusing to use it (chmod 700 it first)`);
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
}

function openCall(values) {
  const dir = resolveDir(values);
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  if (!values.dir) checkPrivate(path.dirname(dir), "call root");
  mkdirPrivate(dir);
  checkPrivate(dir, "call folder");
  const p = callPaths(dir);
  mkdirPrivate(p.site);
  checkPrivate(p.site, "page folder");
  const state = readJson(p.state, null) ?? { created: new Date().toISOString() };
  if (!fs.existsSync(p.state)) writeJson(p.state, state);
  return { p, state, save: (s) => writeJson(p.state, s) };
}

// ---------- tailnet address ----------
function tailnetAddress() {
  const r = spawnSync("tailscale", ["ip", "-4"], { encoding: "utf8", windowsHide: true });
  if (r.error || r.status !== 0) {
    die(`cannot read the tailnet address: \`tailscale ip -4\` ${r.error ? `did not run (${r.error.code})` : `exited ${r.status}`}. Start Tailscale or put its CLI on PATH; the page is never served on other addresses.`);
  }
  const ip = r.stdout.split(/\s+/).find((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x));
  const [a, b] = (ip || "").split(".").map(Number);
  if (!ip || a !== 100 || b < 64 || b > 127) die(`\`tailscale ip -4\` gave no tailnet (100.64.0.0/10) address: ${JSON.stringify(r.stdout.trim())}`);
  return ip;
}

// ---------- page ----------
function renderBody(src) {
  const inline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  let title = "Call";
  const out = [];
  let list = null, say = null, dont = false;
  const flush = () => {
    if (say) { out.push(`<div class="say">${say.map(inline).join("<br>")}</div>`); say = null; }
    if (list) { out.push(`<ul${dont ? ' class="stop"' : ""}>${list.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`); list = null; }
  };
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) { flush(); title = line.slice(2).trim(); out.push(`<h1>${inline(title)}</h1>`); continue; }
    if (line.startsWith("## ")) { flush(); const h = line.slice(3).trim(); dont = /^don'?t\b/i.test(h); out.push(`<h2>${inline(h)}</h2>`); continue; }
    if (line.startsWith(">")) { if (list) flush(); (say ??= []).push(line.replace(/^>\s?/, "")); continue; }
    if (/^[-*] /.test(line)) { if (say) flush(); (list ??= []).push(line.slice(2)); continue; }
    flush();
    if (line.startsWith("! ")) out.push(`<p class="stop">${inline(line.slice(2))}</p>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return { title, body: out.join("\n") };
}

function pageHtml({ title, body }, rev) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{margin:0;font:16px/1.45 -apple-system,"Segoe UI",Roboto,sans-serif;color:#14212b}
.w{max-width:900px;margin:0 auto;padding:18px 20px 140px}
h1{font-size:20px;margin:0 0 8px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:#fff;background:#0f5d7a;margin:18px 0 6px;padding:5px 10px;border-radius:6px}
.say{background:#fff3c4;padding:8px 12px;border-radius:8px;margin:6px 0}
.stop{color:#8a2d0f;font-weight:700}
li{margin:3px 0}
#live{display:none;position:fixed;left:0;right:0;bottom:0;background:#8a2d0f;color:#fff;padding:12px 18px;font-size:17px;z-index:9}
#live.off{background:#4a4a4a}
</style></head><body><div class="w">
${body}
</div>
<div id="live"></div>
<script>
const REV=${JSON.stringify(rev)};
let last='',shown=null,ok=Date.now();
const get=async(f)=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),2000);try{const r=await fetch(f+'?'+Date.now(),{cache:'no-store',signal:c.signal});if(!r.ok)throw Error(r.status);return (await r.text()).trim();}finally{clearTimeout(t);}};
const show=(h,off,vis)=>{const e=document.getElementById('live');if(shown===h)return;shown=h;e.classList.toggle('off',off);e.style.display=vis?'block':'none';e.innerHTML=h;};
// Every 0.5 s, one request at a time. OFFLINE only after 4 s without an answer, so one slow request never flaps it.
async function tick(){
  try{last=await get('live.txt');ok=Date.now();show('<b>LIVE:</b> '+last,false,!!last);if(await get('rev.txt')!==REV)location.reload();}
  catch(x){if(Date.now()-ok>4000)show('<b>OFFLINE:</b> the coach page is not answering; this line may be stale.'+(last?' Last: '+last:''),true,true);}
  setTimeout(tick,500);
}
tick();
</script></body></html>
`;
}

function cmdPage(values, positionals) {
  const src = positionals[0];
  if (!src) die("page needs a source file: page <source.md>");
  const { p, state } = openCall(values);
  const rev = String(Date.now());
  writeAtomic(p.page, pageHtml(renderBody(fs.readFileSync(src, "utf8")), rev));
  writeAtomic(p.rev, rev + "\n");
  if (!fs.existsSync(p.live)) writeAtomic(p.live, "");
  console.log(`page written: ${p.page}`);
  if (state.url && ours(state.serverPid, "_server", p.dir)) console.log(`open pages reload within 1 s: ${state.url}`);
}

// ---------- live bar ----------
function cmdLive(values, positionals) {
  const { p } = openCall(values);
  // "-" reads the line from stdin, so $, quotes and apostrophes reach the bar unchanged.
  const raw = values.clear ? "" : positionals[0] === "-" ? fs.readFileSync(0, "utf8") : positionals.join(" ");
  const text = raw.trim();
  if (!values.clear && !text) die("live needs the line on stdin (live -), or --clear");
  writeAtomic(p.live, text ? text + "\n" : "");
  console.log(text ? `live bar now: ${text}` : "live bar cleared");
}

// ---------- server ----------
async function cmdServe(values) {
  const { p, state, save } = openCall(values);
  if (state.url && ours(state.serverPid, "_server", p.dir)) { console.log(state.url); return; }
  const host = tailnetAddress();
  if (!fs.existsSync(p.page)) console.error("call-coach: no page yet; run `page` before giving out the URL");
  if (!fs.existsSync(p.live)) writeAtomic(p.live, "");
  fs.rmSync(p.server, { force: true });
  const pid = spawnDetached([process.execPath, SCRIPT, "_server", "--dir", p.dir, "--host", host], path.join(p.dir, "server.log"));
  for (let i = 0; i < 100; i++) {
    const s = readJson(p.server, null);
    if (s?.port) {
      const url = `http://${host}:${s.port}/`;
      save({ ...state, serverPid: pid, host, port: s.port, url });
      console.log(url);
      return;
    }
    if (!alive(pid)) break;
    await sleep(100);
  }
  die(`the server did not start; see ${path.join(p.dir, "server.log")}`);
}

function runServer(values) {
  const p = callPaths(path.resolve(values.dir));
  const root = path.resolve(p.site);
  const types = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
  const fail = (res, code) => { if (!res.headersSent) res.writeHead(code, { "Cache-Control": "no-store" }); res.end(); };
  // No request may stop the server: every error becomes a 4xx or 5xx answer.
  const server = http.createServer((req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405);
      let rel;
      try { rel = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return fail(res, 400); }
      if (rel.includes("\0")) return fail(res, 400);
      if (rel.endsWith("/")) rel += "index.html";
      const file = path.resolve(root, "." + rel);
      if (!file.startsWith(root + path.sep)) return fail(res, 404);
      fs.readFile(file, (err, data) => {
        if (err) return fail(res, ["ENOENT", "ENOTDIR", "EISDIR"].includes(err.code) ? 404 : 500);
        res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : data);
      });
    } catch {
      fail(res, 500);
    }
  });
  server.listen(0, values.host, () => {
    writeJson(p.server, { pid: process.pid, host: values.host, port: server.address().port });
  });
  setTimeout(() => process.exit(0), TTL_HOURS * 3600e3).unref();
}

// ---------- poller ----------
function npmDirs() {
  const run = (args) => {
    const r = spawnSync("npm", args, { encoding: "utf8", shell: WIN, windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : "";
  };
  const dirs = [];
  const globalRoot = run(["root", "-g"]);
  if (globalRoot) dirs.push(path.join(globalRoot, "playwright-core"), path.join(globalRoot, "playwright", "node_modules", "playwright-core"));
  const cache = run(["config", "get", "cache"]);
  if (cache) {
    const npx = path.join(cache, "_npx");
    let entries = [];
    try { entries = fs.readdirSync(npx); } catch (e) { if (e.code !== "ENOENT") throw e; }
    for (const e of entries) dirs.push(path.join(npx, e, "node_modules", "playwright-core"));
  }
  return dirs;
}

function findPlaywright(explicit) {
  const tried = [];
  const versionOf = (dir) => readJson(path.join(dir, "package.json"), null)?.version;
  const given = explicit || process.env.CALL_COACH_PLAYWRIGHT;
  if (given) {
    if (versionOf(given)) return given;
    die(`no playwright-core package at ${given} (from ${explicit ? "--playwright" : "CALL_COACH_PLAYWRIGHT"})`);
  }
  for (const from of [path.join(process.cwd(), "x"), SCRIPT]) {
    try { return path.dirname(createRequire(from).resolve("playwright-core/package.json")); } catch { tried.push(`require from ${path.dirname(from)}`); }
  }
  const found = npmDirs().filter((d) => versionOf(d));
  tried.push("npm global root", "npx cache");
  if (!found.length) {
    die(`playwright-core not found (tried: ${tried.join(", ")}). Install it with \`npm install -g playwright-core\`, or pass --playwright <dir> or set CALL_COACH_PLAYWRIGHT to its package folder.`);
  }
  const key = (d) => versionOf(d).split(/[.-]/).slice(0, 3).map((n) => Number(n) || 0);
  found.sort((a, b) => { const x = key(a), y = key(b); return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]); });
  return found[0];
}

// Try the browser the owner named, then Playwright's own build, then installed Chrome and Edge.
async function launchBrowser(chromium, named) {
  const choice = named || process.env.CALL_COACH_BROWSER;
  const base = { headless: true, handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false };
  const tries = choice
    ? [[choice, /[\\/]/.test(choice) ? { executablePath: choice } : { channel: choice }]]
    : [["Playwright's bundled browser", {}], ["Chrome (channel chrome)", { channel: "chrome" }], ["Edge (channel msedge)", { channel: "msedge" }]];
  const errors = [];
  for (const [label, extra] of tries) {
    try { return { browser: await chromium.launch({ ...base, ...extra }), label }; } catch (e) {
      errors.push(`${label}: ${String(e.message).split("\n")[0]}`);
    }
  }
  throw new Error(`no browser could start. ${errors.join("; ")}. Install Chrome, run \`npx playwright-core install chromium-headless-shell\`, or set --browser / CALL_COACH_BROWSER to a Chromium executable or channel.`);
}

function makeSink(p) {
  const known = new Map();
  if (fs.existsSync(p.lines)) {
    for (const l of fs.readFileSync(p.lines, "utf8").split("\n")) if (l.trim()) { const s = JSON.parse(l); known.set(s.id, s.text); }
  }
  return {
    get size() { return known.size; },
    add(segments) {
      const fresh = segments.filter((s) => s.text && known.get(s.id) !== s.text);
      if (!fresh.length) return 0;
      fs.appendFileSync(p.lines, fresh.map((s) => JSON.stringify(s) + "\n").join(""), { mode: 0o600 });
      for (const s of fresh) known.set(s.id, s.text);
      return fresh.length;
    },
  };
}

// Read link.txt only if it is a regular file this user owns; make it owner-only first.
function takeLink(p) {
  let st;
  try { st = fs.lstatSync(p.link); } catch (e) {
    if (e.code === "ENOENT") die(`no link file: write the live-share link with your file-write tool to ${p.link}, never in a shell command`);
    throw e;
  }
  if (st.isSymbolicLink() || !st.isFile()) die(`${p.link} is not a regular file; refusing it`);
  if (!WIN) {
    if (st.uid !== process.getuid()) die(`${p.link} belongs to another user; refusing it`);
    if (st.mode & 0o077) fs.chmodSync(p.link, 0o600);
  }
  const url = fs.readFileSync(p.link, "utf8").trim();
  if (!url) { fs.rmSync(p.link, { force: true }); die(`${p.link} was empty; write the link again`); }
  return url;
}

async function cmdPoll(values, positionals) {
  const { p, state, save } = openCall(values);
  if (values.status) {
    const s = readJson(p.poll, null);
    console.log(s ? `${s.state}${s.message ? `: ${s.message}` : ""} (${s.segments ?? 0} segments, updated ${s.at})` : "no poller has run in this call folder");
    return;
  }
  const sourceName = values.source || state.source || "otter";
  const source = SOURCES[sourceName];
  if (!source) die(`unknown source ${sourceName}; known: ${Object.keys(SOURCES).join(", ")}`);
  if (values.replay) {
    // One saved response body, or JSON lines of response bodies and WebSocket messages in order.
    const text = fs.readFileSync(values.replay, "utf8");
    let bodies;
    try { bodies = [JSON.parse(text)]; } catch { bodies = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); }
    const reader = source.reader(), sink = makeSink(p);
    let segs = 0, added = 0;
    for (const body of bodies) { const s = reader.read(body); if (s) { segs += s.length; added += sink.add(s); } }
    const step = reader.mismatch ? "; a live update was out of step (the poller would reload)" : "";
    if (!segs) die(`${values.replay} holds no ${sourceName} transcript${step}`);
    console.log(`replayed ${segs} segment updates through ${sourceName}, ${added} new or changed${step}`);
    return;
  }
  // The link never appears in a command line (the agent's shell command included), since other users
  // can read process arguments. The agent writes it with its file-write tool to link.txt.
  if (positionals.length) die(`never pass the live-share link in a command; write it with your file-write tool to ${p.link}, then run poll`);
  if (ours(state.pollerPid, "_poller", p.dir)) die(`a poller is already running (pid ${state.pollerPid}); run stop first`);
  const url = takeLink(p);
  const named = Object.entries(SOURCES).find(([, s]) => s.match(url));
  if (!named) die(`no transcript source reads the link in ${p.link}; known: ${Object.keys(SOURCES).join(", ")}`);
  save({ ...state, shareUrl: url, source: named[0] });
  fs.rmSync(p.link, { force: true });
  const pwDir = findPlaywright(values.playwright);
  fs.rmSync(p.poll, { force: true });
  const wrap = (values.wrap || "").trim().split(/\s+/).filter(Boolean);
  const argv = [...wrap, process.execPath, SCRIPT, "_poller", "--dir", p.dir, "--playwright", pwDir, "--stale", String(values.stale || 45)];
  if (values.browser) argv.push("--browser", values.browser);
  const pid = spawnDetached(argv, path.join(p.dir, "poll.log"));
  save({ ...readJson(p.state, state), pollerPid: pid, wrap: wrap.join(" ") || undefined });
  console.log(`poller started (pid ${pid}${wrap.length ? `, through ${wrap.join(" ")}` : ""}); waiting up to 60 s for the first lines`);
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const s = readJson(p.poll, null);
    if (s && (s.state === "revoked" || s.state === "error")) die(`poller ${s.state}: ${s.message}`, 3);
    if (s?.segments > 0) { console.log(`listening through ${s.browser}: ${s.segments} transcript segments so far`); return; }
    if (!alive(pid)) die(`the poller exited; see ${path.join(p.dir, "poll.log")}`, 3);
  }
  const s = readJson(p.poll, null);
  console.log(`no transcript lines yet (poller: ${s ? s.state : "starting"}). Check that recording has started; \`next\` reports new lines.`);
}

async function runPoller(values) {
  const p = callPaths(path.resolve(values.dir));
  const state = readJson(p.state, {});
  const source = SOURCES[state.source];
  const status = { pid: process.pid, state: "starting", segments: 0 };
  // Error text from the browser can quote the share link; keep it out of every log and status line.
  // The share id alone too: the page's transcript and socket URLs carry it as a query value.
  const sharePath = state.shareUrl && new URL(state.shareUrl).pathname;
  const secrets = [state.shareUrl, sharePath, sharePath && sharePath.split("/").filter(Boolean).pop()].filter((s) => s && s.length > 3);
  const scrub = (s) => secrets.reduce((acc, x) => acc.split(x).join("<share link>"), String(s));
  const report = (patch) => {
    if (patch.message) patch.message = scrub(patch.message);
    Object.assign(status, patch, { at: new Date().toISOString() });
    writeJson(p.poll, status);
  };
  const log = (msg) => console.log(`${new Date().toISOString()} ${scrub(msg)}`);
  report({});
  let browser;
  const finish = async (code) => { try { await browser?.close(); } catch {} process.exit(code); };
  process.on("SIGTERM", () => finish(0));
  process.on("SIGINT", () => finish(0));
  try {
    if (!state.shareUrl || !source) throw new Error("no share link in state; write link.txt and run poll");
    const { chromium } = createRequire(SCRIPT)(values.playwright);
    const launched = await launchBrowser(chromium, values.browser);
    browser = launched.browser;
    log(`playwright-core ${readJson(path.join(values.playwright, "package.json"), {}).version} at ${values.playwright}; browser: ${launched.label}`);
    report({ browser: launched.label });
    const sink = makeSink(p);
    let lastChange = Date.now(), lastReload = Date.now();
    const page = await browser.newPage({ viewport: { width: 1280, height: 2000 } });
    // Every JSON response the source wants and every JSON WebSocket message goes through one reader,
    // which starts afresh with each page load. Live words arrive as socket messages, within about a second.
    let reader = source.reader();
    const take = (body) => {
      const segs = reader.read(body);
      if (!segs) return;
      const added = sink.add(segs);
      if (added) { lastChange = Date.now(); log(`+${added} segments`); }
      report({ state: "listening", segments: sink.size, lastChange: new Date(lastChange).toISOString() });
    };
    page.on("websocket", (ws) => {
      // A socket belongs to the page load that opened it; after a reload its late frames are dropped.
      const owner = reader;
      ws.on("framereceived", ({ payload }) => {
        if (owner !== reader) return;
        let msg;
        try { msg = JSON.parse(String(payload)); } catch { return; }
        take(msg);
      });
    });
    page.on("response", async (r) => {
      if (!source.wants(r.url())) return;
      if (!(r.headers()["content-type"] || "").includes("json")) return;
      let body;
      try { body = JSON.parse(await r.text()); } catch { return; }
      take(body);
    });
    const reload = async (why) => {
      lastReload = Date.now();
      reader = source.reader();
      try { await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }); log(`reload (${why})`); } catch (e) { log(`reload failed: ${String(e.message).split("\n")[0]}`); }
    };
    await page.goto(state.shareUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    report({ state: "listening", segments: sink.size });
    const stale = Number(values.stale) * 1000 || 45000;
    const started = Date.now();
    for (;;) {
      await sleep(1000);
      if (source.revoked(page.url())) {
        report({ state: "revoked", message: source.revokedMessage });
        log("share link revoked");
        return finish(3);
      }
      if (Date.now() - started > TTL_HOURS * 3600e3) { report({ state: "stopped", message: `ended after ${TTL_HOURS} h` }); return finish(0); }
      // A live update that does not fit the words held (a missed message) is fixed by loading the page again.
      if (reader.mismatch && Date.now() - lastReload > 10000) await reload("live update out of step");
      else if (Date.now() - lastChange > stale && Date.now() - lastReload > stale) await reload(`${stale / 1000} s quiet`);
    }
  } catch (e) {
    report({ state: "error", message: String(e.message).split("\n")[0] });
    log(`error: ${e.stack || e.message}`);
    return finish(1);
  }
}

// ---------- next ----------
async function cmdNext(values) {
  const { p, state } = openCall(values);
  const cursor = readJson(p.cursor, { offset: 0, printed: {} });
  const deadline = Date.now() + (Number(values.wait ?? 20) || 20) * 1000;
  const settle = Number(values.settle ?? 1) * 1000;
  const sizeOf = () => { try { return fs.statSync(p.lines).size; } catch (e) { if (e.code !== "ENOENT") throw e; return 0; } };
  for (;;) {
    let size = sizeOf();
    if (size > cursor.offset && settle > 0) {
      // Let a growing line finish: wait until the file stops growing for `settle`, at most 3 s in all
      // and never past the --wait deadline.
      const cap = Math.min(Date.now() + 3000, deadline);
      let quietSince = Date.now();
      while (Date.now() - quietSince < settle && Date.now() < cap) {
        await sleep(100);
        const now = sizeOf();
        if (now !== size) { size = now; quietSince = Date.now(); }
      }
    }
    if (size > cursor.offset) {
      const fd = fs.openSync(p.lines, "r");
      const buf = Buffer.alloc(size - cursor.offset);
      fs.readSync(fd, buf, 0, buf.length, cursor.offset);
      fs.closeSync(fd);
      const end = buf.lastIndexOf(0x0a) + 1; // only whole lines
      cursor.offset += end;
      const latest = new Map();
      for (const l of buf.subarray(0, end).toString("utf8").split("\n")) if (l.trim()) { const s = JSON.parse(l); latest.set(s.id, s); }
      const out = [];
      for (const s of [...latest.values()].sort((a, b) => a.start - b.start)) {
        const before = cursor.printed[s.id];
        if (before === s.text) continue;
        const grown = before && s.text.startsWith(before) ? `... ${s.text.slice(before.length).trim()}` : s.text;
        out.push(`${mmss(s.start)} ${grown}`);
        cursor.printed[s.id] = s.text;
      }
      writeJson(p.cursor, cursor);
      if (out.length) { console.log(out.join("\n")); return; }
    }
    if (Date.now() >= deadline) break;
    await sleep(200);
  }
  const s = readJson(p.poll, null);
  if (s && (s.state === "revoked" || s.state === "error")) die(`poller ${s.state}: ${s.message}`, 3);
  if (state.pollerPid && !ours(state.pollerPid, "_poller", p.dir)) die("the poller is not running; see poll.log, then run poll again", 3);
}

// ---------- stop ----------
function savedTranscript(p) {
  const latest = new Map();
  let text;
  try { text = fs.readFileSync(p.lines, "utf8"); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  for (const l of text.split("\n")) if (l.trim()) { const s = JSON.parse(l); latest.set(s.id, s); }
  return [...latest.values()].sort((a, b) => a.start - b.start).map((s) => `${mmss(s.start)} ${s.text}`);
}

async function cmdStop(values) {
  if (!values.project) die("stop needs --project <dir>: the transcript goes to <dir>/calls/<date>/transcript.txt");
  const { p, state, save } = openCall(values);
  const notes = [];
  for (const [label, pid, sub] of [["poller", state.pollerPid, "_poller"], ["server", state.serverPid, "_server"]]) {
    if (!pid) continue;
    const done = await killTree(pid, sub, p.dir);
    if (done === "killed") notes.push(`${label} stopped (pid ${pid}${label === "server" && state.url ? `, ${state.url}` : ""})`);
    else if (done === "other") notes.push(`${label} pid ${pid} now belongs to another process (its command line does not name ${sub} and this call folder); not killed`);
    else notes.push(`${label} had already exited (pid ${pid})`);
  }
  // Windows releases the port a moment after the process is gone.
  let open = Boolean(state.host && state.port);
  for (let i = 0; open && i < 30; i++) { open = await portOpen(state.host, state.port); if (open) await sleep(100); }
  if (open) notes.push(`WARNING: ${state.host}:${state.port} still accepts connections`);
  const lines = savedTranscript(p);
  if (lines.length) {
    const dayDir = path.join(path.resolve(values.project), "calls", localDate(new Date(state.created || Date.now())));
    fs.mkdirSync(dayDir, { recursive: true });
    let file = path.join(dayDir, "transcript.txt");
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dayDir, `transcript-${n}.txt`);
    fs.writeFileSync(file, lines.join("\n") + "\n", { flag: "wx" });
    notes.push(`saved ${lines.length} lines to ${file}`);
  } else {
    notes.push("no transcript lines; nothing saved");
  }
  const { shareUrl, pollerPid, serverPid, ...rest } = state;
  save({ ...rest, stopped: new Date().toISOString() });
  if (shareUrl) {
    // Belt and braces: drop any stray copy of the link from the poller's files.
    for (const file of [path.join(p.dir, "poll.log"), p.poll]) {
      let text;
      try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
      if (text.includes(shareUrl)) writeAtomic(file, text.split(shareUrl).join("<share link>"));
    }
  }
  if (shareUrl) notes.push("share link removed from state");
  let linkLeft = true;
  try { fs.rmSync(p.link); } catch (e) { if (e.code !== "ENOENT") throw e; linkLeft = false; }
  if (linkLeft) notes.push("leftover link.txt deleted");
  console.log(notes.join("\n"));
}

// ---------- main ----------
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h" },
    call: { type: "string" }, dir: { type: "string" }, host: { type: "string" },
    clear: { type: "boolean" }, wrap: { type: "string" }, playwright: { type: "string" },
    browser: { type: "string" }, stale: { type: "string" }, replay: { type: "string" },
    status: { type: "boolean" }, source: { type: "string" }, wait: { type: "string" }, settle: { type: "string" },
    project: { type: "string" },
  },
});
const [command, ...rest] = positionals;
const commands = {
  page: cmdPage, serve: cmdServe, live: cmdLive, poll: cmdPoll, next: cmdNext, stop: cmdStop,
  _server: runServer, _poller: runPoller,
};
if (values.help || !command) { process.stdout.write(HELP); process.exit(0); }
if (!commands[command]) die(`unknown command ${command}; run --help`);
await commands[command](values, rest);
