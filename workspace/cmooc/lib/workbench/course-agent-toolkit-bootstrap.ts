import type { TrustedPlatformStageAdapter } from "@/lib/course-tools/tools/platform-stage";
import type { CourseAgentArtifactRuntimeOptions } from "@/lib/workbench/course-agent-artifact-runtime";
import {
  createCourseAgentToolkit,
  type CourseAgentToolkit,
  type CourseAgentToolkitOptions
} from "@/lib/workbench/course-agent-toolkit";

export const WORKBENCH_TRUSTED_STAGE_ENV_KEY =
  "CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED" as const;

type PlatformStageAdapterFactory = NonNullable<
  CourseAgentToolkitOptions["platformStageAdapterFactory"]
>;
type PlatformStageAdapterFactoryInput = Parameters<PlatformStageAdapterFactory>[0];

export type WorkbenchTrustedStageProviders = Readonly<{
  /**
   * This resolver is server-only. It may obtain protected providers when first
   * used, but it must never serialize their paths, values, or login state.
   */
  resolvePlatformStageAdapter: (
    input: PlatformStageAdapterFactoryInput
  ) => TrustedPlatformStageAdapter | Promise<TrustedPlatformStageAdapter>;
}>;

export type WorkbenchCourseAgentToolkitBootstrap = Readonly<{
  stageMode: "disabled" | "available" | "blocked";
  reasonCode: "feature_disabled" | "provider_unavailable" | "ready";
  platformStageAdapterFactory?: PlatformStageAdapterFactory;
}>;

type TrustedStageEnv = Readonly<{
  CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED?: string;
}>;

function assertTrustedStageAdapter(value: unknown): TrustedPlatformStageAdapter {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as TrustedPlatformStageAdapter).preflightRead !== "function" ||
    typeof (value as TrustedPlatformStageAdapter).stageVerifyClear !== "function" ||
    typeof (value as TrustedPlatformStageAdapter).reconcileStage !== "function"
  ) {
    throw new Error("WORKBENCH_TRUSTED_STAGE_PROVIDER_INVALID");
  }
  return value as TrustedPlatformStageAdapter;
}

function createLazyPlatformStageAdapter(
  resolve: () => TrustedPlatformStageAdapter | Promise<TrustedPlatformStageAdapter>
): TrustedPlatformStageAdapter {
  let adapterPromise: Promise<TrustedPlatformStageAdapter> | undefined;
  const load = () => {
    adapterPromise ??= Promise.resolve()
      .then(resolve)
      .then(assertTrustedStageAdapter);
    return adapterPromise;
  };

  const adapter: TrustedPlatformStageAdapter = {
    preflightRead: async (input) => (await load()).preflightRead(input),
    stageVerifyClear: async (input) => (await load()).stageVerifyClear(input),
    reconcileStage: async (input) => (await load()).reconcileStage(input)
  };
  return Object.freeze(adapter);
}

/**
 * Resolves only capability availability. It does not read manifests, locate a
 * target, inspect an auth session, or open a browser.
 */
export function resolveWorkbenchCourseAgentToolkitBootstrap(input: {
  readonly env?: TrustedStageEnv;
  readonly providers?: WorkbenchTrustedStageProviders;
} = {}): WorkbenchCourseAgentToolkitBootstrap {
  const env = input.env ?? process.env;
  if (env.CMOOC_WORKBENCH_TRUSTED_STAGE_ENABLED !== "1") {
    return Object.freeze({
      stageMode: "disabled",
      reasonCode: "feature_disabled"
    });
  }
  if (!input.providers) {
    return Object.freeze({
      stageMode: "blocked",
      reasonCode: "provider_unavailable"
    });
  }

  const providers = input.providers;
  const platformStageAdapterFactory: PlatformStageAdapterFactory =
    (dependencies) =>
      createLazyPlatformStageAdapter(() =>
        providers.resolvePlatformStageAdapter(dependencies)
      );

  return Object.freeze({
    stageMode: "available",
    reasonCode: "ready",
    platformStageAdapterFactory
  });
}

export function createWorkbenchCourseAgentToolkit(
  input: CourseAgentArtifactRuntimeOptions & {
    readonly env?: TrustedStageEnv;
    readonly providers?: WorkbenchTrustedStageProviders;
    readonly bootstrap?: WorkbenchCourseAgentToolkitBootstrap;
  }
): CourseAgentToolkit {
  const { env, providers, bootstrap, ...toolkitOptions } = input;
  const resolved =
    bootstrap ?? resolveWorkbenchCourseAgentToolkitBootstrap({ env, providers });
  return createCourseAgentToolkit({
    ...toolkitOptions,
    platformStageAdapterFactory: resolved.platformStageAdapterFactory
  });
}
