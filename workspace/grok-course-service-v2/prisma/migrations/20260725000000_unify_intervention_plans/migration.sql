-- Evolve InterventionTask into the canonical intervention plan without dropping
-- historical tasks or AutoInterventionCandidate research provenance.
ALTER TABLE "InterventionTask" ADD COLUMN "sourceCandidateId" TEXT REFERENCES "AutoInterventionCandidate"("id") ON DELETE SET NULL;
ALTER TABLE "InterventionTask" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "InterventionTask" ADD COLUMN "targetHash" TEXT;
ALTER TABLE "InterventionTask" ADD COLUMN "policyDecisionJson" TEXT;
ALTER TABLE "InterventionTask" ADD COLUMN "policyVersion" TEXT;
ALTER TABLE "InterventionTask" ADD COLUMN "safetyCheckedAt" DATETIME;

CREATE UNIQUE INDEX "InterventionTask_sourceCandidateId_key" ON "InterventionTask"("sourceCandidateId");
CREATE INDEX "InterventionTask_contentHash_idx" ON "InterventionTask"("contentHash");

-- Convert the old step-by-step workflow into the smaller canonical lifecycle.
UPDATE "InterventionTask" SET "status" = 'proposed'
WHERE "status" IN ('discovered', 'analyzed', 'candidate');
UPDATE "InterventionTask" SET "status" = 'review_required'
WHERE "status" IN ('drafted', 'safety_checked', 'manual_review');
UPDATE "InterventionTask" SET "status" = 'ready'
WHERE "status" = 'queued';
UPDATE "InterventionTask" SET "status" = 'failed_retryable'
WHERE "status" = 'failed';
UPDATE "InterventionTask" SET "status" = 'reconcile_required'
WHERE "status" = 'publishing';

CREATE TABLE "PublishAuthorization" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'single',
  "status" TEXT NOT NULL DEFAULT 'active',
  "contentHash" TEXT NOT NULL,
  "targetHash" TEXT NOT NULL,
  "expiresAt" DATETIME NOT NULL,
  "maxUses" INTEGER NOT NULL DEFAULT 1,
  "usedCount" INTEGER NOT NULL DEFAULT 0,
  "metadataJson" TEXT NOT NULL DEFAULT '{}',
  "authorizedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" DATETIME,
  "revokedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "PublishAuthorization_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "InterventionTask" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PublishAuthorization_taskId_status_idx"
  ON "PublishAuthorization"("taskId", "status");
CREATE INDEX "PublishAuthorization_expiresAt_idx"
  ON "PublishAuthorization"("expiresAt");

-- Keep the existing PublishLog table and its historical rows, but promote it to
-- the single authoritative PublishAttempt store.
ALTER TABLE "PublishLog" ADD COLUMN "authorizationId" TEXT REFERENCES "PublishAuthorization"("id") ON DELETE SET NULL;
ALTER TABLE "PublishLog" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "PublishLog" ADD COLUMN "targetHash" TEXT;
ALTER TABLE "PublishLog" ADD COLUMN "idempotencyKey" TEXT;
ALTER TABLE "PublishLog" ADD COLUMN "transport" TEXT;
ALTER TABLE "PublishLog" ADD COLUMN "remoteUrl" TEXT;
ALTER TABLE "PublishLog" ADD COLUMN "evidenceJson" TEXT;
ALTER TABLE "PublishLog" ADD COLUMN "errorCode" TEXT;
ALTER TABLE "PublishLog" ADD COLUMN "startedAt" DATETIME;
ALTER TABLE "PublishLog" ADD COLUMN "finishedAt" DATETIME;

CREATE UNIQUE INDEX "PublishLog_idempotencyKey_key" ON "PublishLog"("idempotencyKey");
CREATE INDEX "PublishLog_authorizationId_idx" ON "PublishLog"("authorizationId");
CREATE INDEX "PublishLog_status_idx" ON "PublishLog"("status");
