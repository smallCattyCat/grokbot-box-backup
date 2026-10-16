-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT,
    "postId" TEXT,
    "agentName" TEXT NOT NULL,
    "inputJson" TEXT NOT NULL,
    "outputJson" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "courseId" TEXT,
    FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY ("taskId") REFERENCES "InterventionTask" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutoInterventionCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "courseId" TEXT,
    FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY ("runId") REFERENCES "AutoInterventionRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AutoInterventionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "courseId" TEXT
);

-- CreateTable
CREATE TABLE "CommunityMetric" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" DATETIME NOT NULL,
    "postCount" INTEGER NOT NULL,
    "replyCount" INTEGER NOT NULL,
    "activeUserCount" INTEGER NOT NULL,
    "avgCieLevel" REAL NOT NULL,
    "highValueUnansweredCount" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "courseId" TEXT
);

-- CreateTable
CREATE TABLE "CompanionProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "persona" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "roleBoundary" TEXT NOT NULL,
    "currentMentalStateJson" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platformCourseId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadataJson" TEXT NOT NULL,
    "lastSyncedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CourseMembership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "forumUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "roleInCourse" TEXT NOT NULL,
    "firstSeenAt" DATETIME,
    "lastSeenAt" DATETIME,
    "postCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "companionReplyCount" INTEGER NOT NULL DEFAULT 0,
    "activityLevel" INTEGER NOT NULL DEFAULT 0,
    "emotionalState" TEXT NOT NULL DEFAULT 'unknown',
    "centralityScore" REAL NOT NULL DEFAULT 0,
    "personaType" TEXT NOT NULL DEFAULT 'participant',
    "tagsJson" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ForumIngestionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "courseId" TEXT
);

-- CreateTable
CREATE TABLE "ForumPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "courseId" TEXT,
    FOREIGN KEY ("authorId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ForumPostSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "forumPostId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "replyCount" INTEGER NOT NULL,
    "likeCount" INTEGER NOT NULL,
    "viewCount" INTEGER NOT NULL,
    "contentLength" INTEGER NOT NULL,
    "lastReplyAt" DATETIME,
    "rawJson" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "columnId" TEXT,
    "columnName" TEXT,
    "courseId" TEXT,
    FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY ("runId") REFERENCES "ForumIngestionRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ForumReply" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "forumReplyId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isCompanionReply" BOOLEAN NOT NULL DEFAULT false,
    "companionType" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platformReplyId" TEXT,
    "parentPlatformReplyId" TEXT,
    "targetUserId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "courseId" TEXT,
    FOREIGN KEY ("authorId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ForumSetting" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'default',
    "forumBaseUrl" TEXT NOT NULL,
    "loginUrl" TEXT NOT NULL,
    "postUrlPattern" TEXT NOT NULL,
    "replyEditorSelector" TEXT NOT NULL,
    "replySubmitSelector" TEXT NOT NULL,
    "replySuccessSelector" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "realPublishEnabled" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "ForumUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "forumUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tagsJson" TEXT NOT NULL,
    "activityLevel" INTEGER NOT NULL,
    "emotionalState" TEXT NOT NULL,
    "centralityScore" REAL NOT NULL,
    "lastActiveAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ForumUserCourseProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "courseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "forumUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "utteranceCount" INTEGER NOT NULL DEFAULT 0,
    "postCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "nestedReplyCount" INTEGER NOT NULL DEFAULT 0,
    "outgoingInteractionCount" INTEGER NOT NULL DEFAULT 0,
    "incomingInteractionCount" INTEGER NOT NULL DEFAULT 0,
    "avgCieLevel" REAL NOT NULL DEFAULT 0,
    "avgCieConfidence" REAL NOT NULL DEFAULT 0,
    "dominantIamPhase" INTEGER NOT NULL DEFAULT 1,
    "dominantKnowledgePhase" TEXT NOT NULL DEFAULT 'unknown',
    "dominantEmotion" TEXT NOT NULL DEFAULT 'unknown',
    "avgConfusionScore" REAL NOT NULL DEFAULT 0,
    "avgUrgencyScore" REAL NOT NULL DEFAULT 0,
    "questionRatio" REAL NOT NULL DEFAULT 0,
    "resourceNeedRatio" REAL NOT NULL DEFAULT 0,
    "highCieRatio" REAL NOT NULL DEFAULT 0,
    "shallowReplyRatio" REAL NOT NULL DEFAULT 0,
    "centralityScore" REAL NOT NULL DEFAULT 0,
    "personaType" TEXT NOT NULL DEFAULT 'participant',
    "riskFlagsJson" TEXT NOT NULL,
    "interestTermsJson" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "profileSummary" TEXT NOT NULL,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ForumUserProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "forumUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "sourceRunId" TEXT,
    "utteranceCount" INTEGER NOT NULL DEFAULT 0,
    "postCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "nestedReplyCount" INTEGER NOT NULL DEFAULT 0,
    "outgoingInteractionCount" INTEGER NOT NULL DEFAULT 0,
    "incomingInteractionCount" INTEGER NOT NULL DEFAULT 0,
    "avgCieLevel" REAL NOT NULL DEFAULT 0,
    "avgCieConfidence" REAL NOT NULL DEFAULT 0,
    "dominantIamPhase" INTEGER NOT NULL DEFAULT 1,
    "dominantKnowledgePhase" TEXT NOT NULL DEFAULT 'unknown',
    "dominantEmotion" TEXT NOT NULL DEFAULT 'unknown',
    "avgConfusionScore" REAL NOT NULL DEFAULT 0,
    "avgUrgencyScore" REAL NOT NULL DEFAULT 0,
    "questionRatio" REAL NOT NULL DEFAULT 0,
    "resourceNeedRatio" REAL NOT NULL DEFAULT 0,
    "highCieRatio" REAL NOT NULL DEFAULT 0,
    "shallowReplyRatio" REAL NOT NULL DEFAULT 0,
    "centralityScore" REAL NOT NULL DEFAULT 0,
    "personaType" TEXT NOT NULL DEFAULT 'participant',
    "riskFlagsJson" TEXT NOT NULL,
    "interestTermsJson" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "profileSummary" TEXT NOT NULL,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    FOREIGN KEY ("userId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ForumUserSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "courseId" TEXT,
    FOREIGN KEY ("userId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY ("runId") REFERENCES "ForumIngestionRun" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ForumUserUtteranceAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "courseId" TEXT,
    FOREIGN KEY ("replyId") REFERENCES "ForumReply" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    FOREIGN KEY ("userId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InteractionAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "courseId" TEXT,
    FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InterventionTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "interventionType" TEXT NOT NULL,
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
    "publishTarget" TEXT NOT NULL DEFAULT 'post_comment',
    "targetCommentStrategy" TEXT,
    "targetCommentIndex" INTEGER,
    "courseId" TEXT,
    FOREIGN KEY ("targetUserId") REFERENCES "ForumUser" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    FOREIGN KEY ("postId") REFERENCES "ForumPost" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PublishLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "screenshotPath" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY ("taskId") REFERENCES "InterventionTask" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AgentRun_courseId_idx" ON "AgentRun"("courseId" ASC);

-- CreateIndex
CREATE INDEX "AgentRun_postId_idx" ON "AgentRun"("postId" ASC);

-- CreateIndex
CREATE INDEX "AgentRun_taskId_idx" ON "AgentRun"("taskId" ASC);

-- CreateIndex
CREATE INDEX "AutoInterventionCandidate_courseId_idx" ON "AutoInterventionCandidate"("courseId" ASC);

-- CreateIndex
CREATE INDEX "AutoInterventionCandidate_status_idx" ON "AutoInterventionCandidate"("status" ASC);

-- CreateIndex
CREATE INDEX "AutoInterventionCandidate_postUrl_idx" ON "AutoInterventionCandidate"("postUrl" ASC);

-- CreateIndex
CREATE INDEX "AutoInterventionCandidate_postId_idx" ON "AutoInterventionCandidate"("postId" ASC);

-- CreateIndex
CREATE INDEX "AutoInterventionCandidate_runId_idx" ON "AutoInterventionCandidate"("runId" ASC);

-- CreateIndex
CREATE INDEX "AutoInterventionRun_courseId_idx" ON "AutoInterventionRun"("courseId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CommunityMetric_courseId_date_key" ON "CommunityMetric"("courseId" ASC, "date" ASC);

-- CreateIndex
CREATE INDEX "CommunityMetric_courseId_idx" ON "CommunityMetric"("courseId" ASC);

-- CreateIndex
CREATE INDEX "CommunityMetric_date_idx" ON "CommunityMetric"("date" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CompanionProfile_type_key" ON "CompanionProfile"("type" ASC);

-- CreateIndex
CREATE INDEX "Course_lastSyncedAt_idx" ON "Course"("lastSyncedAt" ASC);

-- CreateIndex
CREATE INDEX "Course_status_idx" ON "Course"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "Course_platformCourseId_key" ON "Course"("platformCourseId" ASC);

-- CreateIndex
CREATE INDEX "CourseMembership_personaType_idx" ON "CourseMembership"("personaType" ASC);

-- CreateIndex
CREATE INDEX "CourseMembership_forumUserId_idx" ON "CourseMembership"("forumUserId" ASC);

-- CreateIndex
CREATE INDEX "CourseMembership_userId_idx" ON "CourseMembership"("userId" ASC);

-- CreateIndex
CREATE INDEX "CourseMembership_courseId_idx" ON "CourseMembership"("courseId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "CourseMembership_courseId_userId_key" ON "CourseMembership"("courseId" ASC, "userId" ASC);

-- CreateIndex
CREATE INDEX "ForumIngestionRun_courseId_idx" ON "ForumIngestionRun"("courseId" ASC);

-- CreateIndex
CREATE INDEX "ForumIngestionRun_createdAt_idx" ON "ForumIngestionRun"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "ForumIngestionRun_status_idx" ON "ForumIngestionRun"("status" ASC);

-- CreateIndex
CREATE INDEX "ForumIngestionRun_sourceUrl_idx" ON "ForumIngestionRun"("sourceUrl" ASC);

-- CreateIndex
CREATE INDEX "ForumPost_courseId_idx" ON "ForumPost"("courseId" ASC);

-- CreateIndex
CREATE INDEX "ForumPost_authorId_idx" ON "ForumPost"("authorId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ForumPost_forumPostId_key" ON "ForumPost"("forumPostId" ASC);

-- CreateIndex
CREATE INDEX "ForumPostSnapshot_courseId_idx" ON "ForumPostSnapshot"("courseId" ASC);

-- CreateIndex
CREATE INDEX "ForumPostSnapshot_columnId_idx" ON "ForumPostSnapshot"("columnId" ASC);

-- CreateIndex
CREATE INDEX "ForumPostSnapshot_createdAt_idx" ON "ForumPostSnapshot"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "ForumPostSnapshot_forumPostId_idx" ON "ForumPostSnapshot"("forumPostId" ASC);

-- CreateIndex
CREATE INDEX "ForumPostSnapshot_postId_idx" ON "ForumPostSnapshot"("postId" ASC);

-- CreateIndex
CREATE INDEX "ForumPostSnapshot_runId_idx" ON "ForumPostSnapshot"("runId" ASC);

-- CreateIndex
CREATE INDEX "ForumReply_courseId_idx" ON "ForumReply"("courseId" ASC);

-- CreateIndex
CREATE INDEX "ForumReply_depth_idx" ON "ForumReply"("depth" ASC);

-- CreateIndex
CREATE INDEX "ForumReply_parentPlatformReplyId_idx" ON "ForumReply"("parentPlatformReplyId" ASC);

-- CreateIndex
CREATE INDEX "ForumReply_platformReplyId_idx" ON "ForumReply"("platformReplyId" ASC);

-- CreateIndex
CREATE INDEX "ForumReply_targetUserId_idx" ON "ForumReply"("targetUserId" ASC);

-- CreateIndex
CREATE INDEX "ForumReply_authorId_idx" ON "ForumReply"("authorId" ASC);

-- CreateIndex
CREATE INDEX "ForumReply_postId_idx" ON "ForumReply"("postId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ForumReply_forumReplyId_key" ON "ForumReply"("forumReplyId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ForumUser_forumUserId_key" ON "ForumUser"("forumUserId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserCourseProfile_generatedAt_idx" ON "ForumUserCourseProfile"("generatedAt" ASC);

-- CreateIndex
CREATE INDEX "ForumUserCourseProfile_personaType_idx" ON "ForumUserCourseProfile"("personaType" ASC);

-- CreateIndex
CREATE INDEX "ForumUserCourseProfile_sourceRunId_idx" ON "ForumUserCourseProfile"("sourceRunId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserCourseProfile_forumUserId_idx" ON "ForumUserCourseProfile"("forumUserId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserCourseProfile_userId_idx" ON "ForumUserCourseProfile"("userId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserCourseProfile_courseId_idx" ON "ForumUserCourseProfile"("courseId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ForumUserCourseProfile_courseId_userId_key" ON "ForumUserCourseProfile"("courseId" ASC, "userId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserProfile_generatedAt_idx" ON "ForumUserProfile"("generatedAt" ASC);

-- CreateIndex
CREATE INDEX "ForumUserProfile_personaType_idx" ON "ForumUserProfile"("personaType" ASC);

-- CreateIndex
CREATE INDEX "ForumUserProfile_sourceRunId_idx" ON "ForumUserProfile"("sourceRunId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserProfile_forumUserId_idx" ON "ForumUserProfile"("forumUserId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ForumUserProfile_userId_key" ON "ForumUserProfile"("userId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserSnapshot_courseId_idx" ON "ForumUserSnapshot"("courseId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserSnapshot_createdAt_idx" ON "ForumUserSnapshot"("createdAt" ASC);

-- CreateIndex
CREATE INDEX "ForumUserSnapshot_forumUserId_idx" ON "ForumUserSnapshot"("forumUserId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserSnapshot_userId_idx" ON "ForumUserSnapshot"("userId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserSnapshot_runId_idx" ON "ForumUserSnapshot"("runId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserUtteranceAnalysis_courseId_idx" ON "ForumUserUtteranceAnalysis"("courseId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserUtteranceAnalysis_sourceCreatedAt_idx" ON "ForumUserUtteranceAnalysis"("sourceCreatedAt" ASC);

-- CreateIndex
CREATE INDEX "ForumUserUtteranceAnalysis_iamPhase_idx" ON "ForumUserUtteranceAnalysis"("iamPhase" ASC);

-- CreateIndex
CREATE INDEX "ForumUserUtteranceAnalysis_cieLevel_idx" ON "ForumUserUtteranceAnalysis"("cieLevel" ASC);

-- CreateIndex
CREATE INDEX "ForumUserUtteranceAnalysis_utteranceType_idx" ON "ForumUserUtteranceAnalysis"("utteranceType" ASC);

-- CreateIndex
CREATE INDEX "ForumUserUtteranceAnalysis_sourceRunId_idx" ON "ForumUserUtteranceAnalysis"("sourceRunId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserUtteranceAnalysis_replyId_idx" ON "ForumUserUtteranceAnalysis"("replyId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserUtteranceAnalysis_postId_idx" ON "ForumUserUtteranceAnalysis"("postId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserUtteranceAnalysis_forumUserId_idx" ON "ForumUserUtteranceAnalysis"("forumUserId" ASC);

-- CreateIndex
CREATE INDEX "ForumUserUtteranceAnalysis_userId_idx" ON "ForumUserUtteranceAnalysis"("userId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "ForumUserUtteranceAnalysis_utteranceKey_key" ON "ForumUserUtteranceAnalysis"("utteranceKey" ASC);

-- CreateIndex
CREATE INDEX "InteractionAnalysis_courseId_idx" ON "InteractionAnalysis"("courseId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "InteractionAnalysis_postId_key" ON "InteractionAnalysis"("postId" ASC);

-- CreateIndex
CREATE INDEX "InterventionTask_courseId_idx" ON "InterventionTask"("courseId" ASC);

-- CreateIndex
CREATE INDEX "InterventionTask_status_idx" ON "InterventionTask"("status" ASC);

-- CreateIndex
CREATE INDEX "InterventionTask_targetUserId_idx" ON "InterventionTask"("targetUserId" ASC);

-- CreateIndex
CREATE INDEX "InterventionTask_postId_idx" ON "InterventionTask"("postId" ASC);

-- CreateIndex
CREATE INDEX "PublishLog_taskId_idx" ON "PublishLog"("taskId" ASC);
