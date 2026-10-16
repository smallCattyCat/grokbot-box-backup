import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  OASIS_SIDECAR_SCHEMA_VERSIONS,
  type OasisCapabilitiesRequestV1,
  type OasisRunRequestV1,
  type OasisSidecarCapabilitiesV1,
  type OasisSidecarRequestV1,
  type OasisSidecarRunOutputV1,
  assertOasisCapabilities,
  assertOasisRunOutput
} from "./oasis-sidecar-contracts";
import { assertOasisScenePack, type OasisScenePackV1 } from "./oasis-scene-pack";
import { protocolHash } from "./contracts";

export const OASIS_SIDECAR_TRANSPORT_VERSION =
  "cmooc.oasis-sidecar-transport.v1" as const;
export const OASIS_SIDECAR_WALL_CLOCK_LIMIT_MS = 10_000 as const;
export const OASIS_SIDECAR_MAX_INPUT_BYTES = 256 * 1024;
export const OASIS_SIDECAR_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const CLOSE_CONFIRM_LIMIT_MS = 2_500;
const REQUEST_ID_PATTERN = /^[a-f0-9]{32}$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const REMOTE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,95}$/u;
const SAFE_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP"
] as const;

export type OasisSidecarTransportErrorCode =
  | "OASIS_SIDECAR_REQUEST_INVALID"
  | "OASIS_SIDECAR_REQUEST_TOO_LARGE"
  | "OASIS_SIDECAR_SPAWN_FAILED"
  | "OASIS_SIDECAR_TIMEOUT"
  | "OASIS_SIDECAR_ABORTED"
  | "OASIS_SIDECAR_OUTPUT_TOO_LARGE"
  | "OASIS_SIDECAR_OUTPUT_FRAME_INVALID"
  | "OASIS_SIDECAR_OUTPUT_JSON_INVALID"
  | "OASIS_SIDECAR_RESPONSE_INVALID"
  | "OASIS_SIDECAR_ECHO_MISMATCH"
  | "OASIS_SIDECAR_REMOTE_ERROR"
  | "OASIS_SIDECAR_EXIT_NONZERO"
  | "OASIS_SIDECAR_PAYLOAD_INVALID"
  | "OASIS_SIDECAR_CLOSE_TIMEOUT";

export class OasisSidecarTransportError extends Error {
  readonly code: OasisSidecarTransportErrorCode;
  readonly remoteCode?: string;

  constructor(code: OasisSidecarTransportErrorCode, remoteCode?: string) {
    super(code);
    this.name = "OasisSidecarTransportError";
    this.code = code;
    this.remoteCode = remoteCode;
  }
}

export interface OasisSidecarTransportOptions {
  /** Defaults to CMOOC_SCENARIO_PYTHON, then python/python3. */
  executable?: string;
  /** Defaults to this repository's scripts/scenario_lab_oasis_sidecar.py. */
  scriptPath?: string;
  cwd?: string;
  signal?: AbortSignal;
  /** Production default is the v1 protocol limit. Smaller values are useful in tests. */
  wallClockLimitMs?: number;
  /** Production default is the v1 protocol limit. Smaller values are useful in tests. */
  maxOutputBytes?: number;
  maxInputBytes?: number;
  requestId?: string;
  /** Only controls how long Node waits to confirm process closure. */
  closeConfirmLimitMs?: number;
}

interface TransportRequestEnvelopeV1 {
  transportVersion: typeof OASIS_SIDECAR_TRANSPORT_VERSION;
  requestId: string;
  requestHash: string;
  wallClockLimitMs: number;
  maxOutputBytes: number;
  payload: OasisSidecarRequestV1;
}

interface TransportSuccessEnvelopeV1 {
  transportVersion: typeof OASIS_SIDECAR_TRANSPORT_VERSION;
  requestId: string;
  requestHash: string;
  ok: true;
  payload: unknown;
}

interface TransportFailureEnvelopeV1 {
  transportVersion: typeof OASIS_SIDECAR_TRANSPORT_VERSION;
  requestId: string;
  requestHash: string;
  ok: false;
  error: { code: string };
}

type TransportResponseEnvelopeV1 =
  | TransportSuccessEnvelopeV1
  | TransportFailureEnvelopeV1;

type CloseObservation = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

function transportError(
  code: OasisSidecarTransportErrorCode,
  remoteCode?: string
): OasisSidecarTransportError {
  return new OasisSidecarTransportError(code, remoteCode);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertPlainJson(value: unknown): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw transportError("OASIS_SIDECAR_REQUEST_INVALID");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(assertPlainJson);
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach(assertPlainJson);
    return;
  }
  throw transportError("OASIS_SIDECAR_REQUEST_INVALID");
}

function assertRequest(value: unknown): asserts value is OasisSidecarRequestV1 {
  try {
    assertPlainJson(value);
    if (!isRecord(value)) throw new Error("invalid");
    if (value.operation === "capabilities") {
      if (
        !hasExactKeys(value, ["schemaVersion", "operation", "protocolVersion"]) ||
        value.schemaVersion !== OASIS_SIDECAR_SCHEMA_VERSIONS.request ||
        value.protocolVersion !== "v1"
      ) {
        throw new Error("invalid");
      }
      return;
    }
    if (value.operation === "run_conformance") {
      if (
        !hasExactKeys(value, [
          "schemaVersion",
          "operation",
          "protocolVersion",
          "engineMode",
          "scenePack"
        ]) ||
        value.schemaVersion !== OASIS_SIDECAR_SCHEMA_VERSIONS.request ||
        value.protocolVersion !== "v1" ||
        value.engineMode !== "conformance_reference" ||
        !isRecord(value.scenePack)
      ) {
        throw new Error("invalid");
      }
      assertOasisScenePack(value.scenePack as unknown as OasisScenePackV1);
      return;
    }
    throw new Error("invalid");
  } catch (error) {
    if (error instanceof OasisSidecarTransportError) throw error;
    throw transportError("OASIS_SIDECAR_REQUEST_INVALID");
  }
}

function assertHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

function assertCapabilitiesUnknown(
  value: unknown
): asserts value is OasisSidecarCapabilitiesV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "runtimeId",
      "protocolVersion",
      "conformanceReferenceAvailable",
      "nativeOasisAvailable",
      "supportedScenePackSchemaVersions",
      "supportedOperations",
      "executionBoundary",
      "capabilityHash"
    ]) ||
    value.schemaVersion !== OASIS_SIDECAR_SCHEMA_VERSIONS.capabilities ||
    value.runtimeId !== "oasis_sidecar_v1" ||
    value.protocolVersion !== "v1" ||
    value.conformanceReferenceAvailable !== true ||
    typeof value.nativeOasisAvailable !== "boolean" ||
    !Array.isArray(value.supportedScenePackSchemaVersions) ||
    value.supportedScenePackSchemaVersions.length !== 1 ||
    value.supportedScenePackSchemaVersions[0] !== "cmooc.oasis-scene-pack.v1" ||
    !Array.isArray(value.supportedOperations) ||
    value.supportedOperations.length !== 2 ||
    value.supportedOperations[0] !== "capabilities" ||
    value.supportedOperations[1] !== "run_conformance" ||
    !assertHash(value.capabilityHash)
  ) {
    throw transportError("OASIS_SIDECAR_PAYLOAD_INVALID");
  }
  assertExecutionBoundaryUnknown(value.executionBoundary);
}

function assertExecutionBoundaryUnknown(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "externalNetworkUsed",
      "workspaceWriteCount",
      "scratchWriteCount",
      "evidenceMode",
      "enforcementMode"
    ]) ||
    value.externalNetworkUsed !== false ||
    value.workspaceWriteCount !== 0 ||
    value.scratchWriteCount !== 0 ||
    value.evidenceMode !== "sidecar_self_report" ||
    value.enforcementMode !== "process_contract_only"
  ) {
    throw transportError("OASIS_SIDECAR_PAYLOAD_INVALID");
  }
}

function assertDistributionUnknown(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["p10", "p50", "p90"]) ||
    !isSafeNonNegativeInteger(value.p10) ||
    !isSafeNonNegativeInteger(value.p50) ||
    !isSafeNonNegativeInteger(value.p90)
  ) {
    throw transportError("OASIS_SIDECAR_PAYLOAD_INVALID");
  }
}

function assertArmSummaryUnknown(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "armId",
      "dailyFacilitationBudget",
      "seedCount",
      "facilitatorActionCount",
      "responseCoverageBps",
      "supportGapBps",
      "peerReplyEdgeCount"
    ]) ||
    typeof value.armId !== "string" ||
    !isSafeNonNegativeInteger(value.dailyFacilitationBudget) ||
    !isSafeNonNegativeInteger(value.seedCount)
  ) {
    throw transportError("OASIS_SIDECAR_PAYLOAD_INVALID");
  }
  assertDistributionUnknown(value.facilitatorActionCount);
  assertDistributionUnknown(value.responseCoverageBps);
  assertDistributionUnknown(value.supportGapBps);
  assertDistributionUnknown(value.peerReplyEdgeCount);
}

function assertRunOutputUnknown(
  value: unknown
): asserts value is OasisSidecarRunOutputV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "runtimeId",
      "engineMode",
      "validityClass",
      "scenePackHash",
      "sourceEvidenceHash",
      "seedRunCount",
      "armSummaries",
      "traceSetHash",
      "executionBoundary",
      "containsForumText",
      "containsIdentity",
      "containsRowLevelKeys",
      "interventionEligible",
      "outputHash"
    ]) ||
    value.schemaVersion !== OASIS_SIDECAR_SCHEMA_VERSIONS.runOutput ||
    value.runtimeId !== "oasis_contract_reference_v1" ||
    value.engineMode !== "conformance_reference" ||
    value.validityClass !== "synthetic_protocol_conformance" ||
    !assertHash(value.scenePackHash) ||
    !assertHash(value.sourceEvidenceHash) ||
    !isSafeNonNegativeInteger(value.seedRunCount) ||
    !Array.isArray(value.armSummaries) ||
    !assertHash(value.traceSetHash) ||
    value.containsForumText !== false ||
    value.containsIdentity !== false ||
    value.containsRowLevelKeys !== false ||
    value.interventionEligible !== false ||
    !assertHash(value.outputHash)
  ) {
    throw transportError("OASIS_SIDECAR_PAYLOAD_INVALID");
  }
  assertExecutionBoundaryUnknown(value.executionBoundary);
  value.armSummaries.forEach(assertArmSummaryUnknown);
}

function parseResponseEnvelope(
  value: unknown,
  request: TransportRequestEnvelopeV1
): TransportResponseEnvelopeV1 {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    throw transportError("OASIS_SIDECAR_RESPONSE_INVALID");
  }
  if (value.ok) {
    if (
      !hasExactKeys(value, [
        "transportVersion",
        "requestId",
        "requestHash",
        "ok",
        "payload"
      ])
    ) {
      throw transportError("OASIS_SIDECAR_RESPONSE_INVALID");
    }
  } else if (
    !hasExactKeys(value, [
      "transportVersion",
      "requestId",
      "requestHash",
      "ok",
      "error"
    ]) ||
    !isRecord(value.error) ||
    !hasExactKeys(value.error, ["code"]) ||
    typeof value.error.code !== "string" ||
    !REMOTE_ERROR_CODE_PATTERN.test(value.error.code)
  ) {
    throw transportError("OASIS_SIDECAR_RESPONSE_INVALID");
  }
  if (
    value.transportVersion !== request.transportVersion ||
    value.requestId !== request.requestId ||
    value.requestHash !== request.requestHash
  ) {
    throw transportError("OASIS_SIDECAR_ECHO_MISMATCH");
  }
  return value as unknown as TransportResponseEnvelopeV1;
}

function parseSingleJsonlFrame(buffer: Buffer): unknown {
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    throw transportError("OASIS_SIDECAR_OUTPUT_FRAME_INVALID");
  }
  let end = buffer.length - 1;
  if (end > 0 && buffer[end - 1] === 0x0d) end -= 1;
  const body = buffer.subarray(0, end);
  if (
    body.length === 0 ||
    body.includes(0x0a) ||
    body.includes(0x0d)
  ) {
    throw transportError("OASIS_SIDECAR_OUTPUT_FRAME_INVALID");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw transportError("OASIS_SIDECAR_OUTPUT_JSON_INVALID");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw transportError("OASIS_SIDECAR_OUTPUT_JSON_INVALID");
  }
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  env.PYTHONUTF8 = "1";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONDONTWRITEBYTECODE = "1";
  return env;
}

function isPositiveBoundedInteger(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function resolveLaunchOptions(options: OasisSidecarTransportOptions): {
  executable: string;
  scriptPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  wallClockLimitMs: number;
  maxOutputBytes: number;
  maxInputBytes: number;
  closeConfirmLimitMs: number;
  requestId: string;
} {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaultScript = options.scriptPath === undefined;
  const scriptPath = resolve(
    options.scriptPath ?? resolve(cwd, "scripts", "scenario_lab_oasis_sidecar.py")
  );
  if (defaultScript) {
    const relativePath = relative(cwd, scriptPath);
    if (
      relativePath.startsWith("..") ||
      isAbsolute(relativePath) ||
      !existsSync(scriptPath)
    ) {
      throw transportError("OASIS_SIDECAR_REQUEST_INVALID");
    }
  }
  const executable =
    options.executable?.trim() ||
    process.env.CMOOC_SCENARIO_PYTHON?.trim() ||
    (process.platform === "win32" ? "python" : "python3");
  const wallClockLimitMs =
    options.wallClockLimitMs ?? OASIS_SIDECAR_WALL_CLOCK_LIMIT_MS;
  const maxOutputBytes =
    options.maxOutputBytes ?? OASIS_SIDECAR_MAX_OUTPUT_BYTES;
  const maxInputBytes = options.maxInputBytes ?? OASIS_SIDECAR_MAX_INPUT_BYTES;
  const closeConfirmLimitMs =
    options.closeConfirmLimitMs ?? CLOSE_CONFIRM_LIMIT_MS;
  const requestId = options.requestId ?? randomBytes(16).toString("hex");
  if (
    executable.length === 0 ||
    !REQUEST_ID_PATTERN.test(requestId) ||
    !isPositiveBoundedInteger(
      wallClockLimitMs,
      OASIS_SIDECAR_WALL_CLOCK_LIMIT_MS
    ) ||
    !isPositiveBoundedInteger(maxOutputBytes, OASIS_SIDECAR_MAX_OUTPUT_BYTES) ||
    !isPositiveBoundedInteger(maxInputBytes, OASIS_SIDECAR_MAX_INPUT_BYTES) ||
    !isPositiveBoundedInteger(closeConfirmLimitMs, 10_000)
  ) {
    throw transportError("OASIS_SIDECAR_REQUEST_INVALID");
  }
  return {
    executable,
    scriptPath,
    cwd,
    env: safeEnvironment(process.env),
    wallClockLimitMs,
    maxOutputBytes,
    maxInputBytes,
    closeConfirmLimitMs,
    requestId
  };
}

function makeEnvelope(
  payload: OasisSidecarRequestV1,
  launch: ReturnType<typeof resolveLaunchOptions>
): TransportRequestEnvelopeV1 {
  const hashBody = {
    requestId: launch.requestId,
    wallClockLimitMs: launch.wallClockLimitMs,
    maxOutputBytes: launch.maxOutputBytes,
    payload
  };
  return {
    transportVersion: OASIS_SIDECAR_TRANSPORT_VERSION,
    ...hashBody,
    requestHash: protocolHash(OASIS_SIDECAR_TRANSPORT_VERSION, hashBody)
  };
}

function waitForClose(
  close: Promise<CloseObservation>,
  limitMs: number
): Promise<CloseObservation> {
  return new Promise<CloseObservation>((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      rejectClose(transportError("OASIS_SIDECAR_CLOSE_TIMEOUT"));
    }, limitMs);
    void close.then((observation) => {
      clearTimeout(timer);
      resolveClose(observation);
    });
  });
}

function requestProcessTreeTermination(
  child: ChildProcessWithoutNullStreams,
  cwd: string,
  env: NodeJS.ProcessEnv
): void {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
  const fallbackKill = () => {
    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Closure confirmation below determines whether termination succeeded.
      }
    }
  };
  if (process.platform !== "win32" || !child.pid) {
    fallbackKill();
    return;
  }
  try {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      {
        cwd,
        env,
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: "ignore"
      }
    );
    const fallbackTimer = setTimeout(fallbackKill, 500);
    killer.once("error", () => {
      clearTimeout(fallbackTimer);
      fallbackKill();
    });
    killer.once("close", (code) => {
      clearTimeout(fallbackTimer);
      if (code !== 0) fallbackKill();
    });
  } catch {
    fallbackKill();
  }
}

async function executeEnvelope(
  envelope: TransportRequestEnvelopeV1,
  launch: ReturnType<typeof resolveLaunchOptions>,
  signal: AbortSignal | undefined
): Promise<{ response: TransportSuccessEnvelopeV1; exit: CloseObservation }> {
  const serialized = `${JSON.stringify(envelope)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > launch.maxInputBytes) {
    throw transportError("OASIS_SIDECAR_REQUEST_TOO_LARGE");
  }
  if (signal?.aborted) throw transportError("OASIS_SIDECAR_ABORTED");

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(launch.executable, [launch.scriptPath], {
      cwd: launch.cwd,
      env: launch.env,
      shell: false,
      detached: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch {
    throw transportError("OASIS_SIDECAR_SPAWN_FAILED");
  }

  let closeResolver!: (observation: CloseObservation) => void;
  const close = new Promise<CloseObservation>((resolveClose) => {
    closeResolver = resolveClose;
  });
  let closeObserved = false;
  let spawnFailed = false;
  let terminalError: OasisSidecarTransportError | undefined;
  let terminationStarted = false;
  let terminationResolver!: (error: OasisSidecarTransportError) => void;
  const termination = new Promise<OasisSidecarTransportError>((resolveError) => {
    terminationResolver = resolveError;
  });
  const output: Buffer[] = [];
  let outputBytes = 0;

  const observeClose = (code: number | null, closeSignal: NodeJS.Signals | null) => {
    if (closeObserved) return;
    closeObserved = true;
    closeResolver({ code, signal: closeSignal });
  };
  const terminate = (error: OasisSidecarTransportError) => {
    if (terminalError) return;
    terminalError = error;
    if (!terminationStarted) {
      terminationStarted = true;
      requestProcessTreeTermination(child, launch.cwd, launch.env);
      terminationResolver(error);
    }
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytes += bytes.length;
    if (outputBytes > launch.maxOutputBytes) {
      terminate(transportError("OASIS_SIDECAR_OUTPUT_TOO_LARGE"));
      return;
    }
    if (!terminalError) output.push(bytes);
  });
  child.stderr.on("data", () => {
    // Intentionally drain and discard: stderr can contain local paths or secrets.
  });
  child.once("error", () => {
    spawnFailed = true;
    observeClose(null, null);
  });
  child.once("close", observeClose);

  const timeout = setTimeout(() => {
    terminate(transportError("OASIS_SIDECAR_TIMEOUT"));
  }, launch.wallClockLimitMs);
  const onAbort = () => terminate(transportError("OASIS_SIDECAR_ABORTED"));
  signal?.addEventListener("abort", onAbort, { once: true });

  child.once("spawn", () => {
    if (terminalError) {
      child.stdin.destroy();
      return;
    }
    try {
      child.stdin.end(serialized, "utf8");
    } catch {
      terminate(transportError("OASIS_SIDECAR_SPAWN_FAILED"));
    }
  });
  child.stdin.once("error", () => {
    if (!closeObserved && !terminalError) {
      terminate(transportError("OASIS_SIDECAR_SPAWN_FAILED"));
    }
  });

  let exit: CloseObservation;
  try {
    const completion = await Promise.race([
      close.then((observation) => ({
        kind: "closed" as const,
        observation
      })),
      termination.then(async (error) => ({
        kind: "terminated" as const,
        error,
        observation: await waitForClose(close, launch.closeConfirmLimitMs)
      }))
    ]);
    exit = completion.observation;
    if (completion.kind === "terminated") {
      throw completion.error;
    }
    if (terminalError) throw terminalError;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
  if (spawnFailed) throw transportError("OASIS_SIDECAR_SPAWN_FAILED");

  const parsed = parseSingleJsonlFrame(Buffer.concat(output, outputBytes));
  const response = parseResponseEnvelope(parsed, envelope);
  if (!response.ok) {
    throw transportError("OASIS_SIDECAR_REMOTE_ERROR", response.error.code);
  }
  if (exit.code !== 0) throw transportError("OASIS_SIDECAR_EXIT_NONZERO");
  return { response, exit };
}

export async function runOasisSidecarRequest(
  request: OasisCapabilitiesRequestV1,
  options?: OasisSidecarTransportOptions
): Promise<OasisSidecarCapabilitiesV1>;
export async function runOasisSidecarRequest(
  request: OasisRunRequestV1,
  options?: OasisSidecarTransportOptions
): Promise<OasisSidecarRunOutputV1>;
export async function runOasisSidecarRequest(
  request: OasisSidecarRequestV1,
  options: OasisSidecarTransportOptions = {}
): Promise<OasisSidecarCapabilitiesV1 | OasisSidecarRunOutputV1> {
  assertRequest(request);
  const launch = resolveLaunchOptions(options);
  const envelope = makeEnvelope(request, launch);
  const { response } = await executeEnvelope(envelope, launch, options.signal);
  try {
    if (request.operation === "capabilities") {
      assertCapabilitiesUnknown(response.payload);
      assertOasisCapabilities(response.payload);
      return response.payload;
    }
    assertRunOutputUnknown(response.payload);
    assertOasisRunOutput(response.payload, request.scenePack);
    return response.payload;
  } catch (error) {
    if (error instanceof OasisSidecarTransportError) throw error;
    throw transportError("OASIS_SIDECAR_PAYLOAD_INVALID");
  }
}

export function readOasisSidecarCapabilities(
  options: OasisSidecarTransportOptions = {}
): Promise<OasisSidecarCapabilitiesV1> {
  return runOasisSidecarRequest(
    {
      schemaVersion: OASIS_SIDECAR_SCHEMA_VERSIONS.request,
      operation: "capabilities",
      protocolVersion: "v1"
    },
    options
  );
}

export function runOasisConformanceSidecar(
  scenePack: OasisScenePackV1,
  options: OasisSidecarTransportOptions = {}
): Promise<OasisSidecarRunOutputV1> {
  return runOasisSidecarRequest(
    {
      schemaVersion: OASIS_SIDECAR_SCHEMA_VERSIONS.request,
      operation: "run_conformance",
      protocolVersion: "v1",
      engineMode: "conformance_reference",
      scenePack
    },
    options
  );
}
