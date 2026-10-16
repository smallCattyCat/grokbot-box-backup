CREATE TABLE "AutonomyWorkerWakeReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "runtimeVersion" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "exitCode" INTEGER,
    "countsJson" TEXT NOT NULL,
    "sourceTruncated" BOOLEAN NOT NULL DEFAULT false,
    "taskSetHash" TEXT NOT NULL,
    "summaryHash" TEXT NOT NULL,
    "editorWriteCount" INTEGER NOT NULL DEFAULT 0,
    "publishAttemptCount" INTEGER NOT NULL DEFAULT 0,
    "realPublishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "AutonomyWorkerWakeReceipt_source_startedAt_idx"
ON "AutonomyWorkerWakeReceipt"("source", "startedAt");

CREATE INDEX "AutonomyWorkerWakeReceipt_status_startedAt_idx"
ON "AutonomyWorkerWakeReceipt"("status", "startedAt");
