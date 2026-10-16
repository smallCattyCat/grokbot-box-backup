ALTER TABLE "CourseEventObservation"
ADD COLUMN "targetVersionHash" TEXT;

ALTER TABLE "CourseEventObservation"
ADD COLUMN "revisionKind" TEXT NOT NULL DEFAULT 'legacy_observation';

UPDATE "CourseEventObservation"
SET "targetVersionHash" = (
  SELECT "CourseEvent"."targetVersionHash"
  FROM "CourseEvent"
  WHERE "CourseEvent"."eventKey" = "CourseEventObservation"."eventKey"
)
WHERE "targetVersionHash" IS NULL;
