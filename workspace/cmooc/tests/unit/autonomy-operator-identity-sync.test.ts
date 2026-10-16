import assert from "node:assert/strict";
import test from "node:test";
import {
  syncOperatorCourseIdentities
} from "../../lib/autonomy/operator-identity-sync";

test("operator identity sync writes forum display names into the existing course membership directory", async () => {
  const forumUserWrites: unknown[] = [];
  const membershipWrites: unknown[] = [];
  const result = await syncOperatorCourseIdentities({
    prisma: {
      course: {
        findUnique: async () => ({ id: "course-row" })
      },
      forumUser: {
        upsert: async (input) => {
          forumUserWrites.push(input);
          return { id: `user-row-${forumUserWrites.length}` };
        }
      },
      courseMembership: {
        upsert: async (input) => {
          membershipWrites.push(input);
          return { id: `membership-${membershipWrites.length}` };
        }
      }
    },
    platformCourseId: "course-platform-ref",
    observedAt: "2026-08-13T12:00:00.000Z",
    identities: [
      {
        actorKey: "a".repeat(64),
        platformAccountId: "member-27",
        displayName: "张同学",
        memberType: "LEARNER",
        source: "reply_author"
      }
    ]
  });

  assert.deepEqual(result, {
    courseFound: true,
    observedIdentityCount: 1,
    syncedIdentityCount: 1
  });
  assert.equal(forumUserWrites.length, 1);
  assert.equal(membershipWrites.length, 1);
  assert.deepEqual(
    (forumUserWrites[0] as { where: unknown }).where,
    { forumUserId: "real-user-id-member-27" }
  );
  assert.equal(
    (forumUserWrites[0] as { update: { name: string } }).update.name,
    "张同学"
  );
  assert.equal(
    (membershipWrites[0] as { update: { displayName: string } }).update.displayName,
    "张同学"
  );
  assert.equal(
    JSON.stringify(membershipWrites).includes("member-27"),
    true
  );
  assert.equal(
    JSON.stringify(membershipWrites).includes("forum body"),
    false
  );
});

test("operator identity sync does nothing when the operational course row is absent", async () => {
  let writeCount = 0;
  const result = await syncOperatorCourseIdentities({
    prisma: {
      course: {
        findUnique: async () => null
      },
      forumUser: {
        upsert: async () => {
          writeCount += 1;
          return { id: "unexpected" };
        }
      },
      courseMembership: {
        upsert: async () => {
          writeCount += 1;
          return { id: "unexpected" };
        }
      }
    },
    platformCourseId: "course-platform-ref",
    observedAt: "2026-08-13T12:00:00.000Z",
    identities: []
  });

  assert.deepEqual(result, {
    courseFound: false,
    observedIdentityCount: 0,
    syncedIdentityCount: 0
  });
  assert.equal(writeCount, 0);
});
