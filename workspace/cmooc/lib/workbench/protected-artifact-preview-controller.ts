import type { ProtectedArtifactStore } from "@/lib/workbench/protected-artifact-store";

export const PROTECTED_ARTIFACT_PREVIEW_SCHEMA_VERSION =
  "cmooc.workbench.protected-artifact-preview.v1" as const;
export const PROTECTED_ARTIFACT_DIFF_SCHEMA_VERSION =
  "cmooc.workbench.protected-artifact-diff.v1" as const;
export const PROTECTED_ARTIFACT_PREVIEW_TTL_MS = 60_000;

const STORE_KEY = "__cmooc_protected_artifact_preview_bindings__";
const BINDING_LIMIT = 128;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const VERSION_REF = /^artifact-version:[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const PROTECTED_REF = /^protected-draft:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

type Binding = {
  readonly taskId: string;
  readonly runId: string;
  readonly versionRef: string;
  readonly contentHash: string;
  readonly draftBodyHash: string;
  readonly protectedRef: string;
  readonly protectedStore: ProtectedArtifactStore;
  readonly boundAt: string;
  readonly expiresAt: string;
};

type BindingStore = Map<string, Binding>;

export type ProtectedArtifactVersionBinding = Readonly<{
  taskId: string;
  runId: string;
  versionRef: string;
  contentHash: string;
  draftBodyHash: string;
}>;

export type ProtectedArtifactPreviewAvailability = Readonly<{
  status: "available" | "regenerate_or_reenter";
  oneShot: true;
  bodyPersisted: false;
  expiresAt: string | null;
  reason:
    | "bound_in_current_process"
    | "binding_expired"
    | "binding_missing_or_process_restarted"
    | "binding_scope_changed";
}>;

export type ProtectedArtifactPreviewResult = Readonly<{
  schemaVersion: typeof PROTECTED_ARTIFACT_PREVIEW_SCHEMA_VERSION;
  versionRef: string;
  contentHash: string;
  draftBodyHash: string;
  body: string;
  consumedAt: string;
  oneShot: true;
  bodyPersisted: false;
}>;

export type ProtectedArtifactDiffOperation = Readonly<{
  kind: "equal" | "remove" | "add";
  text: string;
}>;

export type ProtectedArtifactDiffResult = Readonly<{
  schemaVersion: typeof PROTECTED_ARTIFACT_DIFF_SCHEMA_VERSION;
  format: "single_span_text_diff_v1";
  fromVersionRef: string;
  toVersionRef: string;
  operations: readonly ProtectedArtifactDiffOperation[];
  changed: boolean;
  consumedAt: string;
  oneShot: true;
  bodyPersisted: false;
}>;

export class ProtectedArtifactPreviewError extends Error {
  constructor(
    readonly code:
      | "PROTECTED_ARTIFACT_PREVIEW_INPUT_INVALID"
      | "PROTECTED_ARTIFACT_PREVIEW_BINDING_CONFLICT"
      | "PROTECTED_ARTIFACT_PREVIEW_SCOPE_MISMATCH"
      | "PROTECTED_ARTIFACT_PREVIEW_UNAVAILABLE",
    readonly reason:
      | "invalid_input"
      | "binding_conflict"
      | "binding_scope_changed"
      | "binding_expired"
      | "binding_missing_or_process_restarted"
      | "protected_body_unavailable",
    message: string
  ) {
    super(message);
    this.name = "ProtectedArtifactPreviewError";
  }
}

function bindings(): BindingStore {
  const root = globalThis as typeof globalThis & {
    [STORE_KEY]?: BindingStore;
  };
  root[STORE_KEY] ??= new Map<string, Binding>();
  return root[STORE_KEY];
}

function bindingKey(input: {
  taskId: string;
  runId: string;
  versionRef: string;
}): string {
  return `${input.taskId}\0${input.runId}\0${input.versionRef}`;
}

function invalid(message: string): never {
  throw new ProtectedArtifactPreviewError(
    "PROTECTED_ARTIFACT_PREVIEW_INPUT_INVALID",
    "invalid_input",
    message
  );
}

function assertBindingInput(input: ProtectedArtifactVersionBinding): void {
  if (!SAFE_ID.test(input.taskId)) invalid("taskId is invalid.");
  if (!SAFE_ID.test(input.runId)) invalid("runId is invalid.");
  if (!VERSION_REF.test(input.versionRef)) invalid("versionRef is invalid.");
  if (!SHA256.test(input.contentHash)) invalid("contentHash is invalid.");
  if (!SHA256.test(input.draftBodyHash)) invalid("draftBodyHash is invalid.");
}

function instant(value: Date | string, label: string): number {
  const milliseconds =
    value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid(`${label} is invalid.`);
  return milliseconds;
}

function prune(nowMs: number): void {
  const current = bindings();
  for (const [key, binding] of current) {
    if (Date.parse(binding.expiresAt) <= nowMs) current.delete(key);
  }
  while (current.size >= BINDING_LIMIT) {
    const oldest = current.keys().next().value as string | undefined;
    if (!oldest) break;
    current.delete(oldest);
  }
}

/**
 * Server-only trust hook. Callers retain the protectedRef inside this module;
 * the returned projection is safe to expose and deliberately omits it.
 */
export function bindProtectedArtifactPreview(input: {
  taskId: string;
  runId: string;
  versionRef: string;
  contentHash: string;
  draftBodyHash: string;
  protectedRef: string;
  protectedStore: ProtectedArtifactStore;
  protectedExpiresAt: string;
  now?: Date;
}): Readonly<{
  schemaVersion: typeof PROTECTED_ARTIFACT_PREVIEW_SCHEMA_VERSION;
  versionRef: string;
  status: "available";
  expiresAt: string;
  oneShot: true;
  bodyPersisted: false;
}> {
  assertBindingInput(input);
  if (!PROTECTED_REF.test(input.protectedRef)) {
    invalid("protectedRef is invalid.");
  }
  const now = input.now ?? new Date();
  const nowMs = instant(now, "now");
  const protectedExpiresAtMs = instant(
    input.protectedExpiresAt,
    "protectedExpiresAt"
  );
  if (protectedExpiresAtMs <= nowMs) {
    throw new ProtectedArtifactPreviewError(
      "PROTECTED_ARTIFACT_PREVIEW_UNAVAILABLE",
      "protected_body_unavailable",
      "Protected body is already unavailable."
    );
  }
  prune(nowMs);
  const expiresAt = new Date(
    Math.min(nowMs + PROTECTED_ARTIFACT_PREVIEW_TTL_MS, protectedExpiresAtMs)
  ).toISOString();
  const key = bindingKey(input);
  const existing = bindings().get(key);
  if (existing) {
    if (
      existing.contentHash !== input.contentHash ||
      existing.draftBodyHash !== input.draftBodyHash ||
      existing.protectedRef !== input.protectedRef ||
      existing.protectedStore !== input.protectedStore
    ) {
      throw new ProtectedArtifactPreviewError(
        "PROTECTED_ARTIFACT_PREVIEW_BINDING_CONFLICT",
        "binding_conflict",
        "Artifact version is already bound to another protected body."
      );
    }
    return Object.freeze({
      schemaVersion: PROTECTED_ARTIFACT_PREVIEW_SCHEMA_VERSION,
      versionRef: existing.versionRef,
      status: "available" as const,
      expiresAt: existing.expiresAt,
      oneShot: true as const,
      bodyPersisted: false as const
    });
  }
  const binding: Binding = Object.freeze({
    taskId: input.taskId,
    runId: input.runId,
    versionRef: input.versionRef,
    contentHash: input.contentHash,
    draftBodyHash: input.draftBodyHash,
    protectedRef: input.protectedRef,
    protectedStore: input.protectedStore,
    boundAt: now.toISOString(),
    expiresAt
  });
  bindings().set(key, binding);
  return Object.freeze({
    schemaVersion: PROTECTED_ARTIFACT_PREVIEW_SCHEMA_VERSION,
    versionRef: binding.versionRef,
    status: "available" as const,
    expiresAt: binding.expiresAt,
    oneShot: true as const,
    bodyPersisted: false as const
  });
}

export function inspectProtectedArtifactPreview(
  input: ProtectedArtifactVersionBinding & { now?: Date }
): ProtectedArtifactPreviewAvailability {
  assertBindingInput(input);
  const nowMs = instant(input.now ?? new Date(), "now");
  const key = bindingKey(input);
  const binding = bindings().get(key);
  if (!binding) {
    return Object.freeze({
      status: "regenerate_or_reenter" as const,
      oneShot: true as const,
      bodyPersisted: false as const,
      expiresAt: null,
      reason: "binding_missing_or_process_restarted" as const
    });
  }
  if (Date.parse(binding.expiresAt) <= nowMs) {
    bindings().delete(key);
    return Object.freeze({
      status: "regenerate_or_reenter" as const,
      oneShot: true as const,
      bodyPersisted: false as const,
      expiresAt: binding.expiresAt,
      reason: "binding_expired" as const
    });
  }
  if (
    binding.contentHash !== input.contentHash ||
    binding.draftBodyHash !== input.draftBodyHash
  ) {
    return Object.freeze({
      status: "regenerate_or_reenter" as const,
      oneShot: true as const,
      bodyPersisted: false as const,
      expiresAt: null,
      reason: "binding_scope_changed" as const
    });
  }
  return Object.freeze({
    status: "available" as const,
    oneShot: true as const,
    bodyPersisted: false as const,
    expiresAt: binding.expiresAt,
    reason: "bound_in_current_process" as const
  });
}

function reserveBindings(
  requested: readonly (ProtectedArtifactVersionBinding & { now?: Date })[]
): readonly Binding[] {
  if (requested.length < 1 || requested.length > 2) {
    invalid("One or two artifact bindings are required.");
  }
  for (const item of requested) assertBindingInput(item);
  const nowMs = instant(requested[0]!.now ?? new Date(), "now");
  const keys = requested.map(bindingKey);
  if (new Set(keys).size !== keys.length) {
    invalid("Artifact version bindings must be distinct.");
  }
  const found: Binding[] = [];
  for (let index = 0; index < requested.length; index += 1) {
    const expected = requested[index]!;
    const key = keys[index]!;
    const binding = bindings().get(key);
    if (!binding) {
      throw new ProtectedArtifactPreviewError(
        "PROTECTED_ARTIFACT_PREVIEW_UNAVAILABLE",
        "binding_missing_or_process_restarted",
        "Protected preview binding is unavailable; regenerate or re-enter the task."
      );
    }
    if (Date.parse(binding.expiresAt) <= nowMs) {
      bindings().delete(key);
      throw new ProtectedArtifactPreviewError(
        "PROTECTED_ARTIFACT_PREVIEW_UNAVAILABLE",
        "binding_expired",
        "Protected preview binding expired; regenerate or re-enter the task."
      );
    }
    if (
      binding.contentHash !== expected.contentHash ||
      binding.draftBodyHash !== expected.draftBodyHash
    ) {
      throw new ProtectedArtifactPreviewError(
        "PROTECTED_ARTIFACT_PREVIEW_SCOPE_MISMATCH",
        "binding_scope_changed",
        "Protected preview binding no longer matches this artifact version."
      );
    }
    found.push(binding);
  }
  // Reserve atomically before awaiting protected-store reads. A concurrent
  // request can never observe or consume the same one-shot binding.
  for (const key of keys) bindings().delete(key);
  return Object.freeze(found);
}

async function readReservedBody(
  binding: Binding,
  now: Date
): Promise<string> {
  try {
    const body = await binding.protectedStore.getByRef({
      ref: binding.protectedRef,
      taskId: binding.taskId,
      runId: binding.runId,
      expectedDraftBodyHash: binding.draftBodyHash,
      now: now.toISOString()
    });
    if (body !== null) return body;
  } catch {
    // Deliberately collapse private-store detail to the public recovery state.
  }
  throw new ProtectedArtifactPreviewError(
    "PROTECTED_ARTIFACT_PREVIEW_UNAVAILABLE",
    "protected_body_unavailable",
    "Protected body is unavailable; regenerate and reverify the artifact."
  );
}

export async function consumeProtectedArtifactPreview(
  input: ProtectedArtifactVersionBinding & { now?: Date }
): Promise<ProtectedArtifactPreviewResult> {
  const now = input.now ?? new Date();
  const [binding] = reserveBindings([{ ...input, now }]);
  const body = await readReservedBody(binding!, now);
  return Object.freeze({
    schemaVersion: PROTECTED_ARTIFACT_PREVIEW_SCHEMA_VERSION,
    versionRef: binding!.versionRef,
    contentHash: binding!.contentHash,
    draftBodyHash: binding!.draftBodyHash,
    body,
    consumedAt: now.toISOString(),
    oneShot: true as const,
    bodyPersisted: false as const
  });
}

function singleSpanDiff(
  fromBody: string,
  toBody: string
): readonly ProtectedArtifactDiffOperation[] {
  const from = Array.from(fromBody);
  const to = Array.from(toBody);
  let prefix = 0;
  while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < from.length - prefix &&
    suffix < to.length - prefix &&
    from[from.length - 1 - suffix] === to[to.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const operations: ProtectedArtifactDiffOperation[] = [];
  const equalPrefix = from.slice(0, prefix).join("");
  const removed = from.slice(prefix, from.length - suffix).join("");
  const added = to.slice(prefix, to.length - suffix).join("");
  const equalSuffix = suffix > 0 ? from.slice(from.length - suffix).join("") : "";
  if (equalPrefix) operations.push(Object.freeze({ kind: "equal", text: equalPrefix }));
  if (removed) operations.push(Object.freeze({ kind: "remove", text: removed }));
  if (added) operations.push(Object.freeze({ kind: "add", text: added }));
  if (equalSuffix) operations.push(Object.freeze({ kind: "equal", text: equalSuffix }));
  if (operations.length === 0) {
    operations.push(Object.freeze({ kind: "equal", text: "" }));
  }
  return Object.freeze(operations);
}

export async function consumeProtectedArtifactDiff(input: {
  taskId: string;
  runId: string;
  from: Omit<ProtectedArtifactVersionBinding, "taskId" | "runId">;
  to: Omit<ProtectedArtifactVersionBinding, "taskId" | "runId">;
  now?: Date;
}): Promise<ProtectedArtifactDiffResult> {
  const now = input.now ?? new Date();
  const requested = [
    { taskId: input.taskId, runId: input.runId, ...input.from, now },
    { taskId: input.taskId, runId: input.runId, ...input.to, now }
  ] as const;
  const [fromBinding, toBinding] = reserveBindings(requested);
  const [fromBody, toBody] = await Promise.all([
    readReservedBody(fromBinding!, now),
    readReservedBody(toBinding!, now)
  ]);
  return Object.freeze({
    schemaVersion: PROTECTED_ARTIFACT_DIFF_SCHEMA_VERSION,
    format: "single_span_text_diff_v1" as const,
    fromVersionRef: fromBinding!.versionRef,
    toVersionRef: toBinding!.versionRef,
    operations: singleSpanDiff(fromBody, toBody),
    changed: fromBody !== toBody,
    consumedAt: now.toISOString(),
    oneShot: true as const,
    bodyPersisted: false as const
  });
}

export function resetProtectedArtifactPreviewControllerForTests(): void {
  bindings().clear();
}
