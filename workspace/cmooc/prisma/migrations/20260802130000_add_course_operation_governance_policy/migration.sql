CREATE TABLE "CourseOperationGovernancePolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseAlias" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "baseManifestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "dailySlotLimit" INTEGER NOT NULL,
    "perTickActionLimit" INTEGER NOT NULL,
    "authorTouchLimit30d" INTEGER NOT NULL,
    "minIntervalMinutes" INTEGER NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validUntil" DATETIME NOT NULL,
    "emergencyHalt" BOOLEAN NOT NULL DEFAULT false,
    "governanceHash" TEXT NOT NULL,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "CourseOperationGovernancePolicy_governanceHash_key"
ON "CourseOperationGovernancePolicy"("governanceHash");

CREATE UNIQUE INDEX "CourseOperationGovernancePolicy_courseAlias_version_key"
ON "CourseOperationGovernancePolicy"("courseAlias", "version");

CREATE INDEX "CourseOperationGovernancePolicy_courseAlias_status_validUntil_idx"
ON "CourseOperationGovernancePolicy"("courseAlias", "status", "validUntil");

CREATE INDEX "CourseOperationGovernancePolicy_courseAlias_baseManifestHash_idx"
ON "CourseOperationGovernancePolicy"("courseAlias", "baseManifestHash");

-- Governance rows are append-only policy events.  Protect the history at the
-- database boundary as well as in application code so no cleanup path can
-- rewrite or remove an issued policy after migration.
CREATE TRIGGER "CourseOperationGovernancePolicy_immutable_update"
BEFORE UPDATE ON "CourseOperationGovernancePolicy"
BEGIN
    SELECT RAISE(ABORT, 'CourseOperationGovernancePolicy is append-only: UPDATE is forbidden');
END;

CREATE TRIGGER "CourseOperationGovernancePolicy_immutable_delete"
BEFORE DELETE ON "CourseOperationGovernancePolicy"
BEGIN
    SELECT RAISE(ABORT, 'CourseOperationGovernancePolicy is append-only: DELETE is forbidden');
END;

ALTER TABLE "ScheduledInvocation" ADD COLUMN "governancePolicyId" TEXT;
ALTER TABLE "ScheduledInvocation" ADD COLUMN "governanceVersion" TEXT;
ALTER TABLE "ScheduledInvocation" ADD COLUMN "governanceHash" TEXT;
ALTER TABLE "ScheduledInvocation" ADD COLUMN "governanceLimitsJson" TEXT;

CREATE INDEX "ScheduledInvocation_governanceHash_idx"
ON "ScheduledInvocation"("governanceHash");

CREATE UNIQUE INDEX "ScheduledInvocation_scheduleId_scheduledFor_key"
ON "ScheduledInvocation"("scheduleId", "scheduledFor");

ALTER TABLE "AutonomyDecision" ADD COLUMN "governanceVersion" TEXT;
ALTER TABLE "AutonomyDecision" ADD COLUMN "governanceHash" TEXT;

CREATE INDEX "AutonomyDecision_courseAlias_governanceHash_idx"
ON "AutonomyDecision"("courseAlias", "governanceHash");

-- Governance is deliberately independent from the manifest table. The
-- immutable baseManifestHash is checked against the disk manifest at every
-- execution boundary, while this independent table permits an explicit
-- policy-first bootstrap without making syncManifestState an authorization
-- step. The nullable invocation fields preserve replay compatibility.
