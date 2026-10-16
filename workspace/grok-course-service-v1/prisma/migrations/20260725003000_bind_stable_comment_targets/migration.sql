-- Reply-by-position is not a stable authorization target: another comment can
-- be inserted before the selected index between review and publish. Persist a
-- platform reply id and the reviewed comment-content fingerprint instead.
ALTER TABLE "InterventionTask" ADD COLUMN "targetPlatformReplyId" TEXT;
ALTER TABLE "InterventionTask" ADD COLUMN "targetCommentContentHash" TEXT;
ALTER TABLE "InterventionTask" ADD COLUMN "targetCommentPreview" TEXT;

CREATE INDEX "InterventionTask_targetPlatformReplyId_idx"
  ON "InterventionTask"("targetPlatformReplyId");

-- Old reply targets have no stable identity and must be prepared and reviewed
-- again. Existing one-shot grants are revoked before any later resolution.
UPDATE "PublishAuthorization"
SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'active'
  AND "taskId" IN (
    SELECT "id" FROM "InterventionTask"
    WHERE "publishTarget" = 'comment_reply'
      AND "status" NOT IN ('published', 'skipped')
  );

UPDATE "InterventionTask"
SET
  "status" = 'review_required',
  "contentHash" = NULL,
  "targetHash" = NULL,
  "safetyCheckedAt" = NULL,
  "errorMessage" = '历史评论目标缺少稳定平台标识，请重新生成并审阅。'
WHERE "publishTarget" = 'comment_reply'
  AND "status" IN ('proposed', 'review_required', 'ready');

-- Legacy `failed` rows were migrated without enough evidence to know whether
-- the remote side effect happened. Treat those pre-fingerprint rows as
-- outcome-unknown instead of making them retryable.
UPDATE "InterventionTask"
SET
  "status" = 'reconcile_required',
  "errorMessage" = COALESCE(
    "errorMessage",
    '历史发布失败记录无法证明远端未写入，请先人工核对。'
  )
WHERE "status" = 'failed_retryable'
  AND "safetyCheckedAt" IS NULL;

-- Keep historical duplicates as evidence. Unknown remote outcomes take
-- precedence over newer draft plans and are never silently archived. If one
-- post somehow contains multiple unknown outcomes, the unique-index creation
-- below intentionally stops the migration for explicit human reconciliation.
UPDATE "PublishAuthorization"
SET "status" = 'revoked', "revokedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'active'
  AND "taskId" IN (
    SELECT "id" FROM (
      SELECT
        "id",
        "status",
        ROW_NUMBER() OVER (
          PARTITION BY "postId"
          ORDER BY
            CASE
              WHEN "status" IN ('publishing', 'reconcile_required') THEN 0
              ELSE 1
            END,
            "updatedAt" DESC,
            "id" DESC
        ) AS "rowNumber"
      FROM "InterventionTask"
      WHERE "status" IN (
        'proposed',
        'review_required',
        'ready',
        'publishing',
        'failed_retryable',
        'reconcile_required'
      )
    )
    WHERE "rowNumber" > 1
      AND "status" NOT IN ('publishing', 'reconcile_required')
  );

UPDATE "InterventionTask"
SET
  "status" = 'skipped',
  "errorMessage" = '统一计划迁移：同一帖子已有更新的开放计划，本记录保留为历史证据。'
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT
      "id",
      "status",
      ROW_NUMBER() OVER (
        PARTITION BY "postId"
        ORDER BY
          CASE
            WHEN "status" IN ('publishing', 'reconcile_required') THEN 0
            ELSE 1
          END,
          "updatedAt" DESC,
          "id" DESC
      ) AS "rowNumber"
    FROM "InterventionTask"
    WHERE "status" IN (
      'proposed',
      'review_required',
      'ready',
      'publishing',
      'failed_retryable',
      'reconcile_required'
    )
  )
  WHERE "rowNumber" > 1
    AND "status" NOT IN ('publishing', 'reconcile_required')
);

CREATE UNIQUE INDEX "InterventionTask_one_open_plan_per_post_key"
  ON "InterventionTask"("postId")
  WHERE "status" IN (
    'proposed',
    'review_required',
    'ready',
    'publishing',
    'failed_retryable',
    'reconcile_required'
  );
