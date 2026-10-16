CREATE TABLE "AutonomyCourseManifest" (
    "alias" TEXT NOT NULL PRIMARY KEY,
    "manifestHash" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "platformCourseRefHash" TEXT NOT NULL,
    "canonicalLocatorHash" TEXT NOT NULL,
    "identityKeyFingerprint" TEXT NOT NULL,
    "allowedOrigin" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "defaultMode" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "realPublishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "OperationSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseAlias" TEXT NOT NULL,
    "scheduleKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "intervalMinutes" INTEGER NOT NULL,
    "timeZone" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" DATETIME,
    "budgetJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OperationSchedule_courseAlias_fkey" FOREIGN KEY ("courseAlias") REFERENCES "AutonomyCourseManifest" ("alias") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "AutonomyPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseAlias" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "allowedActionsJson" TEXT NOT NULL,
    "budgetJson" TEXT NOT NULL,
    "policyHash" TEXT NOT NULL,
    "validFrom" DATETIME NOT NULL,
    "validUntil" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "emergencyHalt" BOOLEAN NOT NULL DEFAULT false,
    "realPublishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutonomyPolicy_courseAlias_fkey" FOREIGN KEY ("courseAlias") REFERENCES "AutonomyCourseManifest" ("alias") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ScheduledInvocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invocationKey" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "scheduleId" TEXT,
    "manifestHash" TEXT NOT NULL,
    "scheduledFor" DATETIME NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "leaseOwner" TEXT,
    "leaseExpiresAt" DATETIME,
    "heartbeatAt" DATETIME,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "recoveredFromId" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "summaryJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScheduledInvocation_courseAlias_fkey" FOREIGN KEY ("courseAlias") REFERENCES "AutonomyCourseManifest" ("alias") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ScheduledInvocation_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "OperationSchedule" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CourseScanRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invocationId" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "scanKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "cursorJson" TEXT NOT NULL,
    "coverageJson" TEXT NOT NULL,
    "coverageHash" TEXT,
    "sourceReceiptHash" TEXT,
    "observedEventCount" INTEGER NOT NULL DEFAULT 0,
    "newEventCount" INTEGER NOT NULL DEFAULT 0,
    "failedTargetCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CourseScanRun_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CourseEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseAlias" TEXT NOT NULL,
    "scanRunId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "actorKey" TEXT,
    "parentEventKey" TEXT,
    "kind" TEXT NOT NULL,
    "actorRelation" TEXT NOT NULL,
    "relationBasis" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "occurredAt" DATETIME NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceVersionHash" TEXT NOT NULL,
    "targetVersionHash" TEXT NOT NULL,
    "legalityStatus" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseEvent_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "CourseScanRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CourseEventObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanRunId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceVersionHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseEventObservation_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "CourseScanRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CourseEventObservation_eventKey_fkey" FOREIGN KEY ("eventKey") REFERENCES "CourseEvent" ("eventKey") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "AutonomyObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invocationId" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "receiptHash" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "receiptJson" TEXT NOT NULL,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutonomyObservation_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CourseWorldSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invocationId" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "asOfAt" DATETIME NOT NULL,
    "eventSetHash" TEXT NOT NULL,
    "worldHash" TEXT NOT NULL,
    "graphHash" TEXT NOT NULL,
    "coverageHash" TEXT NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "threadCount" INTEGER NOT NULL,
    "actorCount" INTEGER NOT NULL,
    "edgeCount" INTEGER NOT NULL,
    "openGapCount" INTEGER NOT NULL,
    "stateJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseWorldSnapshot_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ThreadStateAtCutoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "rootEventKey" TEXT NOT NULL,
    "authorKey" TEXT,
    "firstEventAt" DATETIME NOT NULL,
    "latestEventAt" DATETIME NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "externalHumanCount" INTEGER NOT NULL,
    "authorReturnCount" INTEGER NOT NULL,
    "systemResponseCount" INTEGER NOT NULL,
    "maxDepth" INTEGER NOT NULL,
    "completeness" TEXT NOT NULL,
    "supportGapHours" REAL NOT NULL,
    "stateHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ThreadStateAtCutoff_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CourseWorldSnapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ActorCourseStateAtCutoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "firstSeenAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "authoredThreadCount" INTEGER NOT NULL,
    "replyCount" INTEGER NOT NULL,
    "distinctPeerCount" INTEGER NOT NULL,
    "systemTouchCount30d" INTEGER NOT NULL,
    "lastSystemTouchAt" DATETIME,
    "stateHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ActorCourseStateAtCutoff_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CourseWorldSnapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "InteractionEdgeProjection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "edgeKey" TEXT NOT NULL,
    "sourceActorKey" TEXT,
    "targetActorKey" TEXT,
    "threadKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "weight" INTEGER NOT NULL,
    "firstEventAt" DATETIME NOT NULL,
    "latestEventAt" DATETIME NOT NULL,
    "stateHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InteractionEdgeProjection_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CourseWorldSnapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "CandidateSet" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invocationId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "candidateSetHash" TEXT NOT NULL,
    "asOfAt" DATETIME NOT NULL,
    "candidateCount" INTEGER NOT NULL,
    "candidatesJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CandidateSet_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CandidateSet_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "CourseWorldSnapshot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "SchedulingLedger" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invocationId" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "snapshotHash" TEXT NOT NULL,
    "candidateSetHash" TEXT NOT NULL,
    "budgetDate" TEXT NOT NULL,
    "availableSlots" INTEGER NOT NULL,
    "reservedSlots" INTEGER NOT NULL DEFAULT 0,
    "consumedSlots" INTEGER NOT NULL DEFAULT 0,
    "authorTouchWindowDays" INTEGER NOT NULL DEFAULT 30,
    "authorTouchLimit" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "ledgerHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SchedulingLedger_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "BudgetReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invocationId" TEXT NOT NULL,
    "decisionId" TEXT,
    "courseAlias" TEXT NOT NULL,
    "reservationKey" TEXT NOT NULL,
    "authorKey" TEXT,
    "workloadCost" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "consumedAt" DATETIME,
    "releasedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BudgetReservation_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BudgetReservation_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutonomyDecision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "AutonomyDecision" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invocationId" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "decisionKey" TEXT NOT NULL,
    "threadKey" TEXT NOT NULL,
    "authorKey" TEXT,
    "decision" TEXT NOT NULL,
    "decisionMode" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "observationReceiptHash" TEXT NOT NULL,
    "opportunityReceiptHash" TEXT NOT NULL,
    "evidenceBundleHash" TEXT NOT NULL,
    "intentHash" TEXT,
    "moveSpecHash" TEXT,
    "draftContentHash" TEXT,
    "policyVersion" TEXT NOT NULL,
    "worldHash" TEXT NOT NULL,
    "candidateSetHash" TEXT NOT NULL,
    "evidenceAsOf" DATETIME NOT NULL,
    "decisionJson" TEXT NOT NULL,
    "bodyPersisted" BOOLEAN NOT NULL DEFAULT false,
    "publishAttempted" BOOLEAN NOT NULL DEFAULT false,
    "editorWriteAttempted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutonomyDecision_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "SemanticRealization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "decisionId" TEXT NOT NULL,
    "rendererKind" TEXT NOT NULL,
    "rendererVersion" TEXT NOT NULL,
    "modelProvider" TEXT,
    "modelName" TEXT,
    "contractVersion" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "validationJson" TEXT NOT NULL,
    "bodyPersisted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SemanticRealization_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutonomyDecision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "DecisionTapeEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invocationId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "previousEntryHash" TEXT,
    "entryHash" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DecisionTapeEntry_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ExecutionPermit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "decisionId" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "permitKey" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "targetHash" TEXT NOT NULL,
    "targetVersionHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "revokedAt" DATETIME,
    "realPublishEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ExecutionPermit_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutonomyDecision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ExecutionAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "decisionId" TEXT NOT NULL,
    "permitId" TEXT,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "transport" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "receiptJson" TEXT NOT NULL,
    "remoteOutcomeHash" TEXT,
    "requestedMutationCount" INTEGER NOT NULL DEFAULT 0,
    "sentMutationCount" INTEGER NOT NULL DEFAULT 0,
    "publishAttempted" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExecutionAttempt_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutonomyDecision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ExecutionAttempt_permitId_fkey" FOREIGN KEY ("permitId") REFERENCES "ExecutionPermit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ProximalOutcome" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "decisionId" TEXT NOT NULL,
    "observationWindow" TEXT NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "observedAt" DATETIME,
    "eventPrefixHash" TEXT,
    "firstExternalReplyAt" DATETIME,
    "authorReturned" BOOLEAN,
    "replyDepthDelta" INTEGER,
    "newAuthorCount" INTEGER,
    "functionUptakeJson" TEXT NOT NULL,
    "censored" BOOLEAN NOT NULL DEFAULT false,
    "missingReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProximalOutcome_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutonomyDecision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "ReviewEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "decisionId" TEXT,
    "invocationId" TEXT,
    "kind" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "durationMs" INTEGER,
    "reasonCode" TEXT,
    "evidenceHash" TEXT NOT NULL,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewEvent_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "AutonomyDecision" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ReviewEvent_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "AutonomyIncident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseAlias" TEXT NOT NULL,
    "invocationId" TEXT,
    "targetKey" TEXT,
    "severity" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "summaryJson" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutonomyIncident_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "ScheduledInvocation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AutonomyCourseManifest_manifestHash_key" ON "AutonomyCourseManifest"("manifestHash");
CREATE INDEX "AutonomyCourseManifest_enabled_idx" ON "AutonomyCourseManifest"("enabled");
CREATE UNIQUE INDEX "OperationSchedule_scheduleKey_key" ON "OperationSchedule"("scheduleKey");
CREATE INDEX "OperationSchedule_courseAlias_enabled_idx" ON "OperationSchedule"("courseAlias", "enabled");
CREATE INDEX "OperationSchedule_nextRunAt_idx" ON "OperationSchedule"("nextRunAt");
CREATE UNIQUE INDEX "AutonomyPolicy_policyHash_key" ON "AutonomyPolicy"("policyHash");
CREATE UNIQUE INDEX "AutonomyPolicy_courseAlias_version_key" ON "AutonomyPolicy"("courseAlias", "version");
CREATE INDEX "AutonomyPolicy_courseAlias_status_idx" ON "AutonomyPolicy"("courseAlias", "status");
CREATE INDEX "AutonomyPolicy_validUntil_idx" ON "AutonomyPolicy"("validUntil");
CREATE UNIQUE INDEX "ScheduledInvocation_invocationKey_key" ON "ScheduledInvocation"("invocationKey");
CREATE UNIQUE INDEX "ScheduledInvocation_courseAlias_scheduledFor_mode_key" ON "ScheduledInvocation"("courseAlias", "scheduledFor", "mode");
CREATE INDEX "ScheduledInvocation_courseAlias_status_idx" ON "ScheduledInvocation"("courseAlias", "status");
CREATE INDEX "ScheduledInvocation_leaseExpiresAt_idx" ON "ScheduledInvocation"("leaseExpiresAt");
CREATE INDEX "ScheduledInvocation_scheduledFor_idx" ON "ScheduledInvocation"("scheduledFor");
CREATE UNIQUE INDEX "CourseScanRun_invocationId_key" ON "CourseScanRun"("invocationId");
CREATE UNIQUE INDEX "CourseScanRun_scanKey_key" ON "CourseScanRun"("scanKey");
CREATE INDEX "CourseScanRun_courseAlias_status_idx" ON "CourseScanRun"("courseAlias", "status");
CREATE INDEX "CourseScanRun_startedAt_idx" ON "CourseScanRun"("startedAt");
CREATE UNIQUE INDEX "CourseEvent_eventKey_key" ON "CourseEvent"("eventKey");
CREATE INDEX "CourseEvent_courseAlias_occurredAt_idx" ON "CourseEvent"("courseAlias", "occurredAt");
CREATE INDEX "CourseEvent_threadKey_occurredAt_idx" ON "CourseEvent"("threadKey", "occurredAt");
CREATE INDEX "CourseEvent_actorKey_occurredAt_idx" ON "CourseEvent"("actorKey", "occurredAt");
CREATE INDEX "CourseEvent_parentEventKey_idx" ON "CourseEvent"("parentEventKey");
CREATE INDEX "CourseEvent_scanRunId_idx" ON "CourseEvent"("scanRunId");
CREATE UNIQUE INDEX "CourseEventObservation_scanRunId_eventKey_key" ON "CourseEventObservation"("scanRunId", "eventKey");
CREATE INDEX "CourseEventObservation_eventKey_observedAt_idx" ON "CourseEventObservation"("eventKey", "observedAt");
CREATE INDEX "CourseEventObservation_scanRunId_idx" ON "CourseEventObservation"("scanRunId");
CREATE UNIQUE INDEX "AutonomyObservation_receiptHash_key" ON "AutonomyObservation"("receiptHash");
CREATE INDEX "AutonomyObservation_invocationId_threadKey_observedAt_idx" ON "AutonomyObservation"("invocationId", "threadKey", "observedAt");
CREATE UNIQUE INDEX "CourseWorldSnapshot_invocationId_key" ON "CourseWorldSnapshot"("invocationId");
CREATE INDEX "CourseWorldSnapshot_courseAlias_asOfAt_idx" ON "CourseWorldSnapshot"("courseAlias", "asOfAt");
CREATE INDEX "CourseWorldSnapshot_worldHash_idx" ON "CourseWorldSnapshot"("worldHash");
CREATE UNIQUE INDEX "ThreadStateAtCutoff_snapshotId_threadKey_key" ON "ThreadStateAtCutoff"("snapshotId", "threadKey");
CREATE INDEX "ThreadStateAtCutoff_threadKey_latestEventAt_idx" ON "ThreadStateAtCutoff"("threadKey", "latestEventAt");
CREATE INDEX "ThreadStateAtCutoff_authorKey_idx" ON "ThreadStateAtCutoff"("authorKey");
CREATE UNIQUE INDEX "ActorCourseStateAtCutoff_snapshotId_actorKey_key" ON "ActorCourseStateAtCutoff"("snapshotId", "actorKey");
CREATE INDEX "ActorCourseStateAtCutoff_actorKey_lastSeenAt_idx" ON "ActorCourseStateAtCutoff"("actorKey", "lastSeenAt");
CREATE UNIQUE INDEX "InteractionEdgeProjection_snapshotId_edgeKey_key" ON "InteractionEdgeProjection"("snapshotId", "edgeKey");
CREATE INDEX "InteractionEdgeProjection_sourceActorKey_idx" ON "InteractionEdgeProjection"("sourceActorKey");
CREATE INDEX "InteractionEdgeProjection_targetActorKey_idx" ON "InteractionEdgeProjection"("targetActorKey");
CREATE INDEX "InteractionEdgeProjection_threadKey_idx" ON "InteractionEdgeProjection"("threadKey");
CREATE UNIQUE INDEX "CandidateSet_invocationId_key" ON "CandidateSet"("invocationId");
CREATE INDEX "CandidateSet_candidateSetHash_idx" ON "CandidateSet"("candidateSetHash");
CREATE UNIQUE INDEX "SchedulingLedger_invocationId_key" ON "SchedulingLedger"("invocationId");
CREATE INDEX "SchedulingLedger_courseAlias_budgetDate_idx" ON "SchedulingLedger"("courseAlias", "budgetDate");
CREATE INDEX "SchedulingLedger_ledgerHash_idx" ON "SchedulingLedger"("ledgerHash");
CREATE UNIQUE INDEX "BudgetReservation_reservationKey_key" ON "BudgetReservation"("reservationKey");
CREATE INDEX "BudgetReservation_courseAlias_status_idx" ON "BudgetReservation"("courseAlias", "status");
CREATE INDEX "BudgetReservation_authorKey_createdAt_idx" ON "BudgetReservation"("authorKey", "createdAt");
CREATE INDEX "BudgetReservation_expiresAt_idx" ON "BudgetReservation"("expiresAt");
CREATE UNIQUE INDEX "AutonomyDecision_decisionKey_key" ON "AutonomyDecision"("decisionKey");
CREATE UNIQUE INDEX "AutonomyDecision_invocationId_threadKey_key" ON "AutonomyDecision"("invocationId", "threadKey");
CREATE INDEX "AutonomyDecision_courseAlias_evidenceAsOf_idx" ON "AutonomyDecision"("courseAlias", "evidenceAsOf");
CREATE INDEX "AutonomyDecision_decision_idx" ON "AutonomyDecision"("decision");
CREATE INDEX "AutonomyDecision_authorKey_idx" ON "AutonomyDecision"("authorKey");
CREATE UNIQUE INDEX "SemanticRealization_decisionId_key" ON "SemanticRealization"("decisionId");
CREATE INDEX "SemanticRealization_contentHash_idx" ON "SemanticRealization"("contentHash");
CREATE UNIQUE INDEX "DecisionTapeEntry_entryHash_key" ON "DecisionTapeEntry"("entryHash");
CREATE UNIQUE INDEX "DecisionTapeEntry_invocationId_sequence_key" ON "DecisionTapeEntry"("invocationId", "sequence");
CREATE INDEX "DecisionTapeEntry_invocationId_kind_idx" ON "DecisionTapeEntry"("invocationId", "kind");
CREATE UNIQUE INDEX "ExecutionPermit_permitKey_key" ON "ExecutionPermit"("permitKey");
CREATE UNIQUE INDEX "ExecutionPermit_idempotencyKey_key" ON "ExecutionPermit"("idempotencyKey");
CREATE INDEX "ExecutionPermit_courseAlias_status_idx" ON "ExecutionPermit"("courseAlias", "status");
CREATE INDEX "ExecutionPermit_expiresAt_idx" ON "ExecutionPermit"("expiresAt");
CREATE UNIQUE INDEX "ExecutionAttempt_idempotencyKey_key" ON "ExecutionAttempt"("idempotencyKey");
CREATE INDEX "ExecutionAttempt_decisionId_status_idx" ON "ExecutionAttempt"("decisionId", "status");
CREATE INDEX "ExecutionAttempt_permitId_idx" ON "ExecutionAttempt"("permitId");
CREATE UNIQUE INDEX "ProximalOutcome_decisionId_observationWindow_key" ON "ProximalOutcome"("decisionId", "observationWindow");
CREATE INDEX "ProximalOutcome_status_dueAt_idx" ON "ProximalOutcome"("status", "dueAt");
CREATE INDEX "ReviewEvent_decisionId_idx" ON "ReviewEvent"("decisionId");
CREATE INDEX "ReviewEvent_invocationId_idx" ON "ReviewEvent"("invocationId");
CREATE INDEX "ReviewEvent_kind_createdAt_idx" ON "ReviewEvent"("kind", "createdAt");
CREATE INDEX "AutonomyIncident_courseAlias_status_idx" ON "AutonomyIncident"("courseAlias", "status");
CREATE INDEX "AutonomyIncident_invocationId_idx" ON "AutonomyIncident"("invocationId");
CREATE INDEX "AutonomyIncident_severity_openedAt_idx" ON "AutonomyIncident"("severity", "openedAt");
