-- Preserve immutable v2 terminal history while making every newly inserted
-- STAGE transaction prove a fresh, body-free target resolution. SQLite cannot
-- alter the existing schema CHECK in place, so rebuild this one ledger table.
PRAGMA foreign_keys=OFF;
PRAGMA defer_foreign_keys=ON;
BEGIN IMMEDIATE;

CREATE TABLE "new_WorkbenchStageTransactionRecord" (
  "stageTransactionRef" TEXT NOT NULL PRIMARY KEY,
  "schemaVersion" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "planRevisionId" TEXT NOT NULL,
  "stepId" TEXT NOT NULL,
  "callId" TEXT NOT NULL,
  "courseAlias" TEXT NOT NULL,
  "courseScopeHash" TEXT NOT NULL,
  "manifestHash" TEXT NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "integrityVerificationRef" TEXT NOT NULL,
  "targetRef" TEXT NOT NULL,
  "opportunityId" TEXT NOT NULL,
  "candidateKey" TEXT NOT NULL,
  "decisionId" TEXT NOT NULL,
  "threadKey" TEXT NOT NULL,
  "targetVersionHash" TEXT NOT NULL,
  "opportunityReceiptHash" TEXT NOT NULL,
  "revalidationReceiptHash" TEXT NOT NULL,
  "afterObservationReceiptHash" TEXT NOT NULL,
  "targetEvidenceRefsJson" TEXT NOT NULL,
  "artifactVersionRef" TEXT NOT NULL,
  "draftBodyHash" TEXT NOT NULL,
  "runNonceHash" TEXT NOT NULL,
  "baselineRef" TEXT NOT NULL,
  "baselineHash" TEXT NOT NULL,
  "pageBindingRef" TEXT NOT NULL,
  "pageBindingHash" TEXT NOT NULL,
  "preflightRef" TEXT,
  "preflightHash" TEXT,
  "resolvedTargetReceiptRef" TEXT,
  "resolvedTargetReceiptHash" TEXT,
  "freshObservationRef" TEXT,
  "freshObservationHash" TEXT,
  "eventSetHash" TEXT,
  "targetLocatorHash" TEXT,
  "resolvedAt" DATETIME,
  "status" TEXT NOT NULL,
  "verifiedOutputJson" TEXT,
  "terminalBindingJson" TEXT,
  "containsForumText" BOOLEAN NOT NULL DEFAULT false,
  "containsIdentity" BOOLEAN NOT NULL DEFAULT false,
  "containsSecrets" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL,
  "updatedAt" DATETIME NOT NULL,
  "terminalAt" DATETIME,
  CONSTRAINT "WorkbenchStageTransactionRecord_taskId_fkey"
    FOREIGN KEY ("taskId") REFERENCES "WorkbenchTask" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkbenchStageTransactionRecord_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "WorkbenchRunRecord" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkbenchStageTransactionRecord_planRevisionId_fkey"
    FOREIGN KEY ("planRevisionId") REFERENCES "WorkbenchPlanRevisionRecord" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkbenchStageTransactionRecord_stepId_fkey"
    FOREIGN KEY ("stepId") REFERENCES "WorkbenchPlanStepRecord" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkbenchStageTransactionRecord_callId_fkey"
    FOREIGN KEY ("callId") REFERENCES "WorkbenchToolCallRecord" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "WorkbenchStageTransactionRecord_schema_check"
    CHECK (
      "schemaVersion" IN (
        'cmooc.workbench-stage-transaction.v2',
        'cmooc.workbench-stage-transaction.v3'
      )
    ),
  CONSTRAINT "WorkbenchStageTransactionRecord_v3_binding_check"
    CHECK (
      (
        "schemaVersion" = 'cmooc.workbench-stage-transaction.v2' AND
        "preflightRef" IS NULL AND "preflightHash" IS NULL AND
        "resolvedTargetReceiptRef" IS NULL AND "resolvedTargetReceiptHash" IS NULL AND
        "freshObservationRef" IS NULL AND "freshObservationHash" IS NULL AND
        "eventSetHash" IS NULL AND "targetLocatorHash" IS NULL AND
        "resolvedAt" IS NULL AND "terminalBindingJson" IS NULL
      ) OR (
        "schemaVersion" = 'cmooc.workbench-stage-transaction.v3' AND
        "preflightRef" IS NOT NULL AND "preflightHash" IS NOT NULL AND
        "resolvedTargetReceiptRef" IS NOT NULL AND "resolvedTargetReceiptHash" IS NOT NULL AND
        "freshObservationRef" IS NOT NULL AND "freshObservationHash" IS NOT NULL AND
        "eventSetHash" IS NOT NULL AND "targetLocatorHash" IS NOT NULL AND
        "resolvedAt" IS NOT NULL AND
        "freshObservationHash" <> "afterObservationReceiptHash" AND
        "resolvedAt" <= "createdAt"
      )
    ),
  CONSTRAINT "WorkbenchStageTransactionRecord_status_check"
    CHECK ("status" IN ('pending', 'unknown', 'verified', 'reconciled')),
  CONSTRAINT "WorkbenchStageTransactionRecord_privacy_check"
    CHECK (
      "containsForumText" = false AND
      "containsIdentity" = false AND
      "containsSecrets" = false
    ),
  CONSTRAINT "WorkbenchStageTransactionRecord_terminal_check"
    CHECK (
      ("status" IN ('pending', 'unknown') AND "verifiedOutputJson" IS NULL AND "terminalBindingJson" IS NULL AND "terminalAt" IS NULL) OR
      (
        "schemaVersion" = 'cmooc.workbench-stage-transaction.v2' AND
        "status" IN ('verified', 'reconciled') AND "verifiedOutputJson" IS NOT NULL AND
        "terminalBindingJson" IS NULL AND "terminalAt" = "updatedAt"
      ) OR (
        "schemaVersion" = 'cmooc.workbench-stage-transaction.v3' AND
        "status" = 'verified' AND "verifiedOutputJson" IS NOT NULL AND
        "terminalBindingJson" IS NOT NULL AND
        json_extract("terminalBindingJson", '$.kind') = 'stage' AND
        "terminalAt" = "updatedAt"
      ) OR (
        "schemaVersion" = 'cmooc.workbench-stage-transaction.v3' AND
        "status" = 'reconciled' AND "verifiedOutputJson" IS NOT NULL AND
        "terminalBindingJson" IS NOT NULL AND
        json_extract("terminalBindingJson", '$.kind') = 'reconcile' AND
        "terminalAt" = "updatedAt"
      )
    ),
  CONSTRAINT "WorkbenchStageTransactionRecord_json_check"
    CHECK (
      json_valid("targetEvidenceRefsJson") AND
      ("verifiedOutputJson" IS NULL OR json_valid("verifiedOutputJson")) AND
      ("terminalBindingJson" IS NULL OR (
        json_valid("terminalBindingJson") AND
        json_extract("terminalBindingJson", '$.schemaVersion') = 'cmooc.workbench-stage-transaction-terminal-binding.v3' AND
        json_extract("terminalBindingJson", '$.kind') IN ('stage', 'reconcile') AND
        json_extract("terminalBindingJson", '$.containsForumText') = false AND
        json_extract("terminalBindingJson", '$.containsIdentity') = false AND
        json_extract("terminalBindingJson", '$.containsSecrets') = false
      ))
    ),
  CONSTRAINT "WorkbenchStageTransactionRecord_hash_check"
    CHECK (
      length("targetVersionHash") = 64 AND "targetVersionHash" NOT GLOB '*[^a-f0-9]*' AND
      length("courseScopeHash") = 64 AND "courseScopeHash" NOT GLOB '*[^a-f0-9]*' AND
      length("manifestHash") = 64 AND "manifestHash" NOT GLOB '*[^a-f0-9]*' AND
      length("opportunityReceiptHash") = 64 AND "opportunityReceiptHash" NOT GLOB '*[^a-f0-9]*' AND
      length("revalidationReceiptHash") = 64 AND "revalidationReceiptHash" NOT GLOB '*[^a-f0-9]*' AND
      length("afterObservationReceiptHash") = 64 AND "afterObservationReceiptHash" NOT GLOB '*[^a-f0-9]*' AND
      length("draftBodyHash") = 64 AND "draftBodyHash" NOT GLOB '*[^a-f0-9]*' AND
      length("runNonceHash") = 64 AND "runNonceHash" NOT GLOB '*[^a-f0-9]*' AND
      length("baselineHash") = 64 AND "baselineHash" NOT GLOB '*[^a-f0-9]*' AND
      length("pageBindingHash") = 64 AND "pageBindingHash" NOT GLOB '*[^a-f0-9]*' AND
      ("preflightHash" IS NULL OR (length("preflightHash") = 64 AND "preflightHash" NOT GLOB '*[^a-f0-9]*')) AND
      ("resolvedTargetReceiptHash" IS NULL OR (length("resolvedTargetReceiptHash") = 64 AND "resolvedTargetReceiptHash" NOT GLOB '*[^a-f0-9]*')) AND
      ("freshObservationHash" IS NULL OR (length("freshObservationHash") = 64 AND "freshObservationHash" NOT GLOB '*[^a-f0-9]*')) AND
      ("eventSetHash" IS NULL OR (length("eventSetHash") = 64 AND "eventSetHash" NOT GLOB '*[^a-f0-9]*')) AND
      ("targetLocatorHash" IS NULL OR (length("targetLocatorHash") = 64 AND "targetLocatorHash" NOT GLOB '*[^a-f0-9]*'))
    ),
  CONSTRAINT "WorkbenchStageTransactionRecord_ref_check"
    CHECK (
      length("stageTransactionRef") BETWEEN 1 AND 192 AND "stageTransactionRef" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("taskId") BETWEEN 1 AND 192 AND "taskId" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("runId") BETWEEN 1 AND 192 AND "runId" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("planRevisionId") BETWEEN 1 AND 192 AND "planRevisionId" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("stepId") BETWEEN 1 AND 192 AND "stepId" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("callId") BETWEEN 1 AND 192 AND "callId" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("courseAlias") BETWEEN 1 AND 192 AND "courseAlias" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("policyVersion") BETWEEN 1 AND 192 AND "policyVersion" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("integrityVerificationRef") BETWEEN 1 AND 192 AND "integrityVerificationRef" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("targetRef") BETWEEN 1 AND 192 AND "targetRef" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("opportunityId") BETWEEN 1 AND 192 AND "opportunityId" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("candidateKey") BETWEEN 1 AND 192 AND "candidateKey" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("decisionId") BETWEEN 1 AND 192 AND "decisionId" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("threadKey") BETWEEN 1 AND 192 AND "threadKey" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("artifactVersionRef") BETWEEN 1 AND 192 AND "artifactVersionRef" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("baselineRef") BETWEEN 1 AND 192 AND "baselineRef" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      length("pageBindingRef") BETWEEN 1 AND 192 AND "pageBindingRef" NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      ("preflightRef" IS NULL OR (length("preflightRef") BETWEEN 1 AND 192 AND "preflightRef" NOT GLOB '*[^A-Za-z0-9._:-]*')) AND
      ("resolvedTargetReceiptRef" IS NULL OR (length("resolvedTargetReceiptRef") BETWEEN 1 AND 192 AND "resolvedTargetReceiptRef" NOT GLOB '*[^A-Za-z0-9._:-]*')) AND
      ("freshObservationRef" IS NULL OR (length("freshObservationRef") BETWEEN 1 AND 192 AND "freshObservationRef" NOT GLOB '*[^A-Za-z0-9._:-]*'))
    )
);

INSERT INTO "new_WorkbenchStageTransactionRecord" (
  "stageTransactionRef", "schemaVersion", "taskId", "runId",
  "planRevisionId", "stepId", "callId", "courseAlias", "courseScopeHash",
  "manifestHash", "policyVersion", "integrityVerificationRef", "targetRef",
  "opportunityId", "candidateKey", "decisionId", "threadKey",
  "targetVersionHash", "opportunityReceiptHash", "revalidationReceiptHash",
  "afterObservationReceiptHash", "targetEvidenceRefsJson",
  "artifactVersionRef", "draftBodyHash", "runNonceHash", "baselineRef",
  "baselineHash", "pageBindingRef", "pageBindingHash", "preflightRef",
  "preflightHash", "resolvedTargetReceiptRef", "resolvedTargetReceiptHash",
  "freshObservationRef", "freshObservationHash", "eventSetHash",
  "targetLocatorHash", "resolvedAt", "status", "verifiedOutputJson", "terminalBindingJson",
  "containsForumText", "containsIdentity", "containsSecrets", "createdAt",
  "updatedAt", "terminalAt"
)
SELECT
  "stageTransactionRef", "schemaVersion", "taskId", "runId",
  "planRevisionId", "stepId", "callId", "courseAlias", "courseScopeHash",
  "manifestHash", "policyVersion", "integrityVerificationRef", "targetRef",
  "opportunityId", "candidateKey", "decisionId", "threadKey",
  "targetVersionHash", "opportunityReceiptHash", "revalidationReceiptHash",
  "afterObservationReceiptHash", "targetEvidenceRefsJson",
  "artifactVersionRef", "draftBodyHash", "runNonceHash", "baselineRef",
  "baselineHash", "pageBindingRef", "pageBindingHash", NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, "status", "verifiedOutputJson", NULL,
  "containsForumText", "containsIdentity", "containsSecrets", "createdAt",
  "updatedAt", "terminalAt"
FROM "WorkbenchStageTransactionRecord";

DROP TABLE "WorkbenchStageTransactionRecord";
ALTER TABLE "new_WorkbenchStageTransactionRecord" RENAME TO "WorkbenchStageTransactionRecord";

CREATE UNIQUE INDEX "WorkbenchStageTransactionRecord_callId_key"
  ON "WorkbenchStageTransactionRecord"("callId");
CREATE INDEX "WorkbenchStageTransactionRecord_taskId_runId_status_idx"
  ON "WorkbenchStageTransactionRecord"("taskId", "runId", "status");
CREATE INDEX "WorkbenchStageTransactionRecord_planRevisionId_stepId_idx"
  ON "WorkbenchStageTransactionRecord"("planRevisionId", "stepId");
CREATE INDEX "WorkbenchStageTransactionRecord_courseAlias_manifestHash_idx"
  ON "WorkbenchStageTransactionRecord"("courseAlias", "manifestHash");
CREATE INDEX "WorkbenchStageTransactionRecord_status_updatedAt_idx"
  ON "WorkbenchStageTransactionRecord"("status", "updatedAt");
CREATE INDEX "WorkbenchStageTransactionRecord_artifactVersionRef_idx"
  ON "WorkbenchStageTransactionRecord"("artifactVersionRef");

CREATE TRIGGER "WorkbenchStageTransactionRecord_insert_check"
BEFORE INSERT ON "WorkbenchStageTransactionRecord"
BEGIN
  SELECT CASE
    WHEN NEW."schemaVersion" <> 'cmooc.workbench-stage-transaction.v3'
      THEN RAISE(ABORT, 'new stage transaction must use v3')
    WHEN NEW."status" <> 'pending'
      OR NEW."verifiedOutputJson" IS NOT NULL
      OR NEW."terminalAt" IS NOT NULL
      THEN RAISE(ABORT, 'stage transaction must begin pending')
    WHEN NEW."createdAt" <> NEW."updatedAt"
      THEN RAISE(ABORT, 'stage transaction initial timestamps must match')
    WHEN NOT EXISTS (
      SELECT 1 FROM "WorkbenchRunRecord"
      WHERE "id" = NEW."runId" AND "taskId" = NEW."taskId"
    ) THEN RAISE(ABORT, 'stage transaction task/run scope mismatch')
    WHEN NOT EXISTS (
      SELECT 1 FROM "WorkbenchPlanRevisionRecord"
      WHERE "id" = NEW."planRevisionId"
        AND "taskId" = NEW."taskId"
        AND "runId" = NEW."runId"
    ) THEN RAISE(ABORT, 'stage transaction plan scope mismatch')
    WHEN NOT EXISTS (
      SELECT 1 FROM "WorkbenchPlanStepRecord"
      WHERE "id" = NEW."stepId"
        AND "planRevisionId" = NEW."planRevisionId"
        AND "toolName" = 'platform.editor.stage_verify_clear'
        AND "toolVersion" = '1'
    ) THEN RAISE(ABORT, 'stage transaction step scope mismatch')
    WHEN NOT EXISTS (
      SELECT 1 FROM "WorkbenchToolCallRecord"
      WHERE "id" = NEW."callId"
        AND "taskId" = NEW."taskId"
        AND "runId" = NEW."runId"
        AND "stepId" = NEW."stepId"
        AND "toolName" = 'platform.editor.stage_verify_clear'
        AND "toolVersion" = '1'
    ) THEN RAISE(ABORT, 'stage transaction call scope mismatch')
  END;
END;

CREATE TRIGGER "WorkbenchStageTransactionRecord_update_check"
BEFORE UPDATE ON "WorkbenchStageTransactionRecord"
BEGIN
  SELECT CASE
    WHEN OLD."schemaVersion" <> NEW."schemaVersion"
      OR OLD."stageTransactionRef" <> NEW."stageTransactionRef"
      OR OLD."taskId" <> NEW."taskId"
      OR OLD."runId" <> NEW."runId"
      OR OLD."planRevisionId" <> NEW."planRevisionId"
      OR OLD."stepId" <> NEW."stepId"
      OR OLD."callId" <> NEW."callId"
      OR OLD."courseAlias" <> NEW."courseAlias"
      OR OLD."courseScopeHash" <> NEW."courseScopeHash"
      OR OLD."manifestHash" <> NEW."manifestHash"
      OR OLD."policyVersion" <> NEW."policyVersion"
      OR OLD."integrityVerificationRef" <> NEW."integrityVerificationRef"
      OR OLD."targetRef" <> NEW."targetRef"
      OR OLD."opportunityId" <> NEW."opportunityId"
      OR OLD."candidateKey" <> NEW."candidateKey"
      OR OLD."decisionId" <> NEW."decisionId"
      OR OLD."threadKey" <> NEW."threadKey"
      OR OLD."targetVersionHash" <> NEW."targetVersionHash"
      OR OLD."opportunityReceiptHash" <> NEW."opportunityReceiptHash"
      OR OLD."revalidationReceiptHash" <> NEW."revalidationReceiptHash"
      OR OLD."afterObservationReceiptHash" <> NEW."afterObservationReceiptHash"
      OR OLD."targetEvidenceRefsJson" <> NEW."targetEvidenceRefsJson"
      OR OLD."artifactVersionRef" <> NEW."artifactVersionRef"
      OR OLD."draftBodyHash" <> NEW."draftBodyHash"
      OR OLD."runNonceHash" <> NEW."runNonceHash"
      OR OLD."baselineRef" <> NEW."baselineRef"
      OR OLD."baselineHash" <> NEW."baselineHash"
      OR OLD."pageBindingRef" <> NEW."pageBindingRef"
      OR OLD."pageBindingHash" <> NEW."pageBindingHash"
      OR OLD."preflightRef" IS NOT NEW."preflightRef"
      OR OLD."preflightHash" IS NOT NEW."preflightHash"
      OR OLD."resolvedTargetReceiptRef" IS NOT NEW."resolvedTargetReceiptRef"
      OR OLD."resolvedTargetReceiptHash" IS NOT NEW."resolvedTargetReceiptHash"
      OR OLD."freshObservationRef" IS NOT NEW."freshObservationRef"
      OR OLD."freshObservationHash" IS NOT NEW."freshObservationHash"
      OR OLD."eventSetHash" IS NOT NEW."eventSetHash"
      OR OLD."targetLocatorHash" IS NOT NEW."targetLocatorHash"
      OR OLD."resolvedAt" IS NOT NEW."resolvedAt"
      OR OLD."containsForumText" <> NEW."containsForumText"
      OR OLD."containsIdentity" <> NEW."containsIdentity"
      OR OLD."containsSecrets" <> NEW."containsSecrets"
      OR OLD."createdAt" <> NEW."createdAt"
      THEN RAISE(ABORT, 'stage transaction binding is immutable')
    WHEN OLD."schemaVersion" = 'cmooc.workbench-stage-transaction.v2'
      THEN RAISE(ABORT, 'legacy v2 stage transaction is read only')
    WHEN OLD."status" IN ('verified', 'reconciled')
      THEN RAISE(ABORT, 'stage transaction terminal is immutable')
    WHEN NEW."updatedAt" < OLD."updatedAt"
      THEN RAISE(ABORT, 'stage transaction time cannot regress')
    WHEN OLD."status" = 'pending'
      AND NEW."status" NOT IN ('unknown', 'verified', 'reconciled')
      THEN RAISE(ABORT, 'invalid pending stage transaction transition')
    WHEN OLD."status" = 'unknown'
      AND NEW."status" NOT IN ('unknown', 'verified', 'reconciled')
      THEN RAISE(ABORT, 'invalid unknown stage transaction transition')
  END;
END;

COMMIT;
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
