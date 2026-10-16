CREATE TABLE "AgentContextSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "taskId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "companionType" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "asOfAt" DATETIME NOT NULL,
    "observationSchemaVersion" TEXT NOT NULL,
    "inferenceModelVersion" TEXT NOT NULL,
    "expressionPolicyVersion" TEXT NOT NULL,
    "observationJson" TEXT NOT NULL,
    "inferenceJson" TEXT NOT NULL,
    "expressionJson" TEXT NOT NULL,
    "futureInformationUsed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentContextSnapshot_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentContextSnapshot_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "InterventionTask" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AgentContextSnapshot_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AgentContextSnapshot_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AgentContextSnapshot_taskId_revision_key" ON "AgentContextSnapshot"("taskId", "revision");
CREATE INDEX "AgentContextSnapshot_courseId_idx" ON "AgentContextSnapshot"("courseId");
CREATE INDEX "AgentContextSnapshot_taskId_idx" ON "AgentContextSnapshot"("taskId");
CREATE INDEX "AgentContextSnapshot_postId_idx" ON "AgentContextSnapshot"("postId");
CREATE INDEX "AgentContextSnapshot_targetUserId_idx" ON "AgentContextSnapshot"("targetUserId");
CREATE INDEX "AgentContextSnapshot_sourceRunId_idx" ON "AgentContextSnapshot"("sourceRunId");
CREATE INDEX "AgentContextSnapshot_asOfAt_idx" ON "AgentContextSnapshot"("asOfAt");
CREATE INDEX "AgentContextSnapshot_companionType_idx" ON "AgentContextSnapshot"("companionType");
