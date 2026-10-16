import { readFile, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
try {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== "cmooc.grok-handoff-manifest.v1" || !Array.isArray(manifest.files)) throw new Error("MANIFEST_INVALID");
  for (const entry of manifest.files) {
    if (typeof entry.path !== "string" || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).some(part => part === ".." || part === ".")) throw new Error("MANIFEST_PATH_INVALID");
    const file = path.resolve(root, entry.path);
    for (let current = file; current !== root; current = path.dirname(current)) {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("PACKAGE_SYMLINK_FORBIDDEN");
    }
    const bytes = await readFile(file);
    if (bytes.length !== entry.sizeBytes || hash(bytes) !== entry.sha256) throw new Error("PACKAGE_FILE_MISMATCH");
  }
  const aggregate = hash(manifest.files.map(entry => `${entry.path}\0${entry.sizeBytes}\0${entry.sha256}\n`).join(""));
  if (aggregate !== manifest.aggregateSha256) throw new Error("PACKAGE_AGGREGATE_MISMATCH");
  console.log(JSON.stringify({ status: "PASS", files: manifest.files.length, aggregateSha256: aggregate,
    scope: "packaged_source_integrity", runtimeVerified: false }));
} catch {
  console.error(JSON.stringify({ status: "FAIL", error: "PACKAGE_INTEGRITY_FAILED" })); process.exitCode = 1;
}
