import type { ProtectedArtifactStore } from "@/lib/workbench/protected-artifact-store";

export const COURSE_AGENT_PROTECTED_MATERIAL_VAULT_SCHEMA_VERSION =
  "cmooc.course-agent-protected-material-vault.v1" as const;

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PROTECTED_REF = /^protected-draft:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type ProtectedDraftVersionBinding = Readonly<{
  taskId: string;
  runId: string;
  artifactVersionRef: string;
  protectedRef: string;
  draftBodyHash: string;
  expiresAt: string;
}>;

export type ResolvedProtectedDraftVersion = Readonly<{
  schemaVersion: typeof COURSE_AGENT_PROTECTED_MATERIAL_VAULT_SCHEMA_VERSION;
  taskId: string;
  runId: string;
  artifactVersionRef: string;
  draftBodyHash: string;
  expiresAt: string;
  body: string;
  bodyPersisted: false;
  recovery: "regenerate_and_reverify";
}>;

export class CourseAgentProtectedMaterialVaultError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CourseAgentProtectedMaterialVaultError";
  }
}

function fail(code: string, message: string): never {
  throw new CourseAgentProtectedMaterialVaultError(code, message);
}

function assertSafeRef(value: string, label: string): void {
  if (!SAFE_REF.test(value)) {
    fail("COURSE_AGENT_PROTECTED_BINDING_INVALID", `${label} is invalid.`);
  }
}

function parseInstant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    fail("COURSE_AGENT_PROTECTED_BINDING_INVALID", `${label} is invalid.`);
  }
  return parsed;
}

/**
 * Process-local, non-enumerable association between one immutable artifact
 * version and its protected-store handle.  Neither the handle nor the body is
 * serializable through this API.  A process loss deliberately turns lookup
 * into `null`, which means regenerate and reverify rather than pretend-resume.
 */
export class CourseAgentProtectedMaterialVault {
  readonly #scope: Readonly<{ taskId: string; runId: string }>;
  readonly #store: ProtectedArtifactStore;
  readonly #byVersionRef = new Map<string, ProtectedDraftVersionBinding>();

  constructor(input: {
    taskId: string;
    runId: string;
    protectedStore: ProtectedArtifactStore;
  }) {
    assertSafeRef(input.taskId, "taskId");
    assertSafeRef(input.runId, "runId");
    this.#scope = Object.freeze({ taskId: input.taskId, runId: input.runId });
    this.#store = input.protectedStore;
  }

  bind(input: ProtectedDraftVersionBinding): void {
    this.#assertScope(input.taskId, input.runId);
    assertSafeRef(input.artifactVersionRef, "artifactVersionRef");
    if (!PROTECTED_REF.test(input.protectedRef) || !SHA256.test(input.draftBodyHash)) {
      fail(
        "COURSE_AGENT_PROTECTED_BINDING_INVALID",
        "Protected draft reference or body hash is invalid."
      );
    }
    parseInstant(input.expiresAt, "expiresAt");
    const normalized = Object.freeze({ ...input });
    const existing = this.#byVersionRef.get(input.artifactVersionRef);
    if (existing) {
      if (
        existing.protectedRef !== normalized.protectedRef ||
        existing.draftBodyHash !== normalized.draftBodyHash ||
        existing.expiresAt !== normalized.expiresAt
      ) {
        fail(
          "COURSE_AGENT_PROTECTED_BINDING_CONFLICT",
          "Artifact version is already bound to different protected material."
        );
      }
      return;
    }
    this.#byVersionRef.set(input.artifactVersionRef, normalized);
  }

  async resolve(input: {
    taskId: string;
    runId: string;
    artifactVersionRef: string;
    expectedDraftBodyHash: string;
    now: string;
  }): Promise<ResolvedProtectedDraftVersion | null> {
    this.#assertScope(input.taskId, input.runId);
    assertSafeRef(input.artifactVersionRef, "artifactVersionRef");
    if (!SHA256.test(input.expectedDraftBodyHash)) {
      fail("COURSE_AGENT_PROTECTED_BINDING_INVALID", "Expected body hash is invalid.");
    }
    const now = parseInstant(input.now, "now");
    const binding = this.#byVersionRef.get(input.artifactVersionRef);
    if (!binding) return null;
    if (binding.draftBodyHash !== input.expectedDraftBodyHash) {
      fail(
        "COURSE_AGENT_PROTECTED_BINDING_SCOPE_MISMATCH",
        "Artifact version and expected body hash do not match."
      );
    }
    if (Date.parse(binding.expiresAt) <= now) {
      this.#byVersionRef.delete(input.artifactVersionRef);
      return null;
    }
    const body = await this.#store.getByRef({
      ref: binding.protectedRef,
      taskId: input.taskId,
      runId: input.runId,
      expectedDraftBodyHash: input.expectedDraftBodyHash,
      now: input.now
    });
    if (body === null) {
      this.#byVersionRef.delete(input.artifactVersionRef);
      return null;
    }
    return Object.freeze({
      schemaVersion: COURSE_AGENT_PROTECTED_MATERIAL_VAULT_SCHEMA_VERSION,
      taskId: input.taskId,
      runId: input.runId,
      artifactVersionRef: input.artifactVersionRef,
      draftBodyHash: input.expectedDraftBodyHash,
      expiresAt: binding.expiresAt,
      body,
      bodyPersisted: false,
      recovery: "regenerate_and_reverify"
    });
  }

  forget(artifactVersionRef: string): void {
    assertSafeRef(artifactVersionRef, "artifactVersionRef");
    this.#byVersionRef.delete(artifactVersionRef);
  }

  #assertScope(taskId: string, runId: string): void {
    assertSafeRef(taskId, "taskId");
    assertSafeRef(runId, "runId");
    if (taskId !== this.#scope.taskId || runId !== this.#scope.runId) {
      fail(
        "COURSE_AGENT_PROTECTED_BINDING_SCOPE_MISMATCH",
        "Protected material belongs to a different task or run."
      );
    }
  }
}
