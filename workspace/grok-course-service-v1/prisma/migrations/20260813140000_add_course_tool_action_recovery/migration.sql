ALTER TABLE "WorkbenchCourseToolActionRecord"
  ADD COLUMN "compensationRef" TEXT;

ALTER TABLE "WorkbenchCourseToolActionRecord"
  ADD COLUMN "parentActionId" TEXT
  REFERENCES "WorkbenchCourseToolActionRecord"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkbenchCourseToolActionRecord"
  ADD COLUMN "recoveryOfActionId" TEXT
  REFERENCES "WorkbenchCourseToolActionRecord"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "WorkbenchCourseToolActionRecord_parentActionId_idx"
  ON "WorkbenchCourseToolActionRecord"("parentActionId");

CREATE INDEX "WorkbenchCourseToolActionRecord_recoveryOfActionId_status_idx"
  ON "WorkbenchCourseToolActionRecord"("recoveryOfActionId", "status");

-- The existing table predates recovery actions. These triggers tighten both
-- INSERT and UPDATE without rebuilding a populated, foreign-keyed ledger.
CREATE TRIGGER "WorkbenchCourseToolActionRecord_recovery_insert_check"
BEFORE INSERT ON "WorkbenchCourseToolActionRecord"
BEGIN
  SELECT CASE
    WHEN NEW."toolName" NOT IN (
      'platform.editor.stage_verify_clear',
      'platform.editor.reconcile_stage'
    ) THEN RAISE(ABORT, 'course tool action must be STAGE or reconcile')
    WHEN NEW."toolVersion" <> '1'
      THEN RAISE(ABORT, 'course tool action version must be 1')
    WHEN NEW."toolName" = 'platform.editor.stage_verify_clear'
      AND (NEW."parentActionId" IS NOT NULL OR NEW."recoveryOfActionId" IS NOT NULL)
      THEN RAISE(ABORT, 'STAGE action cannot claim recovery lineage')
    WHEN NEW."toolName" = 'platform.editor.reconcile_stage'
      AND (
        NEW."parentActionId" IS NULL OR
        NEW."recoveryOfActionId" IS NULL OR
        NEW."parentActionId" <> NEW."recoveryOfActionId"
      ) THEN RAISE(ABORT, 'reconcile action requires exact parent/recovery lineage')
    WHEN NEW."compensationRef" IS NOT NULL
      AND (
        length(NEW."compensationRef") < 1 OR
        length(NEW."compensationRef") > 192 OR
        NEW."compensationRef" GLOB '*[^A-Za-z0-9._:-]*'
      ) THEN RAISE(ABORT, 'invalid compensation reference')
  END;
END;

CREATE TRIGGER "WorkbenchCourseToolActionRecord_recovery_update_check"
BEFORE UPDATE ON "WorkbenchCourseToolActionRecord"
BEGIN
  SELECT CASE
    WHEN NEW."toolName" NOT IN (
      'platform.editor.stage_verify_clear',
      'platform.editor.reconcile_stage'
    ) THEN RAISE(ABORT, 'course tool action must be STAGE or reconcile')
    WHEN NEW."toolVersion" <> '1'
      THEN RAISE(ABORT, 'course tool action version must be 1')
    WHEN NEW."toolName" = 'platform.editor.stage_verify_clear'
      AND (NEW."parentActionId" IS NOT NULL OR NEW."recoveryOfActionId" IS NOT NULL)
      THEN RAISE(ABORT, 'STAGE action cannot claim recovery lineage')
    WHEN NEW."toolName" = 'platform.editor.reconcile_stage'
      AND (
        NEW."parentActionId" IS NULL OR
        NEW."recoveryOfActionId" IS NULL OR
        NEW."parentActionId" <> NEW."recoveryOfActionId"
      ) THEN RAISE(ABORT, 'reconcile action requires exact parent/recovery lineage')
    WHEN NEW."compensationRef" IS NOT NULL
      AND (
        length(NEW."compensationRef") < 1 OR
        length(NEW."compensationRef") > 192 OR
        NEW."compensationRef" GLOB '*[^A-Za-z0-9._:-]*'
      ) THEN RAISE(ABORT, 'invalid compensation reference')
  END;
END;

CREATE TRIGGER "WorkbenchCourseToolGrantRecord_recovery_insert_check"
BEFORE INSERT ON "WorkbenchCourseToolGrantRecord"
BEGIN
  SELECT CASE
    WHEN NEW."toolName" NOT IN (
      'platform.editor.stage_verify_clear',
      'platform.editor.reconcile_stage'
    ) THEN RAISE(ABORT, 'course tool grant must be STAGE or reconcile')
    WHEN NEW."toolVersion" <> '1'
      THEN RAISE(ABORT, 'course tool grant version must be 1')
  END;
END;
