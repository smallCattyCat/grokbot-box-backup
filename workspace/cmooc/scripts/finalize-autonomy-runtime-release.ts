import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTONOMY_RELEASE_MANIFEST_SCHEMA_VERSION,
  AUTONOMY_RELEASE_RECEIPT_SCHEMA_VERSION,
  type AutonomyReleaseManifest,
  type AutonomyReleaseReceipt
} from "./build-autonomy-release";

export const AUTONOMY_RUNTIME_RELEASE_RECEIPT_SCHEMA_VERSION =
  "cmooc.autonomy-runtime-release-receipt.v2" as const;

const SAFE_RUNTIME_VERSION =
  /^v[1-9][0-9]*(?:\.[0-9]+){0,2}-(?:alpha|beta|rc)[1-9][0-9]*$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MIGRATION_DIRECTORY_PATTERN = /^[0-9]{14}_[a-z0-9_]+$/u;

const REQUIRED_ENVIRONMENT_KEYS = [
  "CMOOC_COURSE_MANIFEST_DIR",
  "CMOOC_DISABLE_WINDOWS_ENV_FALLBACK",
  "DATABASE_URL"
] as const;

const CREDENTIAL_KEY_PATTERN =
  /(?:^|_)(?:api_?key|auth|cookie|credential|password|secret|token)(?:_|$)/iu;

const REQUIRED_PACKAGE_SCRIPTS = [
  "build",
  "start",
  "prisma:migrate",
  "autonomy:tick",
  "autonomy:worker",
  "autonomy:soak-readiness",
  "autonomy:release",
  "autonomy:release:finalize",
  "autonomy:governance",
  "autonomy:graph-status",
  "autonomy:l3"
] as const;

const REQUIRED_RUNTIME_PACKAGES = [
  "@prisma/client",
  "next",
  "prisma",
  "react",
  "react-dom",
  "tsx"
] as const;

const REQUIRED_BUILD_FILES = [
  ".next/BUILD_ID",
  ".next/required-server-files.json",
  ".next/server/app-paths-manifest.json",
  ".next/server/middleware-manifest.json"
] as const;

const BROWSER_SESSION_STATE_PATH = "playwright/auth-state.json" as const;

type RuntimeReleaseSourceReceipt = AutonomyReleaseReceipt & {
  receiptSha256: string;
};

export type AutonomyRuntimeReleaseReceipt = {
  schemaVersion: typeof AUTONOMY_RUNTIME_RELEASE_RECEIPT_SCHEMA_VERSION;
  runtimeVersion: string;
  status: "ready";
  runtimeReady: true;
  blockers: [];
  source: {
    verified: true;
    fileCount: number;
    aggregateSha256: string;
    manifestSha256: string;
    sourceReceiptSha256: string;
  };
  dependencies: {
    installed: true;
    selfContained: true;
    requiredPackages: readonly string[];
  };
  environment: {
    injected: true;
    exactKeySet: true;
    credentialKeysPresent: false;
    externalBindingsValidated: true;
    keyNames: readonly string[];
  };
  browserSession: {
    storageStatePresent: true;
    storageStateLinked: false;
    storageStateContentInspected: false;
  };
  productionBuild: {
    created: true;
    buildIdSha256: string;
    requiredFiles: readonly string[];
  };
  packageScripts: {
    projected: true;
    guaranteedCommands: readonly string[];
  };
  database: {
    migrationLockPresent: true;
    migrationCount: number;
  };
  safety: {
    sourceFilesVerified: true;
    nodeModulesLinked: false;
    realForumWriteHardLockVerified: true;
    realPublishManifestContractVerified: true;
    externalMutationAttempted: false;
    automationModified: false;
    containsForumText: false;
  };
  finalizedAt: string;
  receiptSha256: string;
};

export type FinalizeAutonomyRuntimeReleaseOptions = {
  releaseDirectory?: string;
  runtimeVersion: string;
  now?: Date;
};

export class AutonomyRuntimeReleaseFinalizeError extends Error {
  constructor(
    readonly code:
      | "invalid_runtime_version"
      | "unsafe_release_directory"
      | "invalid_source_receipt"
      | "source_drift"
      | "dependencies_unavailable"
      | "environment_invalid"
      | "production_build_missing"
      | "package_script_missing"
      | "migration_surface_invalid"
      | "safety_contract_invalid"
      | "receipt_exists",
    message: string
  ) {
    super(message);
    this.name = "AutonomyRuntimeReleaseFinalizeError";
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    compareText(a, b)
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sameResolvedPath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

async function readRegularFileWithin(
  releaseDirectory: string,
  relativePath: string,
  errorCode: AutonomyRuntimeReleaseFinalizeError["code"]
): Promise<Buffer> {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new AutonomyRuntimeReleaseFinalizeError(errorCode, "Release file path is invalid.");
  }
  const absolutePath = path.resolve(releaseDirectory, ...relativePath.split("/"));
  if (!isInside(releaseDirectory, absolutePath)) {
    throw new AutonomyRuntimeReleaseFinalizeError(errorCode, "Release file escaped its root.");
  }
  let canonicalBefore: string;
  try {
    canonicalBefore = path.resolve(await realpath(absolutePath));
  } catch {
    throw new AutonomyRuntimeReleaseFinalizeError(errorCode, "Required release file is missing.");
  }
  if (!isInside(releaseDirectory, canonicalBefore)) {
    throw new AutonomyRuntimeReleaseFinalizeError(errorCode, "Release file resolved outside its root.");
  }
  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await open(absolutePath, flags);
  try {
    const [handleStats, pathStats, canonicalAfter] = await Promise.all([
      handle.stat(),
      lstat(absolutePath),
      realpath(absolutePath)
    ]);
    if (
      !handleStats.isFile() ||
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      !sameResolvedPath(canonicalBefore, canonicalAfter)
    ) {
      throw new AutonomyRuntimeReleaseFinalizeError(errorCode, "Release file identity is unsafe.");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readJsonFile(
  releaseDirectory: string,
  relativePath: string,
  errorCode: AutonomyRuntimeReleaseFinalizeError["code"]
): Promise<Record<string, unknown>> {
  const content = await readRegularFileWithin(releaseDirectory, relativePath, errorCode);
  try {
    const parsed: unknown = JSON.parse(content.toString("utf8"));
    if (!isRecord(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new AutonomyRuntimeReleaseFinalizeError(errorCode, "Release JSON is invalid.");
  }
}

function validateManifest(
  value: Record<string, unknown>,
  runtimeVersion: string
): AutonomyReleaseManifest {
  if (
    value.schemaVersion !== AUTONOMY_RELEASE_MANIFEST_SCHEMA_VERSION ||
    value.runtimeVersion !== runtimeVersion ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    typeof value.aggregateSha256 !== "string" ||
    !HASH_PATTERN.test(value.aggregateSha256)
  ) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "invalid_source_receipt",
      "Source manifest is invalid."
    );
  }
  const files = value.files.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !HASH_PATTERN.test(entry.sha256) ||
      typeof entry.sizeBytes !== "number" ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0
    ) {
      throw new AutonomyRuntimeReleaseFinalizeError(
        "invalid_source_receipt",
        "Source manifest file entry is invalid."
      );
    }
    return {
      path: entry.path,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes
    };
  });
  const sortedPaths = files.map((file) => file.path).sort(compareText);
  if (
    sortedPaths.some((entry, index) => entry !== files[index]?.path) ||
    new Set(sortedPaths).size !== sortedPaths.length
  ) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "invalid_source_receipt",
      "Source manifest paths are not unique and sorted."
    );
  }
  return {
    schemaVersion: AUTONOMY_RELEASE_MANIFEST_SCHEMA_VERSION,
    runtimeVersion,
    files,
    aggregateSha256: value.aggregateSha256
  };
}

function validateSourceReceipt(
  value: Record<string, unknown>,
  runtimeVersion: string,
  manifest: AutonomyReleaseManifest
): RuntimeReleaseSourceReceipt {
  const expectedBlockers = [
    "dependencies_not_installed",
    "runtime_environment_not_injected",
    "production_build_not_created",
    "package_script_surface_not_projected",
    "filesystem_no_replace_not_guaranteed"
  ];
  if (
    value.schemaVersion !== AUTONOMY_RELEASE_RECEIPT_SCHEMA_VERSION ||
    value.runtimeVersion !== runtimeVersion ||
    value.mode !== "apply" ||
    value.status !== "created" ||
    value.targetDirectoryName !== `${runtimeVersion}-release` ||
    value.fileCount !== manifest.files.length ||
    value.runtimeReady !== false ||
    typeof value.manifestSha256 !== "string" ||
    value.manifestSha256 !== sha256(stableJson(manifest)) ||
    typeof value.receiptSha256 !== "string" ||
    !HASH_PATTERN.test(value.receiptSha256) ||
    !Array.isArray(value.blockers) ||
    value.blockers.length !== expectedBlockers.length ||
    value.blockers.some((entry, index) => entry !== expectedBlockers[index]) ||
    !isRecord(value.dependencies) ||
    value.dependencies.included !== false ||
    value.dependencies.installed !== false ||
    value.dependencies.lockfileIncluded !== true ||
    !isRecord(value.environment) ||
    value.environment.included !== false ||
    value.environment.injected !== false ||
    !isRecord(value.packageScripts) ||
    value.packageScripts.projected !== false ||
    !Array.isArray(value.packageScripts.guaranteedCommands) ||
    !value.packageScripts.guaranteedCommands.includes("autonomy:release:finalize") ||
    !isRecord(value.safety) ||
    value.safety.allowlistOnly !== true ||
    value.safety.nodeModulesCopied !== false ||
    value.safety.testsCopied !== false ||
    value.safety.automationModified !== false ||
    value.safety.externalMutationAttempted !== false
  ) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "invalid_source_receipt",
      "Source release receipt is invalid."
    );
  }
  const { receiptSha256, ...payload } = value;
  if (receiptSha256 !== sha256(stableJson(payload))) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "invalid_source_receipt",
      "Source release receipt hash is invalid."
    );
  }
  return value as RuntimeReleaseSourceReceipt;
}

async function verifySourceFiles(
  releaseDirectory: string,
  manifest: AutonomyReleaseManifest
): Promise<void> {
  const aggregateRows: string[] = [];
  for (const file of manifest.files) {
    const content = await readRegularFileWithin(releaseDirectory, file.path, "source_drift");
    if (content.byteLength !== file.sizeBytes || sha256(content) !== file.sha256) {
      throw new AutonomyRuntimeReleaseFinalizeError(
        "source_drift",
        "Release source no longer matches its manifest."
      );
    }
    aggregateRows.push(`${file.path}\0${file.sizeBytes}\0${file.sha256}\n`);
  }
  if (sha256(aggregateRows.join("")) !== manifest.aggregateSha256) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "source_drift",
      "Release aggregate source hash is invalid."
    );
  }
}

async function verifySelfContainedDependencies(releaseDirectory: string): Promise<void> {
  const nodeModules = path.resolve(releaseDirectory, "node_modules");
  let nodeModulesStats;
  try {
    nodeModulesStats = await lstat(nodeModules);
  } catch {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "dependencies_unavailable",
      "Runtime dependencies are not installed."
    );
  }
  if (
    !nodeModulesStats.isDirectory() ||
    nodeModulesStats.isSymbolicLink() ||
    !sameResolvedPath(nodeModules, await realpath(nodeModules))
  ) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "dependencies_unavailable",
      "Runtime dependencies must be a self-contained directory."
    );
  }
  for (const packageName of REQUIRED_RUNTIME_PACKAGES) {
    const packageDirectory = path.resolve(
      nodeModules,
      ...packageName.split("/")
    );
    if (!isInside(nodeModules, packageDirectory)) {
      throw new AutonomyRuntimeReleaseFinalizeError(
        "dependencies_unavailable",
        "Required dependency escaped node_modules."
      );
    }
    let stats;
    try {
      stats = await lstat(packageDirectory);
    } catch {
      throw new AutonomyRuntimeReleaseFinalizeError(
        "dependencies_unavailable",
        "A required runtime dependency is missing."
      );
    }
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      !isInside(releaseDirectory, await realpath(packageDirectory))
    ) {
      throw new AutonomyRuntimeReleaseFinalizeError(
        "dependencies_unavailable",
        "A required runtime dependency is linked or unsafe."
      );
    }
  }
}

function parseEnvironment(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) {
      throw new AutonomyRuntimeReleaseFinalizeError(
        "environment_invalid",
        "Runtime environment line is invalid."
      );
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Z][A-Z0-9_]{1,80}$/u.test(key) || !value || result.has(key)) {
      throw new AutonomyRuntimeReleaseFinalizeError(
        "environment_invalid",
        "Runtime environment key set is invalid."
      );
    }
    result.set(key, value);
  }
  return result;
}

async function verifyEnvironment(releaseDirectory: string): Promise<void> {
  const content = await readRegularFileWithin(
    releaseDirectory,
    ".env.local",
    "environment_invalid"
  );
  const environment = parseEnvironment(content.toString("utf8"));
  const keys = [...environment.keys()].sort(compareText);
  if (
    keys.length !== REQUIRED_ENVIRONMENT_KEYS.length ||
    keys.some((key, index) => key !== REQUIRED_ENVIRONMENT_KEYS[index]) ||
    keys.some((key) => CREDENTIAL_KEY_PATTERN.test(key)) ||
    environment.get("CMOOC_DISABLE_WINDOWS_ENV_FALLBACK") !== "1"
  ) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "environment_invalid",
      "Runtime environment is not the exact path-only contract."
    );
  }
  const databaseUrl = environment.get("DATABASE_URL") ?? "";
  const manifestDirectory = environment.get("CMOOC_COURSE_MANIFEST_DIR") ?? "";
  if (!databaseUrl.startsWith("file:") || !path.isAbsolute(manifestDirectory)) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "environment_invalid",
      "Runtime environment bindings are invalid."
    );
  }
  let manifestStats;
  try {
    manifestStats = await lstat(manifestDirectory);
  } catch {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "environment_invalid",
      "Course manifest directory is unavailable."
    );
  }
  if (!manifestStats.isDirectory()) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "environment_invalid",
      "Course manifest binding is not a directory."
    );
  }
}

async function verifyBrowserSessionState(releaseDirectory: string): Promise<void> {
  const storageStatePath = path.resolve(
    releaseDirectory,
    ...BROWSER_SESSION_STATE_PATH.split("/")
  );
  if (!isInside(releaseDirectory, storageStatePath)) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "environment_invalid",
      "Browser session binding escaped the release root."
    );
  }
  let stats;
  let canonicalPath: string;
  try {
    [stats, canonicalPath] = await Promise.all([
      lstat(storageStatePath),
      realpath(storageStatePath)
    ]);
  } catch {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "environment_invalid",
      "Browser session state is unavailable."
    );
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size < 1 ||
    !sameResolvedPath(storageStatePath, canonicalPath) ||
    !isInside(releaseDirectory, canonicalPath)
  ) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "environment_invalid",
      "Browser session state binding is unsafe."
    );
  }
}

async function verifyPackageScripts(releaseDirectory: string): Promise<void> {
  const packageJson = await readJsonFile(
    releaseDirectory,
    "package.json",
    "package_script_missing"
  );
  if (!isRecord(packageJson.scripts)) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "package_script_missing",
      "Package scripts are unavailable."
    );
  }
  for (const command of REQUIRED_PACKAGE_SCRIPTS) {
    const script = packageJson.scripts[command];
    if (typeof script !== "string" || !script.trim()) {
      throw new AutonomyRuntimeReleaseFinalizeError(
        "package_script_missing",
        "A required package script is missing."
      );
    }
  }
}

async function verifyProductionBuild(releaseDirectory: string): Promise<string> {
  for (const relativePath of REQUIRED_BUILD_FILES) {
    await readRegularFileWithin(
      releaseDirectory,
      relativePath,
      "production_build_missing"
    );
  }
  const buildId = await readRegularFileWithin(
    releaseDirectory,
    ".next/BUILD_ID",
    "production_build_missing"
  );
  if (!buildId.toString("utf8").trim()) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "production_build_missing",
      "Production build id is empty."
    );
  }
  return sha256(buildId);
}

async function verifyMigrationSurface(releaseDirectory: string): Promise<number> {
  await readRegularFileWithin(
    releaseDirectory,
    "prisma/migrations/migration_lock.toml",
    "migration_surface_invalid"
  );
  const migrationsDirectory = path.resolve(releaseDirectory, "prisma", "migrations");
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrations = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => MIGRATION_DIRECTORY_PATTERN.test(name))
    .sort(compareText);
  if (migrations.length < 1) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "migration_surface_invalid",
      "No runtime migrations are available."
    );
  }
  for (const migration of migrations) {
    await readRegularFileWithin(
      releaseDirectory,
      `prisma/migrations/${migration}/migration.sql`,
      "migration_surface_invalid"
    );
  }
  return migrations.length;
}

async function verifySafetyContracts(releaseDirectory: string): Promise<void> {
  const [writeLock, manifestContract] = await Promise.all([
    readRegularFileWithin(
      releaseDirectory,
      "lib/forum/real-write-lock.ts",
      "safety_contract_invalid"
    ),
    readRegularFileWithin(
      releaseDirectory,
      "lib/autonomy/course-manifest.ts",
      "safety_contract_invalid"
    )
  ]);
  if (
    !/export const REAL_FORUM_WRITE_LOCKED\s*=\s*true;/u.test(
      writeLock.toString("utf8")
    ) ||
    !/realPublishEnabled:\s*false/u.test(manifestContract.toString("utf8"))
  ) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "safety_contract_invalid",
      "Zero-publish safety contracts are not present."
    );
  }
}

export async function finalizeAutonomyRuntimeRelease(
  options: FinalizeAutonomyRuntimeReleaseOptions
): Promise<AutonomyRuntimeReleaseReceipt> {
  if (!SAFE_RUNTIME_VERSION.test(options.runtimeVersion)) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "invalid_runtime_version",
      "Runtime version is invalid."
    );
  }
  const requestedDirectory = path.resolve(options.releaseDirectory ?? process.cwd());
  let releaseDirectory: string;
  try {
    releaseDirectory = path.resolve(await realpath(requestedDirectory));
  } catch {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "unsafe_release_directory",
      "Release directory does not exist."
    );
  }
  const directoryStats = await lstat(requestedDirectory);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    !sameResolvedPath(requestedDirectory, releaseDirectory) ||
    path.basename(releaseDirectory) !== `${options.runtimeVersion}-release`
  ) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "unsafe_release_directory",
      "Release directory identity does not match the runtime version."
    );
  }

  const manifest = validateManifest(
    await readJsonFile(releaseDirectory, "manifest.json", "invalid_source_receipt"),
    options.runtimeVersion
  );
  const sourceReceipt = validateSourceReceipt(
    await readJsonFile(releaseDirectory, "receipt.json", "invalid_source_receipt"),
    options.runtimeVersion,
    manifest
  );

  await verifySourceFiles(releaseDirectory, manifest);
  await Promise.all([
    verifySelfContainedDependencies(releaseDirectory),
    verifyEnvironment(releaseDirectory),
    verifyBrowserSessionState(releaseDirectory),
    verifyPackageScripts(releaseDirectory),
    verifySafetyContracts(releaseDirectory)
  ]);
  const [buildIdSha256, migrationCount] = await Promise.all([
    verifyProductionBuild(releaseDirectory),
    verifyMigrationSurface(releaseDirectory)
  ]);

  const finalizedAt = new Date(options.now ?? new Date());
  if (!Number.isFinite(finalizedAt.getTime())) {
    throw new AutonomyRuntimeReleaseFinalizeError(
      "invalid_source_receipt",
      "Finalization time is invalid."
    );
  }
  const payload = {
    schemaVersion: AUTONOMY_RUNTIME_RELEASE_RECEIPT_SCHEMA_VERSION,
    runtimeVersion: options.runtimeVersion,
    status: "ready" as const,
    runtimeReady: true as const,
    blockers: [] as [],
    source: {
      verified: true as const,
      fileCount: manifest.files.length,
      aggregateSha256: manifest.aggregateSha256,
      manifestSha256: sourceReceipt.manifestSha256,
      sourceReceiptSha256: sourceReceipt.receiptSha256
    },
    dependencies: {
      installed: true as const,
      selfContained: true as const,
      requiredPackages: [...REQUIRED_RUNTIME_PACKAGES]
    },
    environment: {
      injected: true as const,
      exactKeySet: true as const,
      credentialKeysPresent: false as const,
      externalBindingsValidated: true as const,
      keyNames: [...REQUIRED_ENVIRONMENT_KEYS]
    },
    browserSession: {
      storageStatePresent: true as const,
      storageStateLinked: false as const,
      storageStateContentInspected: false as const
    },
    productionBuild: {
      created: true as const,
      buildIdSha256,
      requiredFiles: [...REQUIRED_BUILD_FILES]
    },
    packageScripts: {
      projected: true as const,
      guaranteedCommands: [...REQUIRED_PACKAGE_SCRIPTS]
    },
    database: {
      migrationLockPresent: true as const,
      migrationCount
    },
    safety: {
      sourceFilesVerified: true as const,
      nodeModulesLinked: false as const,
      realForumWriteHardLockVerified: true as const,
      realPublishManifestContractVerified: true as const,
      externalMutationAttempted: false as const,
      automationModified: false as const,
      containsForumText: false as const
    },
    finalizedAt: finalizedAt.toISOString()
  };
  const receipt: AutonomyRuntimeReleaseReceipt = {
    ...payload,
    receiptSha256: sha256(stableJson(payload))
  };
  try {
    await writeFile(
      path.join(releaseDirectory, "runtime-receipt.json"),
      `${stableJson(receipt)}\n`,
      { flag: "wx" }
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AutonomyRuntimeReleaseFinalizeError(
        "receipt_exists",
        "Runtime release receipt already exists."
      );
    }
    throw error;
  }
  return receipt;
}

type CliArguments = {
  help: boolean;
  releaseDirectory?: string;
  runtimeVersion: string;
};

export function parseRuntimeReleaseFinalizeArguments(args: readonly string[]): CliArguments {
  const parsed: CliArguments = {
    help: false,
    runtimeVersion: "v1-rc13"
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--version" && args[index + 1]) {
      parsed.runtimeVersion = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--version=")) {
      parsed.runtimeVersion = argument.slice("--version=".length);
    } else if (argument === "--release-dir" && args[index + 1]) {
      parsed.releaseDirectory = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--release-dir=")) {
      parsed.releaseDirectory = argument.slice("--release-dir=".length);
    } else {
      throw new AutonomyRuntimeReleaseFinalizeError(
        "unsafe_release_directory",
        "Unknown runtime release finalizer argument."
      );
    }
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: npm run autonomy:release:finalize -- [--version v1-rc13] [--release-dir PATH]",
      "Validates one prepared release and writes runtime-receipt.json without exposing environment values.",
      ""
    ].join("\n")
  );
}

async function main(): Promise<void> {
  try {
    const args = parseRuntimeReleaseFinalizeArguments(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }
    const result = await finalizeAutonomyRuntimeRelease({
      releaseDirectory: args.releaseDirectory,
      runtimeVersion: args.runtimeVersion
    });
    process.stdout.write(`${stableJson(result)}\n`);
  } catch (error) {
    const code =
      error instanceof AutonomyRuntimeReleaseFinalizeError
        ? error.code
        : "runtime_release_finalize_failed";
    process.stderr.write(
      `${stableJson({
        code,
        containsForumText: false,
        runtimeReady: false,
        status: "failed"
      })}\n`
    );
    process.exitCode = 1;
  }
}

const modulePath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entryPath && sameResolvedPath(modulePath, entryPath)) {
  void main();
}
