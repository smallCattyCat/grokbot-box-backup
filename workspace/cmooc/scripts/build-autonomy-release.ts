import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_AUTONOMY_RELEASE_VERSION = "v1-rc13";
export const AUTONOMY_RELEASE_MANIFEST_SCHEMA_VERSION =
  "cmooc.autonomy-release-manifest.v1";
export const AUTONOMY_RELEASE_RECEIPT_SCHEMA_VERSION =
  "cmooc.autonomy-release-receipt.v1";

const SAFE_RUNTIME_VERSION =
  /^v[1-9][0-9]*(?:\.[0-9]+){0,2}-(?:alpha|beta|rc)[1-9][0-9]*$/u;

const REQUIRED_FILES = [
  "package.json",
  "package-lock.json",
  "next.config.mjs",
  "next-env.d.ts",
  "tsconfig.json",
  "tailwind.config.ts",
  "postcss.config.mjs",
  "middleware.ts",
  "fixtures/p4d1/golden-path-resource-connection-v1.json",
  "fixtures/p4f-lite/fidelity-rubric-v1.json",
  "prisma/schema.prisma",
  "configs/courses/bnu-test-course.template.json",
  "scripts/autonomy-tick.ts",
  "scripts/autonomy-worker.ts",
  "scripts/autonomy-soak-readiness.ts",
  "scripts/autonomy-governance.ts",
  "scripts/autonomy-l3.ts",
  "scripts/course-graph-status.ts",
  "scripts/prisma-migrate-safe.ts",
  "scripts/scenario_lab_oasis_sidecar.py",
  "scripts/build-autonomy-release.ts",
  "scripts/finalize-autonomy-runtime-release.ts"
] as const;

const REVIEWED_SENSITIVE_NAME_EXCEPTIONS = new Set([
  "configs/courses/bnu-test-course.template.json"
]);

const DIRECTORY_ALLOWLIST = [
  {
    directory: "app",
    extensions: new Set([".css", ".json", ".svg", ".ts", ".tsx"]),
    required: true
  },
  {
    directory: "components",
    extensions: new Set([".css", ".json", ".svg", ".ts", ".tsx"]),
    required: true
  },
  {
    directory: "lib",
    extensions: new Set([".json", ".ts", ".tsx"]),
    required: true
  },
  {
    directory: "prisma/migrations",
    extensions: new Set([".sql", ".toml"]),
    required: true
  },
  {
    directory: "public",
    extensions: new Set([".avif", ".ico", ".jpg", ".jpeg", ".png", ".svg", ".txt", ".webp"]),
    required: false
  }
] as const;

const SOURCE_CONTAINER_DIRECTORIES = [
  "app",
  "components",
  "configs",
  "fixtures",
  "lib",
  "prisma",
  "public",
  "scripts"
] as const;

const DENIED_SEGMENTS = new Set([
  ".next",
  "artifacts",
  "auth",
  "credentials",
  "logs",
  "node_modules",
  "secrets",
  "test-results",
  "tests"
]);

const DENIED_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  "auth-state.json",
  "cookies.json",
  "credentials.json",
  "storage-state.json"
]);

const DENIED_FILE_EXTENSIONS = new Set([
  ".db",
  ".key",
  ".log",
  ".p12",
  ".pem",
  ".pfx",
  ".sqlite",
  ".sqlite3"
]);

const DENIED_CREDENTIAL_FILE_PATTERN =
  /(?:^|[-_.])(?:api[-_]?key|auth[-_]?state|cookies?|credentials?|secrets?|storage[-_]?state|tokens?)(?:[-_.]|$)/u;
const DENIED_TEST_FILE_PATTERN = /(?:^|[-_.])(?:spec|test)(?:[-_.]|$)/u;
const DENIED_PRIVATE_DATA_FILE_PATTERN =
  /(?:^|[-_.])session(?:[-_.]|$)/u;

export const AUTONOMY_RELEASE_HARD_EXCLUSIONS = [
  ".env and .env.*",
  "database files",
  "auth state and credential material",
  "logs and generated artifacts",
  "tests and test results",
  ".next",
  "node_modules"
] as const;

export type AutonomyReleaseFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

export type AutonomyReleaseManifest = {
  schemaVersion: typeof AUTONOMY_RELEASE_MANIFEST_SCHEMA_VERSION;
  runtimeVersion: string;
  files: AutonomyReleaseFile[];
  aggregateSha256: string;
};

export type AutonomyReleaseReceipt = {
  schemaVersion: typeof AUTONOMY_RELEASE_RECEIPT_SCHEMA_VERSION;
  runtimeVersion: string;
  mode: "dry_run" | "apply";
  status: "planned" | "created";
  targetDirectoryName: string;
  fileCount: number;
  contentBytes: number;
  manifestSha256: string;
  receiptSha256: string;
  dependencies: {
    included: false;
    installed: false;
    lockfileIncluded: true;
  };
  environment: {
    included: false;
    injected: false;
  };
  runtimeReady: false;
  blockers: readonly [
    "dependencies_not_installed",
    "runtime_environment_not_injected",
    "production_build_not_created",
    "package_script_surface_not_projected",
    "filesystem_no_replace_not_guaranteed"
  ];
  packageScripts: {
    projected: false;
    guaranteedCommands: readonly string[];
  };
  promotion: {
    strategy: "atomic_directory_rename";
    builderConcurrencyLock: true;
    filesystemNoReplaceGuaranteed: false;
  };
  safety: {
    allowlistOnly: true;
    hardExclusions: readonly string[];
    nodeModulesCopied: false;
      testsCopied: false;
      targetOverwriteAttempted: false;
      automationModified: false;
    externalMutationAttempted: false;
  };
};

export type BuildAutonomyReleaseOptions = {
  projectRoot?: string;
  releaseRoot?: string;
  runtimeVersion?: string;
  apply?: boolean;
  /** Test-only fault injection used to verify staging cleanup. */
  testFault?: "before_promote";
};

export type BuildAutonomyReleaseResult = {
  manifest: AutonomyReleaseManifest;
  receipt: AutonomyReleaseReceipt;
  targetDirectory: string;
};

export class AutonomyReleaseBuildError extends Error {
  constructor(
    readonly code:
      | "invalid_runtime_version"
      | "missing_required_source"
      | "output_overlaps_source"
      | "unsafe_output_root"
      | "source_changed"
      | "target_exists"
      | "unsafe_source_entry",
    message: string
  ) {
    super(message);
    this.name = "AutonomyReleaseBuildError";
  }
}

function toPortablePath(value: string): string {
  return value.split(path.sep).join("/");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
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

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sameResolvedPath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

async function canonicalizeFuturePath(candidate: string): Promise<string> {
  let existingAncestor = path.resolve(candidate);
  const missingSegments: string[] = [];
  while (!(await pathExists(existingAncestor))) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new AutonomyReleaseBuildError(
        "unsafe_output_root",
        "Release output has no resolvable existing ancestor."
      );
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  try {
    const canonicalAncestor = await realpath(existingAncestor);
    return path.resolve(canonicalAncestor, ...missingSegments);
  } catch {
    throw new AutonomyReleaseBuildError(
      "unsafe_output_root",
      "Release output contains an unresolved or unsafe link."
    );
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readSafeSourceFile(
  projectRoot: string,
  relativePath: string
): Promise<Buffer> {
  const absolutePath = path.resolve(projectRoot, relativePath);
  if (!isInside(projectRoot, absolutePath)) {
    throw new AutonomyReleaseBuildError(
      "unsafe_source_entry",
      `Release source escaped the project root: ${relativePath}`
    );
  }
  const canonicalBefore = path.resolve(await realpath(absolutePath));
  if (!isInside(projectRoot, canonicalBefore)) {
    throw new AutonomyReleaseBuildError(
      "unsafe_source_entry",
      `Release source resolved outside the project root: ${relativePath}`
    );
  }
  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  const handle = await open(absolutePath, flags);
  try {
    const [sourceStats, canonicalAfter] = await Promise.all([
      handle.stat(),
      realpath(absolutePath)
    ]);
    const pathStats = await lstat(absolutePath);
    if (
      !sourceStats.isFile() ||
      !pathStats.isFile() ||
      pathStats.isSymbolicLink() ||
      !sameResolvedPath(canonicalBefore, canonicalAfter)
    ) {
      throw new AutonomyReleaseBuildError(
        "unsafe_source_entry",
        `Release source changed identity while being read: ${relativePath}`
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function assertSafeRuntimeVersion(runtimeVersion: string): void {
  if (!SAFE_RUNTIME_VERSION.test(runtimeVersion)) {
    throw new AutonomyReleaseBuildError(
      "invalid_runtime_version",
      "Runtime version must use a safe prerelease form such as v1-rc13."
    );
  }
}

function isSensitivePath(relativePath: string): boolean {
  const portable = toPortablePath(relativePath);
  const segments = portable.toLowerCase().split("/");
  const fileName = segments.at(-1) ?? "";
  const extension = path.extname(fileName);

  if (segments.some((segment) => DENIED_SEGMENTS.has(segment))) return true;
  if (DENIED_FILE_NAMES.has(fileName)) return true;
  if (/^\.env(?:$|[.-])/u.test(fileName)) return true;
  if (DENIED_FILE_EXTENSIONS.has(extension)) return true;
  if (/\.(?:db|sqlite|sqlite3)(?:[.-]|$)/u.test(fileName)) return true;
  if (/\.log(?:[.-]|$)/u.test(fileName)) return true;
  if (DENIED_CREDENTIAL_FILE_PATTERN.test(fileName)) return true;
  if (DENIED_TEST_FILE_PATTERN.test(fileName)) return true;
  if (
    new Set([".json", ".txt", ".yaml", ".yml"]).has(extension) &&
    DENIED_PRIVATE_DATA_FILE_PATTERN.test(fileName)
  ) {
    return true;
  }
  return false;
}

async function collectDirectoryFiles(input: {
  projectRoot: string;
  relativeDirectory: string;
  extensions: ReadonlySet<string>;
}): Promise<string[]> {
  const absoluteDirectory = path.resolve(input.projectRoot, input.relativeDirectory);
  const collected: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const absoluteEntry = path.join(directory, entry.name);
      const relativeEntry = toPortablePath(path.relative(input.projectRoot, absoluteEntry));
      if (isSensitivePath(relativeEntry)) continue;
      if (entry.isSymbolicLink()) {
        throw new AutonomyReleaseBuildError(
          "unsafe_source_entry",
          `Allowlisted source contains a symbolic link: ${relativeEntry}`
        );
      }
      if (entry.isDirectory()) {
        await visit(absoluteEntry);
        continue;
      }
      if (entry.isFile() && input.extensions.has(path.extname(entry.name).toLowerCase())) {
        collected.push(relativeEntry);
      }
    }
  }

  await visit(absoluteDirectory);
  return collected;
}

async function collectAllowlistedPaths(projectRoot: string): Promise<string[]> {
  const paths = new Set<string>();

  for (const relativePath of REQUIRED_FILES) {
    const absolutePath = path.resolve(projectRoot, relativePath);
    let stats;
    try {
      stats = await lstat(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AutonomyReleaseBuildError(
          "missing_required_source",
          `Required release source is missing: ${relativePath}`
        );
      }
      throw error;
    }
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      (isSensitivePath(relativePath) &&
        !REVIEWED_SENSITIVE_NAME_EXCEPTIONS.has(toPortablePath(relativePath)))
    ) {
      throw new AutonomyReleaseBuildError(
        "unsafe_source_entry",
        `Required release source is not a safe regular file: ${relativePath}`
      );
    }
    paths.add(toPortablePath(relativePath));
  }

  for (const spec of DIRECTORY_ALLOWLIST) {
    const absoluteDirectory = path.resolve(projectRoot, spec.directory);
    if (!(await pathExists(absoluteDirectory))) {
      if (spec.required) {
        throw new AutonomyReleaseBuildError(
          "missing_required_source",
          `Required release source directory is missing: ${spec.directory}`
        );
      }
      continue;
    }
    const stats = await lstat(absoluteDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new AutonomyReleaseBuildError(
        "unsafe_source_entry",
        `Allowlisted source is not a safe directory: ${spec.directory}`
      );
    }
    for (const relativePath of await collectDirectoryFiles({
      projectRoot,
      relativeDirectory: spec.directory,
      extensions: spec.extensions
    })) {
      paths.add(relativePath);
    }
  }

  return [...paths].sort(compareText);
}

async function buildManifest(
  projectRoot: string,
  runtimeVersion: string,
  relativePaths: readonly string[]
): Promise<AutonomyReleaseManifest> {
  const files: AutonomyReleaseFile[] = [];
  for (const relativePath of relativePaths) {
    const content = await readSafeSourceFile(projectRoot, relativePath);
    files.push({
      path: relativePath,
      sha256: sha256(content),
      sizeBytes: content.byteLength
    });
  }
  const aggregateSha256 = sha256(
    files.map((file) => `${file.path}\0${file.sizeBytes}\0${file.sha256}\n`).join("")
  );
  return {
    schemaVersion: AUTONOMY_RELEASE_MANIFEST_SCHEMA_VERSION,
    runtimeVersion,
    files,
    aggregateSha256
  };
}

function buildReceipt(input: {
  apply: boolean;
  manifest: AutonomyReleaseManifest;
}): AutonomyReleaseReceipt {
  const targetDirectoryName = `${input.manifest.runtimeVersion}-release`;
  const payload = {
    schemaVersion: AUTONOMY_RELEASE_RECEIPT_SCHEMA_VERSION as typeof AUTONOMY_RELEASE_RECEIPT_SCHEMA_VERSION,
    runtimeVersion: input.manifest.runtimeVersion,
    mode: input.apply ? ("apply" as const) : ("dry_run" as const),
    status: input.apply ? ("created" as const) : ("planned" as const),
    targetDirectoryName,
    fileCount: input.manifest.files.length,
    contentBytes: input.manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    manifestSha256: sha256(stableJson(input.manifest)),
    dependencies: {
      included: false as const,
      installed: false as const,
      lockfileIncluded: true as const
    },
    environment: {
      included: false as const,
      injected: false as const
    },
    runtimeReady: false as const,
    blockers: [
      "dependencies_not_installed",
      "runtime_environment_not_injected",
      "production_build_not_created",
      "package_script_surface_not_projected",
      "filesystem_no_replace_not_guaranteed"
    ] as const,
    packageScripts: {
      projected: false as const,
      guaranteedCommands: [
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
      ]
    },
    promotion: {
      strategy: "atomic_directory_rename" as const,
      builderConcurrencyLock: true as const,
      filesystemNoReplaceGuaranteed: false as const
    },
    safety: {
      allowlistOnly: true as const,
      hardExclusions: [...AUTONOMY_RELEASE_HARD_EXCLUSIONS],
      nodeModulesCopied: false as const,
      testsCopied: false as const,
      targetOverwriteAttempted: false as const,
      automationModified: false as const,
      externalMutationAttempted: false as const
    }
  };
  return {
    ...payload,
    receiptSha256: sha256(stableJson(payload))
  };
}

async function copyVerifiedFiles(input: {
  projectRoot: string;
  stagingDirectory: string;
  manifest: AutonomyReleaseManifest;
}): Promise<void> {
  for (const file of input.manifest.files) {
    const destination = path.resolve(input.stagingDirectory, file.path);
    if (!isInside(input.stagingDirectory, destination)) {
      throw new AutonomyReleaseBuildError(
        "unsafe_source_entry",
        `Release path escaped its staging directory: ${file.path}`
      );
    }
    const content = await readSafeSourceFile(input.projectRoot, file.path);
    if (content.byteLength !== file.sizeBytes || sha256(content) !== file.sha256) {
      throw new AutonomyReleaseBuildError(
        "source_changed",
        `Release source changed while staging: ${file.path}`
      );
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: "wx" });
  }
}

async function verifyStagedRelease(input: {
  stagingDirectory: string;
  manifest: AutonomyReleaseManifest;
  receipt: AutonomyReleaseReceipt;
}): Promise<void> {
  const expectedFiles = new Set([
    ...input.manifest.files.map((file) => file.path),
    "manifest.json",
    "receipt.json"
  ]);
  const actualFiles: string[] = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      const absoluteEntry = path.join(directory, entry.name);
      const relativeEntry = toPortablePath(
        path.relative(input.stagingDirectory, absoluteEntry)
      );
      if (entry.isSymbolicLink()) {
        throw new AutonomyReleaseBuildError(
          "unsafe_source_entry",
          `Staged release contains a symbolic link: ${relativeEntry}`
        );
      }
      if (entry.isDirectory()) {
        await visit(absoluteEntry);
      } else if (entry.isFile()) {
        actualFiles.push(relativeEntry);
      } else {
        throw new AutonomyReleaseBuildError(
          "unsafe_source_entry",
          `Staged release contains a non-regular entry: ${relativeEntry}`
        );
      }
    }
  }

  await visit(input.stagingDirectory);
  actualFiles.sort(compareText);
  const expectedPaths = [...expectedFiles].sort(compareText);
  if (
    actualFiles.length !== expectedPaths.length ||
    actualFiles.some((value, index) => value !== expectedPaths[index])
  ) {
    throw new AutonomyReleaseBuildError(
      "source_changed",
      "Staged release contents do not match the signed manifest."
    );
  }

  for (const file of input.manifest.files) {
    const content = await readFile(path.resolve(input.stagingDirectory, file.path));
    if (content.byteLength !== file.sizeBytes || sha256(content) !== file.sha256) {
      throw new AutonomyReleaseBuildError(
        "source_changed",
        `Staged release content does not match the manifest: ${file.path}`
      );
    }
  }
  const manifestContent = await readFile(
    path.join(input.stagingDirectory, "manifest.json"),
    "utf8"
  );
  const receiptContent = await readFile(
    path.join(input.stagingDirectory, "receipt.json"),
    "utf8"
  );
  if (
    manifestContent !== `${stableJson(input.manifest)}\n` ||
    receiptContent !== `${stableJson(input.receipt)}\n`
  ) {
    throw new AutonomyReleaseBuildError(
      "source_changed",
      "Staged release metadata failed its final integrity check."
    );
  }
}

export async function buildAutonomyRelease(
  options: BuildAutonomyReleaseOptions = {}
): Promise<BuildAutonomyReleaseResult> {
  const requestedProjectRoot = path.resolve(
    options.projectRoot ?? path.resolve(moduleDirectory, "..")
  );
  const projectRoot = path.resolve(await realpath(requestedProjectRoot));
  const requestedReleaseRoot = path.resolve(
    options.releaseRoot ?? path.join(projectRoot, ".tmp", "autonomy-releases")
  );
  const releaseRoot = await canonicalizeFuturePath(requestedReleaseRoot);
  const runtimeVersion = options.runtimeVersion ?? DEFAULT_AUTONOMY_RELEASE_VERSION;
  const apply = options.apply === true;

  assertSafeRuntimeVersion(runtimeVersion);
  if (!sameResolvedPath(requestedReleaseRoot, releaseRoot)) {
    throw new AutonomyReleaseBuildError(
      "unsafe_output_root",
      "Release output must not traverse a symbolic link or junction."
    );
  }
  if (releaseRoot === projectRoot) {
    throw new AutonomyReleaseBuildError(
      "output_overlaps_source",
      "Release output must not be the project root."
    );
  }
  for (const relativeDirectory of SOURCE_CONTAINER_DIRECTORIES) {
    const sourceDirectory = path.resolve(projectRoot, relativeDirectory);
    if (releaseRoot === sourceDirectory || isInside(sourceDirectory, releaseRoot)) {
      throw new AutonomyReleaseBuildError(
        "output_overlaps_source",
        "Release output must not overlap an allowlisted source directory."
      );
    }
  }

  const targetDirectoryName = `${runtimeVersion}-release`;
  const targetDirectory = path.resolve(releaseRoot, targetDirectoryName);
  if (!isInside(releaseRoot, targetDirectory)) {
    throw new AutonomyReleaseBuildError(
      "invalid_runtime_version",
      "Runtime version produced an unsafe target path."
    );
  }
  if (await pathExists(targetDirectory)) {
    throw new AutonomyReleaseBuildError(
      "target_exists",
      "The requested release target already exists and will not be overwritten."
    );
  }

  const relativePaths = await collectAllowlistedPaths(projectRoot);
  const manifest = await buildManifest(projectRoot, runtimeVersion, relativePaths);
  const receipt = buildReceipt({ apply, manifest });
  if (!apply) return { manifest, receipt, targetDirectory };

  await mkdir(releaseRoot, { recursive: true });
  const canonicalReleaseRoot = path.resolve(await realpath(releaseRoot));
  if (!sameResolvedPath(releaseRoot, canonicalReleaseRoot)) {
    throw new AutonomyReleaseBuildError(
      "unsafe_output_root",
      "Release output changed to a symbolic link or junction before staging."
    );
  }
  const lockPath = path.resolve(
    releaseRoot,
    `.${targetDirectoryName}.build.lock`
  );
  const lockToken = `${randomUUID()}\n`;
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  let lockCreated = false;
  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
      lockCreated = true;
      await lockHandle.writeFile(lockToken, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AutonomyReleaseBuildError(
          "target_exists",
          "The requested release target is already being built."
        );
      }
      throw error;
    }
    if (await pathExists(targetDirectory)) {
      throw new AutonomyReleaseBuildError(
        "target_exists",
        "The requested release target appeared before staging and will not be overwritten."
      );
    }

  const stagingDirectory = path.resolve(
    releaseRoot,
    `.${targetDirectoryName}.staging-${process.pid}-${randomUUID()}`
  );
  if (!isInside(releaseRoot, stagingDirectory)) {
    throw new AutonomyReleaseBuildError(
      "invalid_runtime_version",
      "Staging directory escaped the release root."
    );
  }

  let promoted = false;
  let stagingCreated = false;
  try {
    await mkdir(stagingDirectory, { recursive: false });
    stagingCreated = true;
    const canonicalStagingDirectory = path.resolve(
      await realpath(stagingDirectory)
    );
    if (
      !sameResolvedPath(stagingDirectory, canonicalStagingDirectory) ||
      !isInside(releaseRoot, canonicalStagingDirectory)
    ) {
      throw new AutonomyReleaseBuildError(
        "unsafe_output_root",
        "Staging directory resolved outside the verified release root."
      );
    }
    await copyVerifiedFiles({ projectRoot, stagingDirectory, manifest });
    await writeFile(
      path.join(stagingDirectory, "manifest.json"),
      `${stableJson(manifest)}\n`,
      { flag: "wx" }
    );
    await writeFile(
      path.join(stagingDirectory, "receipt.json"),
      `${stableJson(receipt)}\n`,
      { flag: "wx" }
    );
    if (options.testFault === "before_promote") {
      throw new Error("injected promotion failure");
    }
    await verifyStagedRelease({ stagingDirectory, manifest, receipt });
    if (!sameResolvedPath(releaseRoot, await realpath(releaseRoot))) {
      throw new AutonomyReleaseBuildError(
        "unsafe_output_root",
        "Release output changed before promotion."
      );
    }
    if (await pathExists(targetDirectory)) {
      throw new AutonomyReleaseBuildError(
        "target_exists",
        "The requested release target appeared during staging and will not be overwritten."
      );
    }
    await rename(stagingDirectory, targetDirectory);
    promoted = true;
  } finally {
    if (stagingCreated && !promoted && (await pathExists(stagingDirectory))) {
      await rm(stagingDirectory, { force: true, recursive: true });
    }
  }

    return { manifest, receipt, targetDirectory };
  } finally {
    await lockHandle?.close();
    if (lockCreated) {
      try {
        const currentToken = await readFile(lockPath, "utf8");
        if (currentToken === lockToken) await unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

type CliArguments = {
  apply: boolean;
  help: boolean;
  releaseRoot?: string;
  runtimeVersion: string;
};

export function parseAutonomyReleaseArguments(args: readonly string[]): CliArguments {
  const parsed: CliArguments = {
    apply: false,
    help: false,
    runtimeVersion: DEFAULT_AUTONOMY_RELEASE_VERSION
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply") {
      parsed.apply = true;
    } else if (argument === "--dry-run") {
      parsed.apply = false;
    } else if (argument === "--help" || argument === "-h") {
      parsed.help = true;
    } else if (argument === "--version" && args[index + 1]) {
      parsed.runtimeVersion = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--version=")) {
      parsed.runtimeVersion = argument.slice("--version=".length);
    } else if (argument === "--output-root" && args[index + 1]) {
      parsed.releaseRoot = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--output-root=")) {
      parsed.releaseRoot = argument.slice("--output-root=".length);
    } else {
      throw new AutonomyReleaseBuildError(
        "invalid_runtime_version",
        "Unknown or incomplete release builder argument."
      );
    }
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: npm run autonomy:release -- [--version v1-rc13] [--apply]",
      "",
      "Default mode is a read-only dry run. --apply creates a new immutable release directory.",
      "Dependencies, environment files, production build output, and automation activation are never included."
    ].join("\n") + "\n"
  );
}

async function main(): Promise<void> {
  try {
    const parsed = parseAutonomyReleaseArguments(process.argv.slice(2));
    if (parsed.help) {
      printHelp();
      return;
    }
    const result = await buildAutonomyRelease({
      apply: parsed.apply,
      releaseRoot: parsed.releaseRoot,
      runtimeVersion: parsed.runtimeVersion
    });
    process.stdout.write(`${stableJson(result.receipt)}\n`);
  } catch (error) {
    const code =
      error instanceof AutonomyReleaseBuildError
        ? error.code
        : "autonomy_release_build_failed";
    process.exitCode = 1;
    process.stdout.write(
      `${stableJson({
        schemaVersion: "cmooc.autonomy-release-cli-error.v1",
        status: "error",
        code,
        automationModified: false,
        externalMutationAttempted: false
      })}\n`
    );
  }
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (entryPath === modulePath) {
  void main();
}
