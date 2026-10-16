-- Keep foreign-key actions disabled before opening the explicit transaction.
-- SQLite ignores PRAGMA foreign_keys changes inside BEGIN, and dropping the
-- old parent table with FK actions enabled could otherwise mutate AgentRun or
-- PublishLog evidence before the replacement table is installed.
PRAGMA foreign_keys=OFF;
PRAGMA defer_foreign_keys=ON;
BEGIN IMMEDIATE;

CREATE TABLE "new_InterventionTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "postId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "interventionType" TEXT NOT NULL,
    "publishTarget" TEXT NOT NULL DEFAULT 'post_comment',
    "targetCommentStrategy" TEXT,
    "targetCommentIndex" INTEGER,
    "targetPlatformReplyId" TEXT,
    "targetCommentContentHash" TEXT,
    "targetCommentPreview" TEXT,
    "priorityScore" REAL NOT NULL,
    "status" TEXT NOT NULL,
    "draftContent" TEXT,
    "finalContent" TEXT,
    "safetyRisk" INTEGER,
    "safetyResult" TEXT,
    "publishedUrl" TEXT,
    "screenshotPath" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "sourceCandidateId" TEXT,
    "contentHash" TEXT,
    "targetHash" TEXT,
    "policyDecisionJson" TEXT,
    "policyVersion" TEXT,
    "safetyCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "publishedAt" DATETIME,
    CONSTRAINT "InterventionTask_courseId_fkey"
        FOREIGN KEY ("courseId") REFERENCES "Course" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InterventionTask_postId_fkey"
        FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InterventionTask_targetUserId_fkey"
        FOREIGN KEY ("targetUserId") REFERENCES "ForumUser" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InterventionTask_sourceCandidateId_fkey"
        FOREIGN KEY ("sourceCandidateId")
        REFERENCES "AutoInterventionCandidate" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_InterventionTask" (
    "contentHash", "courseId", "createdAt", "draftContent", "errorMessage",
    "finalContent", "id", "interventionType", "policyDecisionJson",
    "policyVersion", "postId", "priorityScore", "publishTarget",
    "publishedAt", "publishedUrl", "retryCount", "safetyCheckedAt",
    "safetyResult", "safetyRisk", "screenshotPath", "sourceCandidateId",
    "status", "targetCommentContentHash", "targetCommentIndex",
    "targetCommentPreview", "targetCommentStrategy", "targetHash",
    "targetPlatformReplyId", "targetUserId", "updatedAt"
)
SELECT
    "contentHash", "courseId", "createdAt", "draftContent", "errorMessage",
    "finalContent", "id", "interventionType", "policyDecisionJson",
    "policyVersion", "postId", "priorityScore", "publishTarget",
    "publishedAt", "publishedUrl", "retryCount", "safetyCheckedAt",
    "safetyResult", "safetyRisk", "screenshotPath", "sourceCandidateId",
    "status", "targetCommentContentHash", "targetCommentIndex",
    "targetCommentPreview", "targetCommentStrategy", "targetHash",
    "targetPlatformReplyId", "targetUserId", "updatedAt"
FROM "InterventionTask";

DROP TABLE "InterventionTask";
ALTER TABLE "new_InterventionTask" RENAME TO "InterventionTask";

CREATE UNIQUE INDEX "InterventionTask_sourceCandidateId_key"
ON "InterventionTask"("sourceCandidateId");
CREATE INDEX "InterventionTask_courseId_idx"
ON "InterventionTask"("courseId");
CREATE INDEX "InterventionTask_postId_idx"
ON "InterventionTask"("postId");
CREATE INDEX "InterventionTask_targetUserId_idx"
ON "InterventionTask"("targetUserId");
CREATE INDEX "InterventionTask_status_idx"
ON "InterventionTask"("status");
CREATE INDEX "InterventionTask_contentHash_idx"
ON "InterventionTask"("contentHash");
CREATE INDEX "InterventionTask_targetPlatformReplyId_idx"
ON "InterventionTask"("targetPlatformReplyId");
CREATE UNIQUE INDEX "InterventionTask_one_open_plan_per_post_key"
ON "InterventionTask"("postId")
WHERE "status" IN (
    'proposed',
    'review_required',
    'ready',
    'publishing',
    'failed_retryable',
    'reconcile_required'
);

CREATE TABLE "new_PublishLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "authorizationId" TEXT,
    "action" TEXT NOT NULL DEFAULT 'publish',
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "contentHash" TEXT,
    "targetHash" TEXT,
    "idempotencyKey" TEXT,
    "transport" TEXT,
    "remoteUrl" TEXT,
    "screenshotPath" TEXT,
    "evidenceJson" TEXT,
    "errorCode" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PublishLog_taskId_fkey"
        FOREIGN KEY ("taskId") REFERENCES "InterventionTask" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PublishLog_authorizationId_fkey"
        FOREIGN KEY ("authorizationId")
        REFERENCES "PublishAuthorization" ("id")
        ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_PublishLog" (
    "action", "authorizationId", "contentHash", "createdAt", "errorCode",
    "evidenceJson", "finishedAt", "id", "idempotencyKey", "message",
    "remoteUrl", "screenshotPath", "startedAt", "status", "targetHash",
    "taskId", "transport"
)
SELECT
    "action", "authorizationId", "contentHash", "createdAt", "errorCode",
    "evidenceJson", "finishedAt", "id", "idempotencyKey", "message",
    "remoteUrl", "screenshotPath", "startedAt", "status", "targetHash",
    "taskId", "transport"
FROM "PublishLog";

DROP TABLE "PublishLog";
ALTER TABLE "new_PublishLog" RENAME TO "PublishLog";

CREATE UNIQUE INDEX "PublishLog_idempotencyKey_key"
ON "PublishLog"("idempotencyKey");
CREATE INDEX "PublishLog_taskId_idx" ON "PublishLog"("taskId");
CREATE INDEX "PublishLog_authorizationId_idx"
ON "PublishLog"("authorizationId");
CREATE INDEX "PublishLog_status_idx" ON "PublishLog"("status");

COMMIT;
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
