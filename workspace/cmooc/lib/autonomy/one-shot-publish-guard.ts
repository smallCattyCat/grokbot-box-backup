/**
 * Operator-intent guard shared by the CLI, the combined orchestration and the
 * actual publication boundary. It supplements (and never replaces) the
 * manifest, policy, STAGE, Permit and global hard-lock checks.
 */
export function assertTrustedStagePublishGuards(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.CMOOC_L3_TRUSTED_STAGE_BRIDGE !== "1") {
    throw new Error("L3_TRUSTED_STAGE_BRIDGE_GUARD_REQUIRED");
  }
  if (env.CMOOC_L3_TRUSTED_STAGE_PUBLISH !== "1") {
    throw new Error("L3_TRUSTED_STAGE_PUBLISH_GUARD_REQUIRED");
  }
}
