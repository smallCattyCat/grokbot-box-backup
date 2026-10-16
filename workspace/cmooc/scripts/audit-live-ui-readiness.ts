import { inspectCmoocUiReadiness } from "@/lib/platform-readiness/cmooc-ui-readiness";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() || null : null;
}

async function main() {
  const targetInput =
    argument("--target-url") ??
    process.env.CMOOC_DEMO_COURSE_URL?.trim() ??
    null;
  if (!targetInput) {
    throw new Error(
      "请通过 --target-url 或 CMOOC_DEMO_COURSE_URL 提供课程入口；真实课程 ID 不写入仓库。"
    );
  }
  const result = await inspectCmoocUiReadiness({ targetInput });
  console.log(
    JSON.stringify(
      {
        schemaVersion: result.receipt.schemaVersion,
        status: result.receipt.status,
        safeToDemonstrate: result.receipt.safeToDemonstrate,
        normalizationSource:
          result.receipt.normalizationSource,
        inputWasNormalized:
          result.receipt.inputWasNormalized,
        courseShellDetected:
          result.receipt.courseShellDetected,
        categoryTabCount: result.receipt.categoryTabCount,
        visibleCardCount: result.receipt.visibleCardCount,
        anonymizedCardKeyCount:
          result.receipt.visibleCardKeys.length,
        sessionBoundary: result.receipt.sessionBoundary,
        detailObservation: result.receipt.detailObservation,
        detailEvidenceLevel:
          result.receipt.detailEvidenceLevel,
        apiAssistKinds: result.receipt.apiAssistKinds,
        allowedGetOrHeadCount:
          result.receipt.allowedGetOrHeadCount,
        allowedSemanticReadPostCount:
          result.receipt.allowedSemanticReadPostCount,
        blockedWriteRequestCount:
          result.receipt.blockedWriteRequestCount,
        requestedMutationCount:
          result.receipt.requestedMutationCount,
        sentMutationCount: result.receipt.sentMutationCount,
        networkGuardActive:
          result.receipt.networkGuardActive,
        realPublishEnabled:
          result.receipt.realPublishEnabled,
        externalWriteAttempted:
          result.receipt.externalWriteAttempted,
        containsForumText: result.receipt.containsForumText,
        evidenceHash: result.evidenceHash
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "LIFT-1 预检失败。"
  );
  process.exitCode = 1;
});
