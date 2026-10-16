CREATE TABLE "WorkbenchCourseToolActionRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "planRevisionId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolVersion" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "effectClass" TEXT NOT NULL,
    "courseScopeHash" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "idempotencyKeyHash" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "businessInputJson" TEXT NOT NULL,
    "safeSummary" TEXT NOT NULL,
    "bindingHash" TEXT NOT NULL,
    "approvalHash" TEXT NOT NULL,
    "grantRef" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "oneShot" BOOLEAN NOT NULL DEFAULT true,
    "realPublishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "statusReasonCode" TEXT NOT NULL,
    "terminalReceiptHash" TEXT,
    "reconciliationHash" TEXT,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "containsIdentity" BOOLEAN NOT NULL DEFAULT false,
    "containsSecrets" BOOLEAN NOT NULL DEFAULT false,
    "preparedAt" DATETIME NOT NULL,
    "approvalRequestedAt" DATETIME,
    "approvedAt" DATETIME,
    "executionStartedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkbenchCourseToolActionRecord_taskId_fkey"
      FOREIGN KEY ("taskId") REFERENCES "WorkbenchTask" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchCourseToolActionRecord_runId_fkey"
      FOREIGN KEY ("runId") REFERENCES "WorkbenchRunRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchCourseToolActionRecord_planRevisionId_fkey"
      FOREIGN KEY ("planRevisionId") REFERENCES "WorkbenchPlanRevisionRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchCourseToolActionRecord_stepId_fkey"
      FOREIGN KEY ("stepId") REFERENCES "WorkbenchPlanStepRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchCourseToolActionRecord_stage_capability_check"
      CHECK ("capability" = 'L3_EXTERNAL_STAGE'),
    CONSTRAINT "WorkbenchCourseToolActionRecord_stage_effect_check"
      CHECK ("effectClass" = 'external_stage'),
    CONSTRAINT "WorkbenchCourseToolActionRecord_no_publish_check"
      CHECK ("realPublishEnabled" = false),
    CONSTRAINT "WorkbenchCourseToolActionRecord_one_shot_check"
      CHECK ("oneShot" = true),
    CONSTRAINT "WorkbenchCourseToolActionRecord_safety_flags_check"
      CHECK (
        "containsForumText" = false AND
        "containsIdentity" = false AND
        "containsSecrets" = false
      ),
    CONSTRAINT "WorkbenchCourseToolActionRecord_attempt_check"
      CHECK ("attempt" >= 1),
    CONSTRAINT "WorkbenchCourseToolActionRecord_window_check"
      CHECK ("validFrom" < "expiresAt"),
    CONSTRAINT "WorkbenchCourseToolActionRecord_status_check"
      CHECK ("status" IN (
        'prepared',
        'awaiting_approval',
        'approved',
        'executing',
        'succeeded',
        'failed_before_write',
        'unknown',
        'reconciling',
        'reconciled',
        'manual_review'
      )),
    CONSTRAINT "WorkbenchCourseToolActionRecord_hash_length_check"
      CHECK (
        length("courseScopeHash") = 64 AND
        length("inputHash") = 64 AND
        length("idempotencyKeyHash") = 64 AND
        length("bindingHash") = 64 AND
        length("approvalHash") = 64 AND
        ("terminalReceiptHash" IS NULL OR length("terminalReceiptHash") = 64) AND
        ("reconciliationHash" IS NULL OR length("reconciliationHash") = 64)
      ),
    CONSTRAINT "WorkbenchCourseToolActionRecord_hash_charset_check"
      CHECK (
        "courseScopeHash" NOT GLOB '*[^a-f0-9]*' AND
        "inputHash" NOT GLOB '*[^a-f0-9]*' AND
        "idempotencyKeyHash" NOT GLOB '*[^a-f0-9]*' AND
        "bindingHash" NOT GLOB '*[^a-f0-9]*' AND
        "approvalHash" NOT GLOB '*[^a-f0-9]*' AND
        ("terminalReceiptHash" IS NULL OR "terminalReceiptHash" NOT GLOB '*[^a-f0-9]*') AND
        ("reconciliationHash" IS NULL OR "reconciliationHash" NOT GLOB '*[^a-f0-9]*')
      )
);

CREATE TABLE "WorkbenchCourseToolGrantRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "schemaVersion" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "effectClass" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "toolVersion" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "planRevisionId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "courseScopeHash" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "idempotencyKeyHash" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "bindingHash" TEXT NOT NULL,
    "approvalHash" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "oneShot" BOOLEAN NOT NULL DEFAULT true,
    "realPublishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "consumedAt" DATETIME,
    "expiredAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkbenchCourseToolGrantRecord_actionId_fkey"
      FOREIGN KEY ("actionId") REFERENCES "WorkbenchCourseToolActionRecord" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorkbenchCourseToolGrantRecord_stage_capability_check"
      CHECK ("capability" = 'L3_EXTERNAL_STAGE'),
    CONSTRAINT "WorkbenchCourseToolGrantRecord_stage_effect_check"
      CHECK ("effectClass" = 'external_stage'),
    CONSTRAINT "WorkbenchCourseToolGrantRecord_no_publish_check"
      CHECK ("realPublishEnabled" = false),
    CONSTRAINT "WorkbenchCourseToolGrantRecord_one_shot_check"
      CHECK ("oneShot" = true),
    CONSTRAINT "WorkbenchCourseToolGrantRecord_attempt_check"
      CHECK ("attempt" >= 1),
    CONSTRAINT "WorkbenchCourseToolGrantRecord_window_check"
      CHECK ("validFrom" < "expiresAt"),
    CONSTRAINT "WorkbenchCourseToolGrantRecord_status_check"
      CHECK ("status" IN ('available', 'consumed', 'expired', 'revoked')),
    CONSTRAINT "WorkbenchCourseToolGrantRecord_terminal_time_check"
      CHECK (
        ("status" = 'available' AND "consumedAt" IS NULL AND "expiredAt" IS NULL AND "revokedAt" IS NULL) OR
        ("status" = 'consumed' AND "consumedAt" IS NOT NULL AND "expiredAt" IS NULL AND "revokedAt" IS NULL) OR
        ("status" = 'expired' AND "consumedAt" IS NULL AND "expiredAt" IS NOT NULL AND "revokedAt" IS NULL) OR
        ("status" = 'revoked' AND "consumedAt" IS NULL AND "expiredAt" IS NULL AND "revokedAt" IS NOT NULL)
      ),
    CONSTRAINT "WorkbenchCourseToolGrantRecord_hash_length_check"
      CHECK (
        length("courseScopeHash") = 64 AND
        length("inputHash") = 64 AND
        length("idempotencyKeyHash") = 64 AND
        length("bindingHash") = 64 AND
        length("approvalHash") = 64
      ),
    CONSTRAINT "WorkbenchCourseToolGrantRecord_hash_charset_check"
      CHECK (
        "courseScopeHash" NOT GLOB '*[^a-f0-9]*' AND
        "inputHash" NOT GLOB '*[^a-f0-9]*' AND
        "idempotencyKeyHash" NOT GLOB '*[^a-f0-9]*' AND
        "bindingHash" NOT GLOB '*[^a-f0-9]*' AND
        "approvalHash" NOT GLOB '*[^a-f0-9]*'
      )
);

CREATE UNIQUE INDEX "WorkbenchCourseToolActionRecord_callId_key"
  ON "WorkbenchCourseToolActionRecord"("callId");
CREATE UNIQUE INDEX "WorkbenchCourseToolActionRecord_bindingHash_key"
  ON "WorkbenchCourseToolActionRecord"("bindingHash");
CREATE UNIQUE INDEX "WorkbenchCourseToolActionRecord_approvalHash_key"
  ON "WorkbenchCourseToolActionRecord"("approvalHash");
CREATE UNIQUE INDEX "WorkbenchCourseToolActionRecord_grantRef_key"
  ON "WorkbenchCourseToolActionRecord"("grantRef");
CREATE INDEX "WorkbenchCourseToolActionRecord_taskId_runId_status_idx"
  ON "WorkbenchCourseToolActionRecord"("taskId", "runId", "status");
CREATE INDEX "WorkbenchCourseToolActionRecord_planRevisionId_stepId_idx"
  ON "WorkbenchCourseToolActionRecord"("planRevisionId", "stepId");
CREATE INDEX "WorkbenchCourseToolActionRecord_status_expiresAt_idx"
  ON "WorkbenchCourseToolActionRecord"("status", "expiresAt");
CREATE INDEX "WorkbenchCourseToolActionRecord_toolName_toolVersion_idx"
  ON "WorkbenchCourseToolActionRecord"("toolName", "toolVersion");

CREATE UNIQUE INDEX "WorkbenchCourseToolGrantRecord_actionId_key"
  ON "WorkbenchCourseToolGrantRecord"("actionId");
CREATE UNIQUE INDEX "WorkbenchCourseToolGrantRecord_callId_key"
  ON "WorkbenchCourseToolGrantRecord"("callId");
CREATE UNIQUE INDEX "WorkbenchCourseToolGrantRecord_bindingHash_key"
  ON "WorkbenchCourseToolGrantRecord"("bindingHash");
CREATE UNIQUE INDEX "WorkbenchCourseToolGrantRecord_approvalHash_key"
  ON "WorkbenchCourseToolGrantRecord"("approvalHash");
CREATE INDEX "WorkbenchCourseToolGrantRecord_status_expiresAt_idx"
  ON "WorkbenchCourseToolGrantRecord"("status", "expiresAt");
CREATE INDEX "WorkbenchCourseToolGrantRecord_taskId_runId_idx"
  ON "WorkbenchCourseToolGrantRecord"("taskId", "runId");
CREATE INDEX "WorkbenchCourseToolGrantRecord_planRevisionId_stepId_idx"
  ON "WorkbenchCourseToolGrantRecord"("planRevisionId", "stepId");
CREATE INDEX "WorkbenchCourseToolGrantRecord_toolName_toolVersion_idx"
  ON "WorkbenchCourseToolGrantRecord"("toolName", "toolVersion");
