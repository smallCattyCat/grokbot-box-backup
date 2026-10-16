import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";

export const PORTABLE_PROTOCOL = "course-companion/v2";
export async function portableRuntimeIdentity() {
  const root = path.resolve(process.env.CMOOC_SERVICE_DATA_DIR || ".cmooc-service-data");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "namespace-id");
  try { await writeFile(file, randomUUID(), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64) throw new Error("SERVICE_NAMESPACE_INVALID");
  const namespaceId = (await readFile(file, "utf8")).trim();
  if (!/^[0-9a-f-]{36}$/.test(namespaceId)) throw new Error("SERVICE_NAMESPACE_INVALID");
  let packageDigest = "development";
  try {
    const manifest = JSON.parse(await readFile(path.resolve("manifest.json"), "utf8"));
    if (/^[a-f0-9]{64}$/.test(manifest.aggregateSha256)) packageDigest = manifest.aggregateSha256;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("SERVICE_PACKAGE_MANIFEST_INVALID"); }
  return { schemaVersion: "cmooc-portable-service.v2", primaryProtocol: PORTABLE_PROTOCOL, packageVersion: "2.0.0",
    instanceId: process.env.CMOOC_SERVICE_INSTANCE_ID || "offline", namespaceId, packageDigest,
    codexRequired: false, realPublishEnabled: false, browser: "provided_by_host" };
}
