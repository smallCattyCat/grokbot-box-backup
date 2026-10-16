CREATE TABLE "ExecutionStageReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "decisionId" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "receiptHash" TEXT NOT NULL,
    "targetVersionHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "editorWriteCount" INTEGER NOT NULL DEFAULT 1,
    "editorClearCount" INTEGER NOT NULL DEFAULT 1,
    "sentMutationCount" INTEGER NOT NULL DEFAULT 0,
    "publishAttempted" BOOLEAN NOT NULL DEFAULT false,
    "bodyPersisted" BOOLEAN NOT NULL DEFAULT false,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExecutionStageReceipt_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutonomyDecision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ExecutionStageReceipt_decisionId_key" ON "ExecutionStageReceipt"("decisionId");
CREATE UNIQUE INDEX "ExecutionStageReceipt_receiptHash_key" ON "ExecutionStageReceipt"("receiptHash");
CREATE INDEX "ExecutionStageReceipt_courseAlias_policyVersion_status_idx" ON "ExecutionStageReceipt"("courseAlias", "policyVersion", "status");
CREATE INDEX "ExecutionStageReceipt_expiresAt_idx" ON "ExecutionStageReceipt"("expiresAt");

-- One policy version can authorize at most one real execution, even under
-- concurrent callers. Prisma cannot currently express SQLite partial indexes.
CREATE UNIQUE INDEX "ExecutionPermit_one_real_per_course_policy_key"
ON "ExecutionPermit"("courseAlias", "policyVersion")
WHERE "realPublishEnabled" = true;
