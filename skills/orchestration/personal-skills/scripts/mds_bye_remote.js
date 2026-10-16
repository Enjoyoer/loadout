// Verify, read-only, the mds-bye files install.sh put on this Mac against the committed blobs.
// Shipped by mds_bye.py through fleet.run_node in a digest-checked stdin envelope; process.argv[2] is the gzip+base64
// JSON payload {files: [{path, source, mode, root, template, data (base64)}]}. Nothing is written and nothing runs.
// Test-only hook: LOADOUT_MDS_BYE_ROOT, when set on the host, prefixes every installed path (after ~ expansion),
// so a scratch fake root can stand in for the real files. It is never set outside tests.
const fs = require("fs"), os = require("os"), path = require("path"), zlib = require("zlib"), crypto = require("crypto");
const result = { files: [], error: null };
function done(code) {
  process.stdout.write("\n@@LOADOUT-RESULT " + JSON.stringify(result) + " @@END\n");
  process.exit(code);
}
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");
const octal = mode => "0" + (mode & 0o7777).toString(8);

function check(file, home, root) {
  const installed = file.path.replace(/^~(?=\/)/, home);
  const target = root ? path.join(root, installed) : installed;
  const reasons = [];
  let st;
  try {
    st = fs.lstatSync(target);
  } catch (error) {
    return { path: installed, reasons: [error.code === "ENOENT" ? "missing" : `unreadable (${error.code})`] };
  }
  if (!st.isFile()) return { path: installed, reasons: [st.isSymbolicLink() ? "a symlink, not the file" : "not a regular file"] };
  let want = Buffer.from(file.data, "base64");
  // install.sh renders the agent plist with sed "s|__HOME__|${HOME}|g".
  if (file.template) want = Buffer.from(want.toString("utf8").split("__HOME__").join(home), "utf8");
  try {
    if (sha(fs.readFileSync(target)) !== sha(want)) reasons.push(`different bytes from ${file.source}`);
  } catch (error) {
    reasons.push(`unreadable (${error.code})`);
  }
  if ((st.mode & 0o7777) !== file.mode) reasons.push(`mode ${octal(st.mode)}, want ${octal(file.mode)}`);
  const uid = process.getuid();
  if (file.root && (st.uid !== 0 || st.gid !== 0)) reasons.push(`owner ${st.uid}:${st.gid}, want root:wheel (0:0)`);
  if (!file.root && st.uid !== uid) reasons.push(`owner uid ${st.uid}, want ${uid}`);
  return { path: installed, reasons };
}

try {
  if (process.platform !== "darwin") throw new Error(`mds-bye is macOS only; this host is ${process.platform}`);
  const p = JSON.parse(zlib.gunzipSync(Buffer.from(process.argv[2], "base64")).toString());
  const home = os.homedir(), root = process.env.LOADOUT_MDS_BYE_ROOT || "";
  result.files = p.files.map(file => check(file, home, root));
  done(0);
} catch (error) {
  result.error = error.message;
  done(1);
}
