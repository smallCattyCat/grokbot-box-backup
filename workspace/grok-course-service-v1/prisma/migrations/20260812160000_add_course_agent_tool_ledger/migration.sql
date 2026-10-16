CREATE TABLE "WorkbenchSafeTaskObjective" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "objectiveHash" TEXT NOT NULL,
    "safeSummary" TEXT NOT NULL,
    "structuredGoalJson" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkbenchSafeTaskObjective_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "WorkbenchTask" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorkbenchPlanRevisionRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "objectiveHash" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "compilerVersion" TEXT NOT NULL,
    "proposalHash" TEXT,
    "safeSummary" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkbenchPlanRevisionRecord_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "WorkbenchTask" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchPlanRevisionRecord_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "WorkbenchRunRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorkbenchPlanStepRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planRevisionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolVersion" TEXT NOT NULL,
    "dependencyIdsJson" TEXT NOT NULL,
    "inputRefsJson" TEXT NOT NULL,
    "preconditionsJson" TEXT NOT NULL,
    "postconditionsJson" TEXT NOT NULL,
    "effectClass" TEXT NOT NULL,
    "requiredCapability" TEXT NOT NULL,
    "acceptanceJson" TEXT NOT NULL,
    "replanPolicyJson" TEXT NOT NULL,
    "safeSummary" TEXT NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkbenchPlanStepRecord_planRevisionId_fkey"
      FOREIGN KEY ("planRevisionId") REFERENCES "WorkbenchPlanRevisionRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorkbenchExecutionLease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT,
    "scopeKey" TEXT NOT NULL,
    "ownerInstanceId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "fencingTokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL,
    "heartbeatAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "releasedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkbenchExecutionLease_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "WorkbenchTask" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchExecutionLease_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "WorkbenchRunRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchExecutionLease_stepId_fkey"
      FOREIGN KEY ("stepId") REFERENCES "WorkbenchPlanStepRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorkbenchToolCallRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "executionLeaseId" TEXT NOT NULL,
    "parentCallId" TEXT,
    "toolName" TEXT NOT NULL,
    "toolVersion" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "effectClass" TEXT NOT NULL,
    "safeInputSummary" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "grantRef" TEXT,
    "leaseGeneration" INTEGER NOT NULL,
    "fencingTokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "causationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "WorkbenchToolCallRecord_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "WorkbenchTask" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchToolCallRecord_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "WorkbenchRunRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchToolCallRecord_stepId_fkey"
      FOREIGN KEY ("stepId") REFERENCES "WorkbenchPlanStepRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchToolCallRecord_executionLeaseId_fkey"
      FOREIGN KEY ("executionLeaseId") REFERENCES "WorkbenchExecutionLease" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchToolCallRecord_parentCallId_fkey"
      FOREIGN KEY ("parentCallId") REFERENCES "WorkbenchToolCallRecord" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "WorkbenchToolReceiptRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "safeOutputSummary" TEXT NOT NULL,
    "outputHash" TEXT NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL,
    "beforeRefJson" TEXT,
    "afterRefJson" TEXT,
    "verificationId" TEXT,
    "compensationRef" TEXT,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "containsIdentity" BOOLEAN NOT NULL DEFAULT false,
    "observedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkbenchToolReceiptRecord_callId_fkey"
      FOREIGN KEY ("callId") REFERENCES "WorkbenchToolCallRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WorkbenchArtifactVersionRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "artifactKind" TEXT NOT NULL,
    "contentClass" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "draftBodyHash" TEXT,
    "contentRef" TEXT,
    "safeSummary" TEXT NOT NULL,
    "metadataJson" TEXT NOT NULL,
    "sourceRefsJson" TEXT NOT NULL,
    "regenerationRecipeJson" TEXT,
    "createdByCallId" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkbenchArtifactVersionRecord_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "WorkbenchTask" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchArtifactVersionRecord_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "WorkbenchRunRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchArtifactVersionRecord_createdByCallId_fkey"
      FOREIGN KEY ("createdByCallId") REFERENCES "WorkbenchToolCallRecord" ("id")
      ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "WorkbenchVerificationRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "verifierVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "safeSummary" TEXT NOT NULL,
    "checksJson" TEXT NOT NULL,
    "evidenceRefsJson" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "containsIdentity" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkbenchVerificationRecord_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "WorkbenchTask" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchVerificationRecord_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "WorkbenchRunRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorkbenchSafeTaskObjective_taskId_key" ON "WorkbenchSafeTaskObjective"("taskId");
CREATE INDEX "WorkbenchSafeTaskObjective_objectiveHash_idx" ON "WorkbenchSafeTaskObjective"("objectiveHash");
CREATE INDEX "WorkbenchSafeTaskObjective_expiresAt_idx" ON "WorkbenchSafeTaskObjective"("expiresAt");

CREATE UNIQUE INDEX "WorkbenchPlanRevisionRecord_taskId_revision_key" ON "WorkbenchPlanRevisionRecord"("taskId", "revision");
CREATE INDEX "WorkbenchPlanRevisionRecord_runId_createdAt_idx" ON "WorkbenchPlanRevisionRecord"("runId", "createdAt");
CREATE INDEX "WorkbenchPlanRevisionRecord_objectiveHash_idx" ON "WorkbenchPlanRevisionRecord"("objectiveHash");

CREATE UNIQUE INDEX "WorkbenchPlanStepRecord_planRevisionId_ordinal_key" ON "WorkbenchPlanStepRecord"("planRevisionId", "ordinal");
CREATE INDEX "WorkbenchPlanStepRecord_planRevisionId_status_idx" ON "WorkbenchPlanStepRecord"("planRevisionId", "status");
CREATE INDEX "WorkbenchPlanStepRecord_toolName_toolVersion_idx" ON "WorkbenchPlanStepRecord"("toolName", "toolVersion");

CREATE UNIQUE INDEX "WorkbenchExecutionLease_runId_scopeKey_key" ON "WorkbenchExecutionLease"("runId", "scopeKey");
CREATE INDEX "WorkbenchExecutionLease_status_expiresAt_idx" ON "WorkbenchExecutionLease"("status", "expiresAt");
CREATE INDEX "WorkbenchExecutionLease_taskId_runId_idx" ON "WorkbenchExecutionLease"("taskId", "runId");
CREATE INDEX "WorkbenchExecutionLease_stepId_idx" ON "WorkbenchExecutionLease"("stepId");

CREATE UNIQUE INDEX "WorkbenchToolCallRecord_toolName_idempotencyKey_attempt_key" ON "WorkbenchToolCallRecord"("toolName", "idempotencyKey", "attempt");
CREATE INDEX "WorkbenchToolCallRecord_taskId_runId_createdAt_idx" ON "WorkbenchToolCallRecord"("taskId", "runId", "createdAt");
CREATE INDEX "WorkbenchToolCallRecord_stepId_status_idx" ON "WorkbenchToolCallRecord"("stepId", "status");
CREATE INDEX "WorkbenchToolCallRecord_executionLeaseId_leaseGeneration_idx" ON "WorkbenchToolCallRecord"("executionLeaseId", "leaseGeneration");
CREATE INDEX "WorkbenchToolCallRecord_parentCallId_idx" ON "WorkbenchToolCallRecord"("parentCallId");

CREATE UNIQUE INDEX "WorkbenchToolReceiptRecord_callId_key" ON "WorkbenchToolReceiptRecord"("callId");
CREATE INDEX "WorkbenchToolReceiptRecord_status_observedAt_idx" ON "WorkbenchToolReceiptRecord"("status", "observedAt");
CREATE INDEX "WorkbenchToolReceiptRecord_verificationId_idx" ON "WorkbenchToolReceiptRecord"("verificationId");

CREATE UNIQUE INDEX "WorkbenchArtifactVersionRecord_artifactId_version_key" ON "WorkbenchArtifactVersionRecord"("artifactId", "version");
CREATE INDEX "WorkbenchArtifactVersionRecord_taskId_artifactId_createdAt_idx" ON "WorkbenchArtifactVersionRecord"("taskId", "artifactId", "createdAt");
CREATE INDEX "WorkbenchArtifactVersionRecord_runId_createdAt_idx" ON "WorkbenchArtifactVersionRecord"("runId", "createdAt");
CREATE INDEX "WorkbenchArtifactVersionRecord_createdByCallId_idx" ON "WorkbenchArtifactVersionRecord"("createdByCallId");
CREATE INDEX "WorkbenchArtifactVersionRecord_contentHash_idx" ON "WorkbenchArtifactVersionRecord"("contentHash");

CREATE INDEX "WorkbenchVerificationRecord_taskId_subjectType_subjectId_idx" ON "WorkbenchVerificationRecord"("taskId", "subjectType", "subjectId");
CREATE INDEX "WorkbenchVerificationRecord_runId_status_observedAt_idx" ON "WorkbenchVerificationRecord"("runId", "status", "observedAt");
CREATE INDEX "WorkbenchVerificationRecord_expiresAt_idx" ON "WorkbenchVerificationRecord"("expiresAt");
