import { prisma as defaultPrisma } from "@/lib/db";
import type { TrustedPlatformStageAdapter } from "@/lib/course-tools/tools/platform-stage";
import type { CourseAgentArtifactRuntimeOptions } from "@/lib/workbench/course-agent-artifact-runtime";
import {
  createUnavailablePlatformStageAdapter,
  type CourseAgentToolkit
} from "@/lib/workbench/course-agent-toolkit";
import {
  type CourseAgentActionPolicyMode,
  type CourseAgentAutoActionExecutor
} from "@/lib/workbench/course-agent-runtime";
import { autoAuthorizeAndExecuteCourseAgentAction } from "@/lib/workbench/course-agent-action-execution";
import {
  registerCourseAgentProcessSession,
  type CourseAgentProcessSession
} from "@/lib/workbench/course-agent-session";
import type { WorkbenchCourseToolTransport } from "@/lib/workbench/course-tool-transport";
import {
  createWorkbenchCourseAgentToolkit,
  type WorkbenchTrustedStageProviders
} from "@/lib/workbench/course-agent-toolkit-bootstrap";

type WorkbenchTrustedStageEnv = Readonly<{
  CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED?: string;
  CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED?: string;
}>;

export const WORKBENCH_AUTO_REVERSIBLE_STAGE_ENV_KEY =
  "CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED" as const;

export type WorkbenchTrustedStageProviderSourceInput = Readonly<{
  courseAlias: string;
  prisma: typeof defaultPrisma;
}>;

/**
 * Server composition seam for a complete trusted STAGE provider set. The
 * source may close over protected readers, browser binders, or secret
 * providers, but none of those dependencies are resolved during route/task
 * construction.
 */
export type WorkbenchTrustedStageProviderSource = (
  input: WorkbenchTrustedStageProviderSourceInput
) =>
  | WorkbenchTrustedStageProviders
  | undefined
  | Promise<WorkbenchTrustedStageProviders | undefined>;

export type WorkbenchRouteCourseAgentToolkitInput =
  CourseAgentArtifactRuntimeOptions &
  Readonly<{
    env?: WorkbenchTrustedStageEnv;
    trustedStageProviderSource?: WorkbenchTrustedStageProviderSource;
  }>;

export type WorkbenchRouteCourseAgentComposition = Readonly<{
  toolkit: CourseAgentToolkit;
  actionPolicyMode: CourseAgentActionPolicyMode;
  autoActionExecutor?: CourseAgentAutoActionExecutor;
  registerProcessSession: (
    transport: WorkbenchCourseToolTransport
  ) => CourseAgentProcessSession;
}>;

let trustedStageProviderSourceForTests:
  | WorkbenchTrustedStageProviderSource
  | undefined;

function assertServerRuntime(): void {
  if (typeof window !== "undefined") {
    throw new Error("WORKBENCH_COURSE_AGENT_TOOLKIT_SERVER_ONLY");
  }
}

function isCompleteProviders(
  value: unknown
): value is WorkbenchTrustedStageProviders {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as WorkbenchTrustedStageProviders)
      .resolvePlatformStageAdapter === "function"
  );
}

function isCompleteAdapter(
  value: unknown
): value is TrustedPlatformStageAdapter {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as TrustedPlatformStageAdapter).preflightRead === "function" &&
    typeof (value as TrustedPlatformStageAdapter).stageVerifyClear === "function" &&
    typeof (value as TrustedPlatformStageAdapter).reconcileStage === "function"
  );
}

function lazyProviders(input: {
  source: WorkbenchTrustedStageProviderSource;
  courseAlias: string;
  prisma: typeof defaultPrisma;
}): WorkbenchTrustedStageProviders {
  return Object.freeze({
    resolvePlatformStageAdapter: async (dependencies) => {
      let providers: WorkbenchTrustedStageProviders | undefined;
      try {
        providers = await input.source(
          Object.freeze({
            courseAlias: input.courseAlias,
            prisma: input.prisma
          })
        );
      } catch {
        return createUnavailablePlatformStageAdapter();
      }
      if (!isCompleteProviders(providers)) {
        return createUnavailablePlatformStageAdapter();
      }
      try {
        const adapter = await providers.resolvePlatformStageAdapter(dependencies);
        return isCompleteAdapter(adapter)
          ? adapter
          : createUnavailablePlatformStageAdapter();
      } catch {
        return createUnavailablePlatformStageAdapter();
      }
    }
  });
}

/**
 * The single server-side composition root used by both root-run creation and
 * child-run launch. Without the exact feature flag and a complete source, the
 * toolkit keeps its honest no-browser adapter while all L0/L1 tools remain
 * registered.
 */
export function createWorkbenchRouteCourseAgentToolkit(
  input: WorkbenchRouteCourseAgentToolkitInput
): CourseAgentToolkit {
  return createWorkbenchRouteCourseAgentComposition(input).toolkit;
}

/**
 * Composes the toolkit, the explicit server action policy, and the late-bound
 * process session used by that policy. Merely constructing this object never
 * resolves a provider or touches a browser/reader/secret. Trusted adapter
 * availability and automatic execution are independent server policies. AUTO
 * reversible STAGE requires both exact flags plus an injected source; every
 * other configuration keeps the existing confirmation policy.
 */
export function createWorkbenchRouteCourseAgentComposition(
  input: WorkbenchRouteCourseAgentToolkitInput
): WorkbenchRouteCourseAgentComposition {
  assertServerRuntime();
  const {
    env,
    trustedStageProviderSource,
    ...toolkitOptions
  } = input;
  const source =
    trustedStageProviderSource ?? trustedStageProviderSourceForTests;
  const resolvedEnv = env ?? process.env;
  const actionPolicyMode: CourseAgentActionPolicyMode =
    resolvedEnv.CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED === "1" &&
    resolvedEnv.CMOOC_WORKBENCH_AUTO_REVERSIBLE_STAGE_ENABLED === "1" &&
    source
      ? "auto_reversible"
      : "confirm_stage";
  const providers = source
    ? lazyProviders({
        source,
        courseAlias: toolkitOptions.courseAlias,
        prisma: toolkitOptions.prisma ?? defaultPrisma
      })
    : undefined;
  const toolkit = createWorkbenchCourseAgentToolkit({
    ...toolkitOptions,
    env,
    providers
  });
  let processSession: CourseAgentProcessSession | undefined;
  const autoActionExecutor: CourseAgentAutoActionExecutor | undefined =
    actionPolicyMode === "auto_reversible"
      ? async ({ pendingAction }) => {
          if (!processSession) {
            throw new Error("WORKBENCH_COURSE_AGENT_SESSION_NOT_BOUND");
          }
          return autoAuthorizeAndExecuteCourseAgentAction({
            db: toolkitOptions.prisma ?? defaultPrisma,
            pendingAction,
            session: processSession,
            policyMode: "auto_reversible"
          });
        }
      : undefined;

  return Object.freeze({
    toolkit,
    actionPolicyMode,
    ...(autoActionExecutor ? { autoActionExecutor } : {}),
    registerProcessSession: (transport) => {
      const session = registerCourseAgentProcessSession({
        taskId: toolkitOptions.taskId,
        runId: toolkitOptions.runId,
        courseAlias: toolkitOptions.courseAlias,
        toolkit,
        transport,
        db: toolkitOptions.artifactDb ?? toolkitOptions.prisma ?? defaultPrisma
      });
      processSession = session;
      return session;
    }
  });
}

/**
 * Process-local test seam kept outside Next route modules, because route files
 * may export handlers/configuration only. Passing undefined restores the inert
 * production default.
 */
export function setWorkbenchTrustedStageProviderSourceForTests(
  source: WorkbenchTrustedStageProviderSource | undefined
): void {
  assertServerRuntime();
  if (source !== undefined && typeof source !== "function") {
    throw new Error("WORKBENCH_TRUSTED_STAGE_PROVIDER_SOURCE_INVALID");
  }
  trustedStageProviderSourceForTests = source;
}
