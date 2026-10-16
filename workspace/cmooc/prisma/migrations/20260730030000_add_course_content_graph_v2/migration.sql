CREATE TABLE "CourseStructureFact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseAlias" TEXT NOT NULL,
    "courseKey" TEXT NOT NULL,
    "factKey" TEXT NOT NULL,
    "factIdentityKey" TEXT NOT NULL,
    "factKind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "subjectKind" TEXT NOT NULL,
    "predicate" TEXT,
    "objectKey" TEXT,
    "objectKind" TEXT,
    "revisionHash" TEXT NOT NULL,
    "occurredAt" DATETIME,
    "ordinal" INTEGER,
    "attributesJson" TEXT NOT NULL,
    "legalityStatus" TEXT NOT NULL,
    "containsForumText" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "CourseStructureFact_factKey_key"
ON "CourseStructureFact"("factKey");

CREATE INDEX "CourseStructureFact_courseAlias_courseKey_factIdentityKey_occurredAt_idx"
ON "CourseStructureFact"("courseAlias", "courseKey", "factIdentityKey", "occurredAt");

CREATE INDEX "CourseStructureFact_subjectKey_occurredAt_idx"
ON "CourseStructureFact"("subjectKey", "occurredAt");

CREATE INDEX "CourseStructureFact_objectKey_occurredAt_idx"
ON "CourseStructureFact"("objectKey", "occurredAt");

CREATE INDEX "CourseStructureFact_factKind_subjectKind_predicate_idx"
ON "CourseStructureFact"("factKind", "subjectKind", "predicate");

CREATE TABLE "CourseStructureFactObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanRunId" TEXT NOT NULL,
    "factKey" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceVersionHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseStructureFactObservation_scanRunId_fkey"
      FOREIGN KEY ("scanRunId") REFERENCES "CourseScanRun" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CourseStructureFactObservation_factKey_fkey"
      FOREIGN KEY ("factKey") REFERENCES "CourseStructureFact" ("factKey")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CourseStructureFactObservation_scanRunId_factKey_key"
ON "CourseStructureFactObservation"("scanRunId", "factKey");

CREATE INDEX "CourseStructureFactObservation_factKey_observedAt_idx"
ON "CourseStructureFactObservation"("factKey", "observedAt");

CREATE INDEX "CourseStructureFactObservation_scanRunId_idx"
ON "CourseStructureFactObservation"("scanRunId");

CREATE TABLE "CourseContentGraphSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "worldSnapshotId" TEXT NOT NULL,
    "courseAlias" TEXT NOT NULL,
    "asOfAt" DATETIME NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "structureFactSetHash" TEXT NOT NULL,
    "nodeSetHash" TEXT NOT NULL,
    "edgeSetHash" TEXT NOT NULL,
    "contentGraphHash" TEXT NOT NULL,
    "coverageHash" TEXT NOT NULL,
    "coverageStatus" TEXT NOT NULL,
    "roleRegistryStatus" TEXT NOT NULL,
    "nodeCount" INTEGER NOT NULL,
    "edgeCount" INTEGER NOT NULL,
    "learnerNodeCount" INTEGER NOT NULL,
    "stateJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseContentGraphSnapshot_worldSnapshotId_fkey"
      FOREIGN KEY ("worldSnapshotId") REFERENCES "CourseWorldSnapshot" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CourseContentGraphSnapshot_worldSnapshotId_schemaVersion_key"
ON "CourseContentGraphSnapshot"("worldSnapshotId", "schemaVersion");

CREATE INDEX "CourseContentGraphSnapshot_courseAlias_asOfAt_idx"
ON "CourseContentGraphSnapshot"("courseAlias", "asOfAt");

CREATE INDEX "CourseContentGraphSnapshot_contentGraphHash_idx"
ON "CourseContentGraphSnapshot"("contentGraphHash");

CREATE INDEX "CourseContentGraphSnapshot_coverageStatus_idx"
ON "CourseContentGraphSnapshot"("coverageStatus");

CREATE TABLE "CourseGraphNodeProjection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "graphSnapshotId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "role" TEXT,
    "ordinal" INTEGER,
    "firstSeenAt" DATETIME,
    "lastSeenAt" DATETIME,
    "completeness" TEXT NOT NULL,
    "metricsJson" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseGraphNodeProjection_graphSnapshotId_fkey"
      FOREIGN KEY ("graphSnapshotId") REFERENCES "CourseContentGraphSnapshot" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CourseGraphNodeProjection_graphSnapshotId_nodeKey_key"
ON "CourseGraphNodeProjection"("graphSnapshotId", "nodeKey");

CREATE INDEX "CourseGraphNodeProjection_graphSnapshotId_kind_nodeKey_idx"
ON "CourseGraphNodeProjection"("graphSnapshotId", "kind", "nodeKey");

CREATE INDEX "CourseGraphNodeProjection_nodeKey_lastSeenAt_idx"
ON "CourseGraphNodeProjection"("nodeKey", "lastSeenAt");

CREATE INDEX "CourseGraphNodeProjection_role_idx"
ON "CourseGraphNodeProjection"("role");

CREATE TABLE "CourseGraphEdgeProjection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "graphSnapshotId" TEXT NOT NULL,
    "edgeKey" TEXT NOT NULL,
    "sourceNodeKey" TEXT NOT NULL,
    "targetNodeKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "scopeNodeKey" TEXT,
    "weight" REAL NOT NULL,
    "evidenceCount" INTEGER NOT NULL,
    "firstEventAt" DATETIME,
    "latestEventAt" DATETIME,
    "completeness" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseGraphEdgeProjection_graphSnapshotId_fkey"
      FOREIGN KEY ("graphSnapshotId") REFERENCES "CourseContentGraphSnapshot" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CourseGraphEdgeProjection_graphSnapshotId_edgeKey_key"
ON "CourseGraphEdgeProjection"("graphSnapshotId", "edgeKey");

CREATE INDEX "CourseGraphEdgeProjection_graphSnapshotId_kind_weight_idx"
ON "CourseGraphEdgeProjection"("graphSnapshotId", "kind", "weight");

CREATE INDEX "CourseGraphEdgeProjection_sourceNodeKey_idx"
ON "CourseGraphEdgeProjection"("sourceNodeKey");

CREATE INDEX "CourseGraphEdgeProjection_targetNodeKey_idx"
ON "CourseGraphEdgeProjection"("targetNodeKey");

CREATE INDEX "CourseGraphEdgeProjection_scopeNodeKey_idx"
ON "CourseGraphEdgeProjection"("scopeNodeKey");

CREATE TABLE "LearnerNetworkPositionAtCutoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "graphSnapshotId" TEXT NOT NULL,
    "actorKey" TEXT NOT NULL,
    "windowKind" TEXT NOT NULL,
    "coverageStatus" TEXT NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "authoredThreadCount" INTEGER NOT NULL,
    "replyCount" INTEGER NOT NULL,
    "inboundReplyCount" INTEGER NOT NULL,
    "outboundReplyCount" INTEGER NOT NULL,
    "uniqueInboundPeerCount" INTEGER NOT NULL,
    "uniqueOutboundPeerCount" INTEGER NOT NULL,
    "reciprocalPeerCount" INTEGER NOT NULL,
    "componentSize" INTEGER NOT NULL,
    "kCore" INTEGER,
    "pageRank" REAL,
    "stateHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LearnerNetworkPositionAtCutoff_graphSnapshotId_fkey"
      FOREIGN KEY ("graphSnapshotId") REFERENCES "CourseContentGraphSnapshot" ("id")
      ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LearnerNetworkPositionAtCutoff_graphSnapshotId_actorKey_windowKind_key"
ON "LearnerNetworkPositionAtCutoff"("graphSnapshotId", "actorKey", "windowKind");

CREATE INDEX "LearnerNetworkPositionAtCutoff_graphSnapshotId_windowKind_coverageStatus_idx"
ON "LearnerNetworkPositionAtCutoff"("graphSnapshotId", "windowKind", "coverageStatus");

CREATE INDEX "LearnerNetworkPositionAtCutoff_actorKey_windowKind_idx"
ON "LearnerNetworkPositionAtCutoff"("actorKey", "windowKind");
