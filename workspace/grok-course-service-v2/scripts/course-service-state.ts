import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireLock } from "./portable-course-service";

const execFileAsync = promisify(execFile);

export const SERVICE_STATE_SCHEMA = "cmooc.course-service-runtime-state.v1" as const;
export const MIGRATION_SCHEMA = "cmooc.course-service-private-migration.v1" as const;
export const SERVICE_PROTOCOL = "course-companion/v2" as const;
export const SERVICE_STATE_FILE = "service-runtime.json" as const;
export const SERVICE_STOP_FILE = "service-stop.json" as const;
export const SERVICE_RELOGIN_FILE = "host-relogin-required.json" as const;
export const SERVICE_LOG_DIR = "logs" as const;
export const SERVICE_MIGRATION_LOCK = "migration.lock" as const;

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const PORTABLE_PATHS = new Set([
  "course.db",
  "namespace-id",
  "browser-courses/workspace.json",
  "browser-courses/bridge-key",
  "private/cmooc-research/runtime/evidence-hmac-v1.key"
]);

export type ServiceDesiredState = "running" | "stopped" | "attention";

export type ServiceRuntimeState = {
  schemaVersion: typeof SERVICE_STATE_SCHEMA;
  pid: number;
  instanceId: string;
  namespaceId: string;
  runtimeToken: string;
  dataDir: string;
  packageRoot: string;
  origin: string;
  startedAt: string;
  desired: ServiceDesiredState;
  restartCount: number;
  restartWindowStartedAt: string | null;
  stopRequestedAt: string | null;
};

export type ServiceStopIntent = {
  schemaVersion: "cmooc.course-service-stop-intent.v1";
  nonce: string;
  pid: number;
  instanceId: string;
  namespaceId: string;
  requestedAt: string;
};

type ArchiveFile = {
  path: string;
  mode: number;
  sizeBytes: number;
  sha256: string;
  base64: string;
};

type ArchiveManifestFile = Omit<ArchiveFile, "base64">;

export type PrivateMigrationArchive = {
  schemaVersion: typeof MIGRATION_SCHEMA;
  createdAt: string;
  files: ArchiveFile[];
  excludedPaths: string[];
  manifestSha256: string;
};

export type ServiceHealthIdentity = {
  ready?: boolean;
  instanceId?: string;
  namespaceId?: string;
  primaryProtocol?: string;
  [key: string]: unknown;
};

export type ManagedIdentityCheck = {
  pidAlive: boolean;
  commandLine: string | null;
  commandMatches: boolean;
  health: ServiceHealthIdentity | null;
  healthMatches: boolean;
  verified: boolean;
  reason?: string;
};

export type PrivateMigrationOptions = {
  dataDir?: string;
  file: string;
  now?: Date;
  packageRoot?: string;
};

function stableManifest(value: { schemaVersion: string; createdAt: string; files: ArchiveManifestFile[]; excludedPaths: string[] }): string {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    createdAt: value.createdAt,
    files: value.files,
    excludedPaths: value.excludedPaths
  });
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isWithin(candidate: string, parent: string): boolean {
  const child = path.resolve(candidate);
  const root = path.resolve(parent);
  return child === root || child.startsWith(`${root}${path.sep}`);
}

function assertRelativeArchivePath(value: string): void {
  if (!value || path.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("MIGRATION_PATH_INVALID");
  }
}

function asObject(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

async function ensureDirectory(directory: string, mode = 0o700, chmodExisting = true): Promise<void> {
  const existed = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  await mkdir(directory, { recursive: true, mode });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("SERVICE_DIRECTORY_INVALID");
  if (process.platform !== "win32" && (chmodExisting || !existed)) await chmod(directory, mode);
}

async function assertNoSymlink(target: string, code = "SERVICE_PATH_INVALID"): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error(code);
}

async function writeJsonAtomic(target: string, value: unknown, mode = 0o600): Promise<void> {
  const directory = path.dirname(target);
  await ensureDirectory(directory);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(temporary, mode);
  await rename(temporary, target);
  if (process.platform !== "win32") await chmod(target, mode);
}

async function readJson<T>(file: string, code = "SERVICE_STATE_INVALID", maxBytes = MAX_JSON_BYTES): Promise<T> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error(code);
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    throw new Error(code);
  }
}

export function resolveServicePackageRoot(value?: string): string {
  const configured = value ?? process.env.CMOOC_SERVICE_ROOT;
  const root = path.resolve(configured || scriptRoot);
  if (isWithin(root, path.dirname(root)) && root === path.parse(root).root) throw new Error("SERVICE_ROOT_INVALID");
  // The manager must resolve its own package rather than inheriting the caller's cwd.
  if (!path.isAbsolute(root)) throw new Error("SERVICE_ROOT_INVALID");
  return root;
}

export function resolveServiceDataDir(value?: string, packageRoot = resolveServicePackageRoot()): string {
  const configured = value ?? process.env.CMOOC_SERVICE_DATA_DIR ?? ".cmooc-service-data";
  const result = path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(packageRoot, configured);
  if (result === path.parse(result).root || /[\r\n?#]/.test(result)) throw new Error("SERVICE_DATA_PATH_INVALID");
  return result;
}

export function serviceOrigin(port = Number(process.env.CMOOC_SERVICE_PORT || 3050)): string {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("SERVICE_PORT_INVALID");
  return `http://127.0.0.1:${port}`;
}

export function serviceStatePath(dataDir: string): string { return path.join(dataDir, SERVICE_STATE_FILE); }
export function serviceStopPath(dataDir: string): string { return path.join(dataDir, SERVICE_STOP_FILE); }
export function serviceReloginPath(dataDir: string): string { return path.join(dataDir, SERVICE_RELOGIN_FILE); }
export function serviceMigrationLockPath(dataDir: string): string { return path.join(dataDir, SERVICE_MIGRATION_LOCK); }

/** Used by the service startup path to close the stop-check/start race. */
export async function migrationLockIsActive(dataDir: string): Promise<boolean> {
  const file = serviceMigrationLockPath(dataDir);
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error("MIGRATION_LOCK_INVALID");
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as { pid?: unknown };
    if (typeof value.pid === "number") return await processIsAlive(value.pid);
  } catch {
    throw new Error("MIGRATION_LOCK_INVALID");
  }
  return false;
}

export async function readServiceRuntimeState(dataDir: string): Promise<ServiceRuntimeState | undefined> {
  const file = serviceStatePath(dataDir);
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  const value = await readJson<Partial<ServiceRuntimeState>>(file);
  const pid = value.pid;
  if (value.schemaVersion !== SERVICE_STATE_SCHEMA || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 ||
      !isUuid(value.instanceId) || !isUuid(value.namespaceId) || typeof value.runtimeToken !== "string" || value.runtimeToken.length < 32 ||
      typeof value.dataDir !== "string" || typeof value.packageRoot !== "string" || typeof value.origin !== "string" ||
      typeof value.startedAt !== "string" || !["running", "stopped", "attention"].includes(value.desired ?? "") ||
      !Number.isInteger(value.restartCount) || (value.restartWindowStartedAt !== null && typeof value.restartWindowStartedAt !== "string") ||
      (value.stopRequestedAt !== null && typeof value.stopRequestedAt !== "string")) throw new Error("SERVICE_STATE_INVALID");
  if (path.resolve(value.dataDir) !== path.resolve(dataDir)) throw new Error("SERVICE_STATE_SCOPE_MISMATCH");
  return value as ServiceRuntimeState;
}

export async function writeServiceRuntimeState(dataDir: string, value: ServiceRuntimeState): Promise<void> {
  await ensureDirectory(dataDir);
  if (path.resolve(value.dataDir) !== path.resolve(dataDir) || !isUuid(value.instanceId) || !isUuid(value.namespaceId)) throw new Error("SERVICE_STATE_SCOPE_MISMATCH");
  await writeJsonAtomic(serviceStatePath(dataDir), value, 0o600);
}

export async function removeServiceRuntimeState(dataDir: string): Promise<void> {
  await unlink(serviceStatePath(dataDir)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function readServiceStopIntent(dataDir: string): Promise<ServiceStopIntent | undefined> {
  const file = serviceStopPath(dataDir);
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  const value = await readJson<Partial<ServiceStopIntent>>(file, "SERVICE_STOP_INVALID");
  const pid = value.pid;
  if (value.schemaVersion !== "cmooc.course-service-stop-intent.v1" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 ||
      !isUuid(value.instanceId) || !isUuid(value.namespaceId) || typeof value.requestedAt !== "string") throw new Error("SERVICE_STOP_INVALID");
  return value as ServiceStopIntent;
}

export async function writeServiceStopIntent(dataDir: string, state: ServiceRuntimeState, now = new Date()): Promise<ServiceStopIntent> {
  const value: ServiceStopIntent = {
    schemaVersion: "cmooc.course-service-stop-intent.v1",
    nonce: randomUUID(), pid: state.pid, instanceId: state.instanceId, namespaceId: state.namespaceId, requestedAt: now.toISOString()
  };
  await writeJsonAtomic(serviceStopPath(dataDir), value, 0o600);
  return value;
}

export async function clearServiceStopIntent(dataDir: string): Promise<void> {
  await unlink(serviceStopPath(dataDir)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function processCommandLine(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const value = await readFile(`/proc/${pid}/cmdline`);
    const command = value.toString("utf8").split("\0").filter(Boolean).join(" ").trim();
    if (command) return command;
  } catch {
    // macOS does not expose /proc; use the system process table below.
  }
  try {
    const result = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], { maxBuffer: 64 * 1024 });
    const command = result.stdout.trim();
    return command || null;
  } catch {
    return null;
  }
}

export async function processMatchesPortableService(pid: number, packageRoot = resolveServicePackageRoot()): Promise<boolean> {
  const command = await processCommandLine(pid);
  if (!command) return false;
  const expected = path.join(path.resolve(packageRoot), "scripts", "portable-course-service.ts");
  return command.includes(expected);
}

async function healthAt(origin: string, fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): Promise<ServiceHealthIdentity | null> {
  try {
    const response = await fetchImpl(new URL("/health", origin), { method: "GET", redirect: "error", signal: AbortSignal.timeout(2_500) });
    const value = await response.json().catch(() => null);
    if (!response.ok || !value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as ServiceHealthIdentity;
  } catch {
    return null;
  }
}

export async function verifyManagedIdentity(
  state: ServiceRuntimeState,
  options: { packageRoot?: string; fetchImpl?: typeof fetch; requireHealth?: boolean } = {}
): Promise<ManagedIdentityCheck> {
  const pidAlive = await processIsAlive(state.pid);
  const commandLine = pidAlive ? await processCommandLine(state.pid) : null;
  const expectedScript = path.join(path.resolve(options.packageRoot ?? state.packageRoot), "scripts", "portable-course-service.ts");
  const commandMatches = Boolean(commandLine?.includes(expectedScript));
  const health = await healthAt(state.origin, options.fetchImpl);
  const healthMatches = Boolean(health && health.instanceId === state.instanceId && health.namespaceId === state.namespaceId &&
    health.primaryProtocol === SERVICE_PROTOCOL);
  const requireHealth = options.requireHealth ?? true;
  const verified = pidAlive && commandMatches && (requireHealth ? healthMatches : true);
  const reason = !pidAlive ? "PID_NOT_ALIVE" : !commandMatches ? "PID_COMMAND_MISMATCH" : !healthMatches && requireHealth ? "HEALTH_IDENTITY_MISMATCH" : undefined;
  return { pidAlive, commandLine, commandMatches, health, healthMatches, verified, ...(reason ? { reason } : {}) };
}

async function assertServiceStopped(dataDir: string): Promise<void> {
  const state = await readServiceRuntimeState(dataDir);
  if (state && await processIsAlive(state.pid)) throw new Error("SERVICE_RUNNING");
  const serviceLock = path.join(dataDir, "service.lock");
  const lockInfo = await lstat(serviceLock).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (lockInfo) {
    if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.size > 2048) throw new Error("SERVICE_LOCK_INVALID");
    let value: { pid?: unknown };
    try { value = JSON.parse(await readFile(serviceLock, "utf8")) as { pid?: unknown }; } catch { throw new Error("SERVICE_LOCK_INVALID"); }
    if (typeof value.pid === "number" && await processIsAlive(value.pid)) throw new Error("SERVICE_RUNNING");
  }
}

/** Checkpoint a SQLite database after the service lock is held. Other file
 * formats are copied as-is once the same stop and lock checks pass. */
async function checkpointSqliteDatabase(dataDir: string): Promise<Buffer | undefined> {
  const database = path.join(dataDir, "course.db");
  const header = await readFile(database).then((value) => value.subarray(0, 16).toString("utf8")).catch(() => "");
  if (header !== "SQLite format 3\0") return undefined;
  let client: { $queryRawUnsafe: (query: string) => Promise<unknown>; $disconnect: () => Promise<void> } | undefined;
  const snapshot = path.join(dataDir, `.cmooc-migration-snapshot-${randomUUID()}.db`);
  try {
    const { PrismaClient } = await import("@prisma/client");
    const opened = new PrismaClient({ datasources: { db: { url: `file:${database}` } } }) as unknown as NonNullable<typeof client>;
    client = opened;
    const result = await opened.$queryRawUnsafe("PRAGMA wal_checkpoint(TRUNCATE)");
    const row = Array.isArray(result) && result[0] && typeof result[0] === "object" ? result[0] as Record<string, unknown> : undefined;
    const busy = row?.busy ?? (Array.isArray(result) ? result[0] : undefined);
    if (typeof busy === "number" && busy > 0 || typeof busy === "bigint" && busy > 0n) throw new Error("DATABASE_BUSY");
    const escapedSnapshot = snapshot.replace(/'/g, "''");
    await opened.$queryRawUnsafe(`VACUUM INTO '${escapedSnapshot}'`);
  } catch {
    await unlink(snapshot).catch(() => undefined);
    throw new Error("DATABASE_BUSY");
  } finally {
    await client?.$disconnect().catch(() => undefined);
  }
  try {
    const bytes = await readFile(snapshot);
    await unlink(snapshot).catch(() => undefined);
    return bytes;
  } catch {
    await unlink(snapshot).catch(() => undefined);
    throw new Error("DATABASE_BUSY");
  }
}

function excludedCredentialPath(value: string): boolean {
  const basename = path.posix.basename(value).toLowerCase();
  if (value === "browser-courses/bridge-key" || value === "private/cmooc-research/runtime/evidence-hmac-v1.key") return false;
  return /(^|[-_.])(auth|cookie|credential|password|passwd|token|satoken|session|login|secret)([-_.]|$)/i.test(basename) ||
    /(^|\/)(logs?|cli-sessions|mcp-sessions|process-locks?)(\/|$)/i.test(value);
}

async function collectFiles(root: string, relative: string, files: ArchiveFile[], excludedPaths: string[]): Promise<void> {
  const current = path.join(root, relative);
  const info = await lstat(current);
  if (info.isSymbolicLink()) throw new Error("MIGRATION_SYMLINK_FORBIDDEN");
  if (!info.isDirectory()) throw new Error("MIGRATION_DIRECTORY_INVALID");
  const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const childRelative = `${relative}/${entry.name}`;
    const child = path.join(root, childRelative);
    const childInfo = await lstat(child);
    if (childInfo.isSymbolicLink()) throw new Error("MIGRATION_SYMLINK_FORBIDDEN");
    if (entry.isDirectory()) {
      await collectFiles(root, childRelative, files, excludedPaths);
      continue;
    }
    if (!entry.isFile()) { excludedPaths.push(childRelative); continue; }
    if (excludedCredentialPath(childRelative) || !PORTABLE_PATHS.has(childRelative)) { excludedPaths.push(childRelative); continue; }
    if (childInfo.size > MAX_ARCHIVE_BYTES) throw new Error("MIGRATION_FILE_TOO_LARGE");
    const bytes = await readFile(child);
    files.push({ path: childRelative, mode: childInfo.mode & 0o777, sizeBytes: bytes.byteLength, sha256: sha256(bytes), base64: bytes.toString("base64") });
  }
}

async function collectSource(dataDir: string, now: Date, databaseSnapshot?: Buffer): Promise<{ files: ArchiveFile[]; excludedPaths: string[] }> {
  await assertNoSymlink(dataDir, "MIGRATION_SOURCE_INVALID");
  const files: ArchiveFile[] = [];
  const excludedPaths: string[] = [];
  const requiredDatabase = path.join(dataDir, "course.db");
  const databaseInfo = await lstat(requiredDatabase).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!databaseInfo || !databaseInfo.isFile() || databaseInfo.isSymbolicLink()) throw new Error("MIGRATION_DATABASE_MISSING");
  const database = databaseSnapshot ?? await readFile(requiredDatabase);
  files.push({ path: "course.db", mode: databaseInfo.mode & 0o777, sizeBytes: database.byteLength, sha256: sha256(database), base64: database.toString("base64") });
  const namespace = path.join(dataDir, "namespace-id");
  const namespaceInfo = await lstat(namespace).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (namespaceInfo) {
    if (!namespaceInfo.isFile() || namespaceInfo.isSymbolicLink()) throw new Error("MIGRATION_NAMESPACE_INVALID");
    const value = (await readFile(namespace, "utf8")).trim();
    if (!isUuid(value)) throw new Error("MIGRATION_NAMESPACE_INVALID");
    const bytes = Buffer.from(`${value}\n`, "utf8");
    files.push({ path: "namespace-id", mode: namespaceInfo.mode & 0o777, sizeBytes: bytes.byteLength, sha256: sha256(bytes), base64: bytes.toString("base64") });
  } else {
    excludedPaths.push("namespace-id (not present; target will generate a new namespace)");
  }
  const browserRoot = path.join(dataDir, "browser-courses");
  const browserInfo = await lstat(browserRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (browserInfo) await collectFiles(dataDir, "browser-courses", files, excludedPaths);
  else excludedPaths.push("browser-courses (not present)");
  const evidence = path.join(dataDir, "private", "cmooc-research", "runtime", "evidence-hmac-v1.key");
  const evidenceInfo = await lstat(evidence).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (evidenceInfo) {
    if (!evidenceInfo.isFile() || evidenceInfo.isSymbolicLink() || evidenceInfo.size > 1024) throw new Error("MIGRATION_EVIDENCE_KEY_INVALID");
    const value = (await readFile(evidence, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("MIGRATION_EVIDENCE_KEY_INVALID");
    const bytes = Buffer.from(`${value}\n`, "utf8");
    files.push({ path: "private/cmooc-research/runtime/evidence-hmac-v1.key", mode: evidenceInfo.mode & 0o777, sizeBytes: bytes.byteLength, sha256: sha256(bytes), base64: bytes.toString("base64") });
  } else {
    excludedPaths.push("private/cmooc-research/runtime/evidence-hmac-v1.key (not present)");
  }
  // Process state, lease sessions, logs and re-login markers are intentionally not portable assets.
  for (const excluded of [SERVICE_STATE_FILE, SERVICE_STOP_FILE, SERVICE_RELOGIN_FILE, SERVICE_MIGRATION_LOCK, "service.lock", "cli-sessions", "mcp-sessions", "logs"]) {
    const info = await lstat(path.join(dataDir, excluded)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info) excludedPaths.push(excluded);
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  excludedPaths.sort();
  if (!files.some((file) => file.path === "course.db")) throw new Error("MIGRATION_DATABASE_MISSING");
  void now;
  return { files, excludedPaths };
}

function assertMigrationArchiveLocation(file: string, dataDir: string, packageRoot = resolveServicePackageRoot()): string {
  const resolved = path.resolve(file);
  if (isWithin(resolved, dataDir)) throw new Error("MIGRATION_FILE_INSIDE_DATA_DIR");
  if (isWithin(resolved, packageRoot)) throw new Error("MIGRATION_FILE_MUST_BE_OUTSIDE_PACKAGE");
  if (path.basename(resolved).startsWith(".")) throw new Error("MIGRATION_FILE_NAME_INVALID");
  return resolved;
}

export async function exportPrivateState(options: PrivateMigrationOptions): Promise<{ status: "exported"; file: string; files: number; excludedPaths: string[]; manifestSha256: string }> {
  const packageRoot = resolveServicePackageRoot(options.packageRoot);
  const dataDir = resolveServiceDataDir(options.dataDir, packageRoot);
  const file = assertMigrationArchiveLocation(options.file, dataDir, packageRoot);
  await ensureDirectory(dataDir);
  const release = await acquireLock(dataDir, SERVICE_MIGRATION_LOCK);
  try {
    await assertServiceStopped(dataDir);
    const databaseSnapshot = await checkpointSqliteDatabase(dataDir);
    const now = options.now ?? new Date();
    const source = await collectSource(dataDir, now, databaseSnapshot);
    const manifest = {
      schemaVersion: MIGRATION_SCHEMA,
      createdAt: now.toISOString(),
      files: source.files.map(({ base64: _base64, ...value }) => value),
      excludedPaths: source.excludedPaths
    } satisfies { schemaVersion: string; createdAt: string; files: ArchiveManifestFile[]; excludedPaths: string[] };
    const manifestSha256 = sha256(stableManifest(manifest));
    const archive: PrivateMigrationArchive = { ...manifest, files: source.files, manifestSha256 };
    const serialized = `${JSON.stringify(archive)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_ARCHIVE_BYTES) throw new Error("MIGRATION_ARCHIVE_TOO_LARGE");
    await ensureDirectory(path.dirname(file), 0o700, false);
    await writeFile(file, serialized, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(file, 0o600);
    return { status: "exported", file, files: source.files.length, excludedPaths: source.excludedPaths, manifestSha256 };
  } finally {
    await release();
  }
}

function verifyArchive(value: unknown): PrivateMigrationArchive {
  const archive = asObject(value, "MIGRATION_ARCHIVE_INVALID") as Partial<PrivateMigrationArchive>;
  if (archive.schemaVersion !== MIGRATION_SCHEMA || typeof archive.createdAt !== "string" || !Array.isArray(archive.files) || !Array.isArray(archive.excludedPaths) || typeof archive.manifestSha256 !== "string") throw new Error("MIGRATION_ARCHIVE_INVALID");
  const paths = new Set<string>();
  const files: ArchiveFile[] = [];
  for (const raw of archive.files) {
    const item = asObject(raw, "MIGRATION_ARCHIVE_INVALID") as Partial<ArchiveFile>;
    if (typeof item.path !== "string" || typeof item.mode !== "number" || typeof item.sizeBytes !== "number" || typeof item.sha256 !== "string" || typeof item.base64 !== "string") throw new Error("MIGRATION_ARCHIVE_INVALID");
    assertRelativeArchivePath(item.path);
    if (!PORTABLE_PATHS.has(item.path)) throw new Error("MIGRATION_PATH_NOT_ALLOWED");
    if (paths.has(item.path)) throw new Error("MIGRATION_ARCHIVE_DUPLICATE");
    paths.add(item.path);
    if (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777 || !Number.isInteger(item.sizeBytes) || item.sizeBytes < 0 || item.sizeBytes > MAX_ARCHIVE_BYTES || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("MIGRATION_ARCHIVE_INVALID");
    let bytes: Buffer;
    try { bytes = Buffer.from(item.base64, "base64"); } catch { throw new Error("MIGRATION_ARCHIVE_INVALID"); }
    if (bytes.byteLength !== item.sizeBytes || sha256(bytes) !== item.sha256) throw new Error("MIGRATION_ARCHIVE_HASH_MISMATCH");
    files.push({ path: item.path, mode: item.mode, sizeBytes: item.sizeBytes, sha256: item.sha256, base64: item.base64 });
  }
  const excludedPaths = archive.excludedPaths.map((entry) => {
    if (typeof entry !== "string" || entry.length > 300) throw new Error("MIGRATION_ARCHIVE_INVALID");
    return entry;
  }).sort();
  const manifest = { schemaVersion: MIGRATION_SCHEMA, createdAt: archive.createdAt, files: files.map(({ base64: _base64, ...item }) => item), excludedPaths };
  if (sha256(stableManifest(manifest)) !== archive.manifestSha256) throw new Error("MIGRATION_MANIFEST_MISMATCH");
  if (!files.some((item) => item.path === "course.db")) throw new Error("MIGRATION_DATABASE_MISSING");
  return { schemaVersion: MIGRATION_SCHEMA, createdAt: archive.createdAt, files, excludedPaths, manifestSha256: archive.manifestSha256 };
}

async function targetDirectoryState(dataDir: string): Promise<"missing" | "empty" | "nonempty"> {
  const info = await lstat(dataDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return "missing";
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("MIGRATION_TARGET_INVALID");
  return (await readdir(dataDir)).length === 0 ? "empty" : "nonempty";
}

function migrateWorkspaceState(value: unknown, now: Date): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = structuredClone(value) as Record<string, unknown>;
  const runs = Array.isArray(root.runs) ? root.runs : [];
  for (const candidate of runs) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const run = candidate as Record<string, unknown>;
    delete run.lease;
    const dispatch = run.dispatch && typeof run.dispatch === "object" && !Array.isArray(run.dispatch) ? run.dispatch as Record<string, unknown> : undefined;
    const dispatchState = typeof dispatch?.state === "string" ? dispatch.state : "";
    const active = ["queued", "running"].includes(typeof run.status === "string" ? run.status : "") ||
      ["executing", "host_executing", "watch_executing", "host_queued", "watch_queued", "retry_wait"].includes(dispatchState);
    if (active) {
      run.status = "queued";
      run.authState = "unknown";
      run.summary = "私有状态已迁移；等待宿主重新核验课程登录后继续。";
      if (dispatch) {
        dispatch.state = run.executor === "external_host" ? "host_queued" : "queued";
        dispatch.nextAttemptAt = now.toISOString();
        dispatch.startedAt = null;
        dispatch.lastFailureCode = "MIGRATION_HOST_REVALIDATION_REQUIRED";
      }
      delete run.executionRunId;
    }
  }
  return root;
}

async function writeArchiveFiles(staging: string, archive: PrivateMigrationArchive, now: Date): Promise<void> {
  for (const item of archive.files) {
    assertRelativeArchivePath(item.path);
    const target = path.join(staging, item.path);
    await ensureDirectory(path.dirname(target));
    const bytes = Buffer.from(item.base64, "base64");
    let output = bytes;
    if (item.path === "browser-courses/workspace.json") {
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("MIGRATION_WORKSPACE_INVALID"); }
      output = Buffer.from(`${JSON.stringify(migrateWorkspaceState(parsed, now))}\n`, "utf8");
    }
    await writeFile(target, output, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await chmod(target, 0o600);
  }
  const marker = {
    schemaVersion: "cmooc.host-relogin-required.v1",
    required: true,
    reason: "private_state_imported",
    importedAt: now.toISOString(),
    sourceManifestSha256: archive.manifestSha256
  };
  await writeJsonAtomic(path.join(staging, SERVICE_RELOGIN_FILE), marker, 0o600);
}

export async function importPrivateState(options: PrivateMigrationOptions): Promise<{ status: "imported"; dataDir: string; files: number; manifestSha256: string; hostRevalidationRequired: true }> {
  const packageRoot = resolveServicePackageRoot(options.packageRoot);
  const dataDir = resolveServiceDataDir(options.dataDir, packageRoot);
  const file = assertMigrationArchiveLocation(options.file, dataDir, packageRoot);
  const archiveBytes = await readFile(file);
  if (archiveBytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error("MIGRATION_ARCHIVE_TOO_LARGE");
  let archiveValue: unknown;
  try { archiveValue = JSON.parse(archiveBytes.toString("utf8")); } catch { throw new Error("MIGRATION_ARCHIVE_INVALID"); }
  const archive = verifyArchive(archiveValue);
  const state = await targetDirectoryState(dataDir);
  if (state === "nonempty") throw new Error("MIGRATION_TARGET_NOT_EMPTY");
  const parent = path.dirname(dataDir);
  await ensureDirectory(parent, 0o700, false);
  const staging = path.join(parent, `.cmooc-private-import-${randomUUID()}`);
  await ensureDirectory(staging);
  const now = options.now ?? new Date();
  try {
    await writeArchiveFiles(staging, archive, now);
    const existingState = await targetDirectoryState(dataDir);
    if (existingState === "nonempty") throw new Error("MIGRATION_TARGET_CHANGED");
    if (existingState === "empty") await rmdir(dataDir);
    await rename(staging, dataDir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { status: "imported", dataDir, files: archive.files.length, manifestSha256: archive.manifestSha256, hostRevalidationRequired: true };
}

function parseStateCli(args: string[]): { command: "export" | "import"; dataDir?: string; file: string; packageRoot?: string } {
  const command = args.shift();
  if (command !== "export" && command !== "import") throw new Error("USAGE: course-service-state.ts export|import --file PATH [--data-dir PATH]");
  let dataDir: string | undefined;
  let file: string | undefined;
  let packageRoot: string | undefined;
  while (args.length) {
    const option = args.shift();
    const value = args.shift();
    if (!value || !["--data-dir", "--file", "--root"].includes(option ?? "")) throw new Error("MIGRATION_OPTIONS_INVALID");
    if (option === "--data-dir") dataDir = value;
    else if (option === "--file") file = value;
    else packageRoot = value;
  }
  if (!file) throw new Error("MIGRATION_FILE_REQUIRED");
  return { command, dataDir, file, packageRoot };
}

export async function runCourseServiceStateCli(args = process.argv.slice(2)): Promise<void> {
  if (!args.length || args[0] === "--help") {
    process.stdout.write("私有课程状态迁移（仅私有资产；请把 --file 放在源码包和日志目录之外）\n用法: export|import --file PATH [--data-dir PATH] [--root PACKAGE_ROOT]\nexport 要求服务已停止；import 只接受不存在或空目标，不覆盖已有数据。\n");
    return;
  }
  const parsed = parseStateCli([...args]);
  const value = parsed.command === "export" ? await exportPrivateState(parsed) : await importPrivateState(parsed);
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCourseServiceStateCli().catch((error) => {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message) ? error.message : "MIGRATION_FAILED";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  });
}
