import {
  buildP4FLiteEvidence,
  persistP4FLiteEvidence
} from "../lib/golden-path/p4f-lite";

async function main() {
  const evidence = await buildP4FLiteEvidence();
  if (
    evidence.completedCount !== evidence.scenarioCount ||
    evidence.completionRate !== 1 ||
    evidence.functionFidelityRate !== 1 ||
    evidence.moveFidelityRate !== 1 ||
    evidence.targetFidelityRate !== 1 ||
    evidence.draftRuleFidelityRate !== 1 ||
    evidence.decisionFidelityRate !== 1 ||
    evidence.externalWriteCalls !== 0 ||
    evidence.realForumWriteCalls !== 0 ||
    evidence.leakedForumTextCount !== 0
  ) {
    throw new Error("P4F-lite 三情境保真审计未通过。");
  }
  await persistP4FLiteEvidence(evidence);
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
