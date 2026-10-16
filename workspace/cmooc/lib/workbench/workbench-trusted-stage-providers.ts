import { PrismaStageRunNonceRegistry } from "@/lib/live-runtime/stage-run-nonce-registry";
import type { TrustedPlatformStageAdapter } from "@/lib/course-tools/tools/platform-stage";
import type { WorkbenchDb } from "@/lib/workbench/durable-ledger";
import {
  type WorkbenchTrustedStageProviders
} from "@/lib/workbench/course-agent-toolkit-bootstrap";
import { PrismaWorkbenchStageTransactionStore } from "@/lib/workbench/prisma-workbench-stage-transaction-store";
import {
  createTrustedWorkbenchPlatformStageAdapter,
  type WorkbenchStageBrowserSessionFactory,
  type WorkbenchStageTargetResolver
} from "@/lib/workbench/trusted-workbench-platform-stage-adapter";

const COURSE_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MINIMUM_SIGNING_SECRET_BYTES = 32;

type ProviderResolverInput = Parameters<
  WorkbenchTrustedStageProviders["resolvePlatformStageAdapter"]
>[0];

export type WorkbenchStageSigningSecretProvider =
  () => Buffer | Promise<Buffer>;

export type WorkbenchTrustedStageProviderInput = Readonly<{
  db: WorkbenchDb;
  courseAlias: string;
  targetResolver: WorkbenchStageTargetResolver;
  browserSessionFactory: WorkbenchStageBrowserSessionFactory;
  signingSecretProvider: WorkbenchStageSigningSecretProvider;
}>;

type SafeProviderErrorCode =
  | "WORKBENCH_TRUSTED_STAGE_SERVER_ONLY"
  | "WORKBENCH_TRUSTED_STAGE_CONFIGURATION_INVALID"
  | "WORKBENCH_TRUSTED_STAGE_COURSE_SCOPE_MISMATCH"
  | "WORKBENCH_TRUSTED_STAGE_PROVIDER_UNAVAILABLE";

class WorkbenchTrustedStageProviderError extends Error {
  readonly code: SafeProviderErrorCode;

  constructor(code: SafeProviderErrorCode) {
    super(code);
    this.name = "WorkbenchTrustedStageProviderError";
    this.code = code;
  }
}

function safeError(code: SafeProviderErrorCode): WorkbenchTrustedStageProviderError {
  return new WorkbenchTrustedStageProviderError(code);
}

function convergeError(error: unknown): WorkbenchTrustedStageProviderError {
  return error instanceof WorkbenchTrustedStageProviderError
    ? error
    : safeError("WORKBENCH_TRUSTED_STAGE_PROVIDER_UNAVAILABLE");
}

function assertServerOnlyRuntime(): void {
  if (typeof window !== "undefined") {
    throw safeError("WORKBENCH_TRUSTED_STAGE_SERVER_ONLY");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasMethod(value: unknown, method: string): boolean {
  return isRecord(value) && typeof value[method] === "function";
}

function hasPersistentStageDbSurface(value: unknown): value is WorkbenchDb {
  if (!isRecord(value) || typeof value.$executeRaw !== "function") return false;
  return (
    hasMethod(value.workbenchRunRecord, "findFirst") &&
    hasMethod(value.workbenchPlanRevisionRecord, "findFirst") &&
    hasMethod(value.workbenchPlanStepRecord, "findFirst") &&
    hasMethod(value.workbenchToolCallRecord, "findFirst") &&
    hasMethod(value.workbenchStageTransactionRecord, "findUnique") &&
    hasMethod(value.workbenchStageTransactionRecord, "create") &&
    hasMethod(value.workbenchStageTransactionRecord, "updateMany")
  );
}

function assertConfiguration(
  input: WorkbenchTrustedStageProviderInput
): void {
  if (
    !isRecord(input) ||
    !hasPersistentStageDbSurface(input.db) ||
    typeof input.courseAlias !== "string" ||
    !COURSE_ALIAS_PATTERN.test(input.courseAlias) ||
    !isRecord(input.targetResolver) ||
    typeof input.targetResolver.resolve !== "function" ||
    !isRecord(input.browserSessionFactory) ||
    typeof input.browserSessionFactory.open !== "function" ||
    typeof input.signingSecretProvider !== "function"
  ) {
    throw safeError("WORKBENCH_TRUSTED_STAGE_CONFIGURATION_INVALID");
  }
}

function assertResolverDependencies(input: ProviderResolverInput): void {
  if (
    !isRecord(input) ||
    !isRecord(input.materialLedger) ||
    typeof input.materialLedger.resolveStageMaterial !== "function" ||
    !isRecord(input.protectedMaterialVault) ||
    typeof input.protectedMaterialVault.resolve !== "function" ||
    !isRecord(input.protectedStore) ||
    typeof input.protectedStore.getByRef !== "function"
  ) {
    throw safeError("WORKBENCH_TRUSTED_STAGE_CONFIGURATION_INVALID");
  }
}

function assertExactCourse(
  request: Readonly<{
    context: Readonly<{ courseScope: Readonly<{ alias: string }> }>;
  }>,
  courseAlias: string
): void {
  if (request.context.courseScope.alias !== courseAlias) {
    throw safeError("WORKBENCH_TRUSTED_STAGE_COURSE_SCOPE_MISMATCH");
  }
}

async function resolveSigningSecret(
  provider: WorkbenchStageSigningSecretProvider
): Promise<Buffer> {
  let value: unknown;
  try {
    value = await provider();
  } catch {
    throw safeError("WORKBENCH_TRUSTED_STAGE_PROVIDER_UNAVAILABLE");
  }
  if (
    !Buffer.isBuffer(value) ||
    value.byteLength < MINIMUM_SIGNING_SECRET_BYTES
  ) {
    throw safeError("WORKBENCH_TRUSTED_STAGE_PROVIDER_UNAVAILABLE");
  }
  return Buffer.from(value);
}

function createLazyTrustedAdapter(input: {
  readonly configuration: WorkbenchTrustedStageProviderInput;
  readonly dependencies: ProviderResolverInput;
}): TrustedPlatformStageAdapter {
  let adapterPromise: Promise<TrustedPlatformStageAdapter> | undefined;
  const load = (): Promise<TrustedPlatformStageAdapter> => {
    adapterPromise ??= Promise.resolve().then(async () => {
      assertServerOnlyRuntime();
      const signingSecret = await resolveSigningSecret(
        input.configuration.signingSecretProvider
      );
      return createTrustedWorkbenchPlatformStageAdapter({
        materialLedger: input.dependencies.materialLedger,
        protectedMaterialVault: input.dependencies.protectedMaterialVault,
        targetResolver: input.configuration.targetResolver,
        browserSessionFactory: input.configuration.browserSessionFactory,
        nonceRegistry: new PrismaStageRunNonceRegistry(input.configuration.db),
        transactionStore: new PrismaWorkbenchStageTransactionStore(
          input.configuration.db
        ),
        signingSecret
      });
    });
    return adapterPromise;
  };

  const adapter: TrustedPlatformStageAdapter = {
    preflightRead: async (request) => {
      try {
        assertServerOnlyRuntime();
        assertExactCourse(request, input.configuration.courseAlias);
        return await (await load()).preflightRead(request);
      } catch (error) {
        throw convergeError(error);
      }
    },
    stageVerifyClear: async (request) => {
      try {
        assertServerOnlyRuntime();
        assertExactCourse(request, input.configuration.courseAlias);
        return await (await load()).stageVerifyClear(request);
      } catch (error) {
        throw convergeError(error);
      }
    },
    reconcileStage: async (request) => {
      try {
        assertServerOnlyRuntime();
        assertExactCourse(request, input.configuration.courseAlias);
        return await (await load()).reconcileStage(request);
      } catch (error) {
        throw convergeError(error);
      }
    }
  };
  return Object.freeze(adapter);
}

/**
 * Server-only composition root for Workbench STAGE. Construction is inert:
 * neither protected signing material nor a target/browser session is touched
 * before the first genuine trusted operation. This surface contains no publish
 * provider; the composed adapter can only preflight, stage/readback/clear, or
 * reconcile an owned zero-submit transaction.
 */
export function createWorkbenchTrustedStageProviders(
  input: WorkbenchTrustedStageProviderInput
): WorkbenchTrustedStageProviders {
  assertServerOnlyRuntime();
  assertConfiguration(input);
  const configuration = Object.freeze({ ...input });
  return Object.freeze({
    resolvePlatformStageAdapter: (dependencies) => {
      assertServerOnlyRuntime();
      assertResolverDependencies(dependencies);
      return createLazyTrustedAdapter({ configuration, dependencies });
    }
  });
}
