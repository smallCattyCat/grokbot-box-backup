ALTER TABLE "ForumPost" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "ForumReply" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "ForumUserUtteranceAnalysis" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'unknown';

UPDATE "ForumPost"
SET "sourceKind" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "ForumUser" AS "author"
    WHERE "author"."id" = "ForumPost"."authorId"
      AND (LOWER(COALESCE("author"."role", '')) LIKE '%companion%'
        OR LOWER(COALESCE("author"."role", '')) LIKE '%assistant%'
        OR COALESCE("author"."role", '') LIKE '%学伴%')
  ) THEN 'companion'
  WHEN EXISTS (
    SELECT 1 FROM "ForumUser" AS "author"
    WHERE "author"."id" = "ForumPost"."authorId"
      AND (LOWER(COALESCE("author"."role", '')) LIKE '%scanner%'
        OR LOWER(COALESCE("author"."role", '')) LIKE '%system%'
        OR "author"."forumUserId" = 'real-forum-scanner')
  ) THEN 'system'
  WHEN LOWER(COALESCE("url", '')) LIKE '/mock-forum%'
    OR EXISTS (
      SELECT 1 FROM "ForumUser" AS "author"
      WHERE "author"."id" = "ForumPost"."authorId"
        AND (LOWER(COALESCE("author"."role", '')) = 'test'
          OR LOWER(COALESCE("author"."tagsJson", '')) LIKE '%"fixture"%'
          OR LOWER(COALESCE("author"."tagsJson", '')) LIKE '%"test"%')
    ) THEN 'test'
  WHEN EXISTS (
    SELECT 1 FROM "ForumUser" AS "author"
    WHERE "author"."id" = "ForumPost"."authorId"
      AND LOWER(COALESCE("author"."role", '')) = 'learner'
  ) THEN 'learner'
  ELSE 'unknown'
END;

UPDATE "ForumReply"
SET "sourceKind" = CASE
  WHEN "isCompanionReply" = 1 OR "companionType" IS NOT NULL OR EXISTS (
    SELECT 1 FROM "ForumUser" AS "author"
    WHERE "author"."id" = "ForumReply"."authorId"
      AND (LOWER(COALESCE("author"."role", '')) LIKE '%companion%'
        OR LOWER(COALESCE("author"."role", '')) LIKE '%assistant%'
        OR COALESCE("author"."role", '') LIKE '%学伴%')
  ) THEN 'companion'
  WHEN EXISTS (
    SELECT 1 FROM "ForumUser" AS "author"
    WHERE "author"."id" = "ForumReply"."authorId"
      AND (LOWER(COALESCE("author"."role", '')) LIKE '%scanner%'
        OR LOWER(COALESCE("author"."role", '')) LIKE '%system%'
        OR "author"."forumUserId" = 'real-forum-scanner')
  ) THEN 'system'
  WHEN EXISTS (
    SELECT 1 FROM "ForumPost" AS "post"
    WHERE "post"."id" = "ForumReply"."postId" AND "post"."sourceKind" = 'test'
  ) OR EXISTS (
    SELECT 1 FROM "ForumUser" AS "author"
    WHERE "author"."id" = "ForumReply"."authorId"
      AND (LOWER(COALESCE("author"."role", '')) = 'test'
        OR LOWER(COALESCE("author"."tagsJson", '')) LIKE '%"fixture"%'
        OR LOWER(COALESCE("author"."tagsJson", '')) LIKE '%"test"%')
  ) THEN 'test'
  WHEN EXISTS (
    SELECT 1 FROM "ForumUser" AS "author"
    WHERE "author"."id" = "ForumReply"."authorId"
      AND LOWER(COALESCE("author"."role", '')) = 'learner'
  ) THEN 'learner'
  ELSE 'unknown'
END;

UPDATE "ForumUserUtteranceAnalysis"
SET "sourceKind" = CASE
  WHEN "replyId" IS NOT NULL THEN COALESCE(
    (SELECT "reply"."sourceKind" FROM "ForumReply" AS "reply" WHERE "reply"."id" = "ForumUserUtteranceAnalysis"."replyId"),
    'unknown'
  )
  WHEN "postId" IS NOT NULL THEN COALESCE(
    (SELECT "post"."sourceKind" FROM "ForumPost" AS "post" WHERE "post"."id" = "ForumUserUtteranceAnalysis"."postId"),
    'unknown'
  )
  ELSE 'unknown'
END;

CREATE INDEX "ForumPost_sourceKind_idx" ON "ForumPost"("sourceKind");
CREATE INDEX "ForumReply_sourceKind_idx" ON "ForumReply"("sourceKind");
CREATE INDEX "ForumUserUtteranceAnalysis_sourceKind_idx" ON "ForumUserUtteranceAnalysis"("sourceKind");
