-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "taskId" TEXT,
    "postId" TEXT,
    "agentName" TEXT NOT NULL,
    "inputJson" TEXT NOT NULL,
    "outputJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "AgentRun_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "InterventionTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AgentRun" ("agentName", "courseId", "finishedAt", "id", "inputJson", "outputJson", "postId", "startedAt", "status", "taskId") SELECT "agentName", "courseId", "finishedAt", "id", "inputJson", "outputJson", "postId", "startedAt", "status", "taskId" FROM "AgentRun";
DROP TABLE "AgentRun";
ALTER TABLE "new_AgentRun" RENAME TO "AgentRun";
CREATE INDEX "AgentRun_courseId_idx" ON "AgentRun"("courseId");
CREATE INDEX "AgentRun_taskId_idx" ON "AgentRun"("taskId");
CREATE INDEX "AgentRun_postId_idx" ON "AgentRun"("postId");
CREATE TABLE "new_AutoInterventionCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "runId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "postUrl" TEXT NOT NULL,
    "postTitle" TEXT NOT NULL,
    "rawExtractJson" TEXT NOT NULL,
    "valueAnalysisJson" TEXT,
    "interventionScore" REAL NOT NULL,
    "cieLevel" INTEGER NOT NULL,
    "emotionLabel" TEXT NOT NULL,
    "topicType" TEXT NOT NULL,
    "interventionType" TEXT NOT NULL,
    "targetMode" TEXT NOT NULL,
    "targetCommentIndex" INTEGER,
    "targetReason" TEXT NOT NULL,
    "replyStrategy" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "draftReply" TEXT,
    "finalReply" TEXT,
    "safetyRisk" INTEGER,
    "status" TEXT NOT NULL,
    "publishedUrl" TEXT,
    "screenshotPath" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoInterventionCandidate_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutoInterventionCandidate_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutoInterventionRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AutoInterventionCandidate_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_AutoInterventionCandidate" ("cieLevel", "courseId", "createdAt", "draftReply", "emotionLabel", "errorMessage", "finalReply", "id", "interventionScore", "interventionType", "postId", "postTitle", "postUrl", "publishedUrl", "rawExtractJson", "reason", "replyStrategy", "riskLevel", "runId", "safetyRisk", "screenshotPath", "status", "targetCommentIndex", "targetMode", "targetReason", "topicType", "updatedAt", "valueAnalysisJson") SELECT "cieLevel", "courseId", "createdAt", "draftReply", "emotionLabel", "errorMessage", "finalReply", "id", "interventionScore", "interventionType", "postId", "postTitle", "postUrl", "publishedUrl", "rawExtractJson", "reason", "replyStrategy", "riskLevel", "runId", "safetyRisk", "screenshotPath", "status", "targetCommentIndex", "targetMode", "targetReason", "topicType", "updatedAt", "valueAnalysisJson" FROM "AutoInterventionCandidate";
DROP TABLE "AutoInterventionCandidate";
ALTER TABLE "new_AutoInterventionCandidate" RENAME TO "AutoInterventionCandidate";
CREATE INDEX "AutoInterventionCandidate_courseId_idx" ON "AutoInterventionCandidate"("courseId");
CREATE INDEX "AutoInterventionCandidate_runId_idx" ON "AutoInterventionCandidate"("runId");
CREATE INDEX "AutoInterventionCandidate_postId_idx" ON "AutoInterventionCandidate"("postId");
CREATE INDEX "AutoInterventionCandidate_postUrl_idx" ON "AutoInterventionCandidate"("postUrl");
CREATE INDEX "AutoInterventionCandidate_status_idx" ON "AutoInterventionCandidate"("status");
CREATE TABLE "new_AutoInterventionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "forumListUrl" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "maxScanPosts" INTEGER NOT NULL,
    "maxPublishCount" INTEGER NOT NULL,
    "minScoreToPublish" REAL NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "reportJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutoInterventionRun_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AutoInterventionRun" ("courseId", "createdAt", "finishedAt", "forumListUrl", "id", "maxPublishCount", "maxScanPosts", "minScoreToPublish", "mode", "reportJson", "startedAt", "status", "updatedAt") SELECT "courseId", "createdAt", "finishedAt", "forumListUrl", "id", "maxPublishCount", "maxScanPosts", "minScoreToPublish", "mode", "reportJson", "startedAt", "status", "updatedAt" FROM "AutoInterventionRun";
DROP TABLE "AutoInterventionRun";
ALTER TABLE "new_AutoInterventionRun" RENAME TO "AutoInterventionRun";
CREATE INDEX "AutoInterventionRun_courseId_idx" ON "AutoInterventionRun"("courseId");
CREATE TABLE "new_CommunityMetric" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "date" DATETIME NOT NULL,
    "postCount" INTEGER NOT NULL,
    "replyCount" INTEGER NOT NULL,
    "activeUserCount" INTEGER NOT NULL,
    "avgCieLevel" REAL NOT NULL,
    "highValueUnansweredCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CommunityMetric_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CommunityMetric" ("activeUserCount", "avgCieLevel", "courseId", "createdAt", "date", "highValueUnansweredCount", "id", "postCount", "replyCount") SELECT "activeUserCount", "avgCieLevel", "courseId", "createdAt", "date", "highValueUnansweredCount", "id", "postCount", "replyCount" FROM "CommunityMetric";
DROP TABLE "CommunityMetric";
ALTER TABLE "new_CommunityMetric" RENAME TO "CommunityMetric";
CREATE INDEX "CommunityMetric_courseId_idx" ON "CommunityMetric"("courseId");
CREATE INDEX "CommunityMetric_date_idx" ON "CommunityMetric"("date");
CREATE UNIQUE INDEX "CommunityMetric_courseId_date_key" ON "CommunityMetric"("courseId", "date");
CREATE TABLE "new_ForumIngestionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "postCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "userCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "metadataJson" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ForumIngestionRun_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ForumIngestionRun" ("courseId", "createdAt", "errorMessage", "finishedAt", "id", "metadataJson", "postCount", "replyCount", "sourceType", "sourceUrl", "startedAt", "status", "updatedAt", "userCount") SELECT "courseId", "createdAt", "errorMessage", "finishedAt", "id", "metadataJson", "postCount", "replyCount", "sourceType", "sourceUrl", "startedAt", "status", "updatedAt", "userCount" FROM "ForumIngestionRun";
DROP TABLE "ForumIngestionRun";
ALTER TABLE "new_ForumIngestionRun" RENAME TO "ForumIngestionRun";
CREATE INDEX "ForumIngestionRun_courseId_idx" ON "ForumIngestionRun"("courseId");
CREATE INDEX "ForumIngestionRun_sourceUrl_idx" ON "ForumIngestionRun"("sourceUrl");
CREATE INDEX "ForumIngestionRun_status_idx" ON "ForumIngestionRun"("status");
CREATE INDEX "ForumIngestionRun_createdAt_idx" ON "ForumIngestionRun"("createdAt");
CREATE TABLE "new_ForumPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "forumPostId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "lastReplyAt" DATETIME,
    CONSTRAINT "ForumPost_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ForumPost_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ForumPost" ("authorId", "content", "courseId", "createdAt", "forumPostId", "id", "lastReplyAt", "likeCount", "replyCount", "title", "updatedAt", "url", "viewCount") SELECT "authorId", "content", "courseId", "createdAt", "forumPostId", "id", "lastReplyAt", "likeCount", "replyCount", "title", "updatedAt", "url", "viewCount" FROM "ForumPost";
DROP TABLE "ForumPost";
ALTER TABLE "new_ForumPost" RENAME TO "ForumPost";
CREATE UNIQUE INDEX "ForumPost_forumPostId_key" ON "ForumPost"("forumPostId");
CREATE INDEX "ForumPost_courseId_idx" ON "ForumPost"("courseId");
CREATE INDEX "ForumPost_authorId_idx" ON "ForumPost"("authorId");
CREATE TABLE "new_ForumPostSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "runId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "forumPostId" TEXT NOT NULL,
    "columnId" TEXT,
    "columnName" TEXT,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "replyCount" INTEGER NOT NULL,
    "likeCount" INTEGER NOT NULL,
    "viewCount" INTEGER NOT NULL,
    "contentLength" INTEGER NOT NULL,
    "lastReplyAt" DATETIME,
    "rawJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForumPostSnapshot_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ForumPostSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ForumIngestionRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ForumPostSnapshot_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ForumPostSnapshot" ("columnId", "columnName", "contentLength", "courseId", "createdAt", "forumPostId", "id", "lastReplyAt", "likeCount", "postId", "rawJson", "replyCount", "runId", "title", "url", "viewCount") SELECT "columnId", "columnName", "contentLength", "courseId", "createdAt", "forumPostId", "id", "lastReplyAt", "likeCount", "postId", "rawJson", "replyCount", "runId", "title", "url", "viewCount" FROM "ForumPostSnapshot";
DROP TABLE "ForumPostSnapshot";
ALTER TABLE "new_ForumPostSnapshot" RENAME TO "ForumPostSnapshot";
CREATE INDEX "ForumPostSnapshot_courseId_idx" ON "ForumPostSnapshot"("courseId");
CREATE INDEX "ForumPostSnapshot_runId_idx" ON "ForumPostSnapshot"("runId");
CREATE INDEX "ForumPostSnapshot_postId_idx" ON "ForumPostSnapshot"("postId");
CREATE INDEX "ForumPostSnapshot_forumPostId_idx" ON "ForumPostSnapshot"("forumPostId");
CREATE INDEX "ForumPostSnapshot_columnId_idx" ON "ForumPostSnapshot"("columnId");
CREATE INDEX "ForumPostSnapshot_createdAt_idx" ON "ForumPostSnapshot"("createdAt");
CREATE TABLE "new_ForumReply" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "forumReplyId" TEXT NOT NULL,
    "platformReplyId" TEXT,
    "parentPlatformReplyId" TEXT,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "targetUserId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "content" TEXT NOT NULL,
    "isCompanionReply" BOOLEAN NOT NULL DEFAULT false,
    "companionType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForumReply_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ForumReply_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ForumReply_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ForumReply" ("authorId", "companionType", "content", "courseId", "createdAt", "depth", "forumReplyId", "id", "isCompanionReply", "parentPlatformReplyId", "platformReplyId", "postId", "targetUserId") SELECT "authorId", "companionType", "content", "courseId", "createdAt", "depth", "forumReplyId", "id", "isCompanionReply", "parentPlatformReplyId", "platformReplyId", "postId", "targetUserId" FROM "ForumReply";
DROP TABLE "ForumReply";
ALTER TABLE "new_ForumReply" RENAME TO "ForumReply";
CREATE UNIQUE INDEX "ForumReply_forumReplyId_key" ON "ForumReply"("forumReplyId");
CREATE INDEX "ForumReply_courseId_idx" ON "ForumReply"("courseId");
CREATE INDEX "ForumReply_postId_idx" ON "ForumReply"("postId");
CREATE INDEX "ForumReply_authorId_idx" ON "ForumReply"("authorId");
CREATE INDEX "ForumReply_targetUserId_idx" ON "ForumReply"("targetUserId");
CREATE INDEX "ForumReply_platformReplyId_idx" ON "ForumReply"("platformReplyId");
CREATE INDEX "ForumReply_parentPlatformReplyId_idx" ON "ForumReply"("parentPlatformReplyId");
CREATE INDEX "ForumReply_depth_idx" ON "ForumReply"("depth");
CREATE TABLE "new_ForumUserSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "runId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "forumUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "postCount" INTEGER NOT NULL,
    "replyCount" INTEGER NOT NULL,
    "companionReplyCount" INTEGER NOT NULL,
    "activityLevel" INTEGER NOT NULL,
    "emotionalState" TEXT NOT NULL,
    "centralityScore" REAL NOT NULL,
    "firstSeenAt" DATETIME,
    "lastSeenAt" DATETIME,
    "tagsJson" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForumUserSnapshot_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ForumUserSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ForumIngestionRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ForumUserSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ForumUserSnapshot" ("activityLevel", "centralityScore", "companionReplyCount", "courseId", "createdAt", "displayName", "emotionalState", "evidenceJson", "firstSeenAt", "forumUserId", "id", "lastSeenAt", "postCount", "replyCount", "role", "runId", "tagsJson", "userId") SELECT "activityLevel", "centralityScore", "companionReplyCount", "courseId", "createdAt", "displayName", "emotionalState", "evidenceJson", "firstSeenAt", "forumUserId", "id", "lastSeenAt", "postCount", "replyCount", "role", "runId", "tagsJson", "userId" FROM "ForumUserSnapshot";
DROP TABLE "ForumUserSnapshot";
ALTER TABLE "new_ForumUserSnapshot" RENAME TO "ForumUserSnapshot";
CREATE INDEX "ForumUserSnapshot_courseId_idx" ON "ForumUserSnapshot"("courseId");
CREATE INDEX "ForumUserSnapshot_runId_idx" ON "ForumUserSnapshot"("runId");
CREATE INDEX "ForumUserSnapshot_userId_idx" ON "ForumUserSnapshot"("userId");
CREATE INDEX "ForumUserSnapshot_forumUserId_idx" ON "ForumUserSnapshot"("forumUserId");
CREATE INDEX "ForumUserSnapshot_createdAt_idx" ON "ForumUserSnapshot"("createdAt");
CREATE TABLE "new_ForumUserUtteranceAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "utteranceKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "forumUserId" TEXT NOT NULL,
    "postId" TEXT,
    "replyId" TEXT,
    "sourceRunId" TEXT,
    "utteranceType" TEXT NOT NULL,
    "columnName" TEXT,
    "title" TEXT,
    "contentPreview" TEXT NOT NULL,
    "contentLength" INTEGER NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "targetUserId" TEXT,
    "cieLevel" INTEGER NOT NULL,
    "cieLabel" TEXT NOT NULL,
    "cieConfidence" REAL NOT NULL,
    "iamPhase" INTEGER NOT NULL,
    "knowledgePhase" TEXT NOT NULL,
    "emotionLabel" TEXT NOT NULL,
    "confusionScore" INTEGER NOT NULL,
    "urgencyScore" INTEGER NOT NULL,
    "isQuestion" BOOLEAN NOT NULL,
    "resourceNeed" BOOLEAN NOT NULL,
    "shallowReply" BOOLEAN NOT NULL,
    "needsHumanReview" BOOLEAN NOT NULL,
    "matchedWordsJson" TEXT NOT NULL,
    "topicTermsJson" TEXT NOT NULL,
    "sourceCreatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "analyzedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForumUserUtteranceAnalysis_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ForumUserUtteranceAnalysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ForumUserUtteranceAnalysis_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ForumUserUtteranceAnalysis_replyId_fkey" FOREIGN KEY ("replyId") REFERENCES "ForumReply" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ForumUserUtteranceAnalysis" ("analyzedAt", "cieConfidence", "cieLabel", "cieLevel", "columnName", "confusionScore", "contentLength", "contentPreview", "courseId", "createdAt", "depth", "emotionLabel", "forumUserId", "iamPhase", "id", "isQuestion", "knowledgePhase", "matchedWordsJson", "needsHumanReview", "postId", "replyId", "resourceNeed", "shallowReply", "sourceCreatedAt", "sourceRunId", "targetUserId", "title", "topicTermsJson", "urgencyScore", "userId", "utteranceKey", "utteranceType") SELECT "analyzedAt", "cieConfidence", "cieLabel", "cieLevel", "columnName", "confusionScore", "contentLength", "contentPreview", "courseId", "createdAt", "depth", "emotionLabel", "forumUserId", "iamPhase", "id", "isQuestion", "knowledgePhase", "matchedWordsJson", "needsHumanReview", "postId", "replyId", "resourceNeed", "shallowReply", "sourceCreatedAt", "sourceRunId", "targetUserId", "title", "topicTermsJson", "urgencyScore", "userId", "utteranceKey", "utteranceType" FROM "ForumUserUtteranceAnalysis";
DROP TABLE "ForumUserUtteranceAnalysis";
ALTER TABLE "new_ForumUserUtteranceAnalysis" RENAME TO "ForumUserUtteranceAnalysis";
CREATE UNIQUE INDEX "ForumUserUtteranceAnalysis_utteranceKey_key" ON "ForumUserUtteranceAnalysis"("utteranceKey");
CREATE INDEX "ForumUserUtteranceAnalysis_courseId_idx" ON "ForumUserUtteranceAnalysis"("courseId");
CREATE INDEX "ForumUserUtteranceAnalysis_userId_idx" ON "ForumUserUtteranceAnalysis"("userId");
CREATE INDEX "ForumUserUtteranceAnalysis_forumUserId_idx" ON "ForumUserUtteranceAnalysis"("forumUserId");
CREATE INDEX "ForumUserUtteranceAnalysis_postId_idx" ON "ForumUserUtteranceAnalysis"("postId");
CREATE INDEX "ForumUserUtteranceAnalysis_replyId_idx" ON "ForumUserUtteranceAnalysis"("replyId");
CREATE INDEX "ForumUserUtteranceAnalysis_sourceRunId_idx" ON "ForumUserUtteranceAnalysis"("sourceRunId");
CREATE INDEX "ForumUserUtteranceAnalysis_utteranceType_idx" ON "ForumUserUtteranceAnalysis"("utteranceType");
CREATE INDEX "ForumUserUtteranceAnalysis_cieLevel_idx" ON "ForumUserUtteranceAnalysis"("cieLevel");
CREATE INDEX "ForumUserUtteranceAnalysis_iamPhase_idx" ON "ForumUserUtteranceAnalysis"("iamPhase");
CREATE INDEX "ForumUserUtteranceAnalysis_sourceCreatedAt_idx" ON "ForumUserUtteranceAnalysis"("sourceCreatedAt");
CREATE TABLE "new_InteractionAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "postId" TEXT NOT NULL,
    "cieLevel" INTEGER NOT NULL,
    "cieLabel" TEXT NOT NULL,
    "emotionLabel" TEXT NOT NULL,
    "topicRelevance" REAL NOT NULL,
    "cognitiveDepth" REAL NOT NULL,
    "discussionPotential" REAL NOT NULL,
    "unansweredHours" REAL NOT NULL,
    "isolatedLearnerScore" REAL NOT NULL,
    "duplicateScore" REAL NOT NULL,
    "analyzedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InteractionAnalysis_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InteractionAnalysis_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_InteractionAnalysis" ("analyzedAt", "cieLabel", "cieLevel", "cognitiveDepth", "courseId", "discussionPotential", "duplicateScore", "emotionLabel", "id", "isolatedLearnerScore", "postId", "topicRelevance", "unansweredHours") SELECT "analyzedAt", "cieLabel", "cieLevel", "cognitiveDepth", "courseId", "discussionPotential", "duplicateScore", "emotionLabel", "id", "isolatedLearnerScore", "postId", "topicRelevance", "unansweredHours" FROM "InteractionAnalysis";
DROP TABLE "InteractionAnalysis";
ALTER TABLE "new_InteractionAnalysis" RENAME TO "InteractionAnalysis";
CREATE UNIQUE INDEX "InteractionAnalysis_postId_key" ON "InteractionAnalysis"("postId");
CREATE INDEX "InteractionAnalysis_courseId_idx" ON "InteractionAnalysis"("courseId");
CREATE TABLE "new_InterventionTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT,
    "postId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "interventionType" TEXT NOT NULL,
    "publishTarget" TEXT NOT NULL DEFAULT 'post_comment',
    "targetCommentStrategy" TEXT,
    "targetCommentIndex" INTEGER,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "publishedAt" DATETIME,
    CONSTRAINT "InterventionTask_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InterventionTask_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InterventionTask_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_InterventionTask" ("courseId", "createdAt", "draftContent", "errorMessage", "finalContent", "id", "interventionType", "postId", "priorityScore", "publishTarget", "publishedAt", "publishedUrl", "retryCount", "safetyResult", "safetyRisk", "screenshotPath", "status", "targetCommentIndex", "targetCommentStrategy", "targetUserId", "updatedAt") SELECT "courseId", "createdAt", "draftContent", "errorMessage", "finalContent", "id", "interventionType", "postId", "priorityScore", "publishTarget", "publishedAt", "publishedUrl", "retryCount", "safetyResult", "safetyRisk", "screenshotPath", "status", "targetCommentIndex", "targetCommentStrategy", "targetUserId", "updatedAt" FROM "InterventionTask";
DROP TABLE "InterventionTask";
ALTER TABLE "new_InterventionTask" RENAME TO "InterventionTask";
CREATE INDEX "InterventionTask_courseId_idx" ON "InterventionTask"("courseId");
CREATE INDEX "InterventionTask_postId_idx" ON "InterventionTask"("postId");
CREATE INDEX "InterventionTask_targetUserId_idx" ON "InterventionTask"("targetUserId");
CREATE INDEX "InterventionTask_status_idx" ON "InterventionTask"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
