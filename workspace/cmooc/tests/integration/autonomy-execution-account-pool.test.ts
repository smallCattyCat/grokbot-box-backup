import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  acquire,
  assertExecutionAccountLeaseBinding,
  consume,
  consumeExecutionAccountLeaseInTransaction,
  loadActive,
  release,
  releaseExecutionAccountLeaseInTransaction,
  type ExecutionAccountDescriptor
} from "../../lib/autonomy/execution-account-pool";

const PREFIX = "execution-account-pool";

function hash(label: string): string {
  return createHash("sha256").update(`${PREFIX}:${label}`).digest("hex");
}

function descriptor(
  label: string,
  overrides: Partial<
    Omit<ExecutionAccountDescriptor, "disclosedAi" | "containsForumText">
  > & {
    disclosedAi?: boolean;
    containsForumText?: boolean;
  } = {}
): ExecutionAccountDescriptor {
  return {
    accountRefHash: hash(`account:${label}`),
    credentialRefHash: hash(`credential:${label}`),
    roleKey: "socratic_guide",
    courseAliases: ["account-pool-course"],
    dailyActionLimit: 5,
    cooldownMinutes: 0,
    disclosedAi: true,
    containsForumText: false,
    ...overrides
  } as ExecutionAccountDescriptor;
}

async function createTemporaryPrisma(): Promise<{
  prisma: PrismaClient;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "cmooc-account-pool-"));
  const databaseUrl = `file:${join(directory, "test.db")}`;
  execFileSync(
    process.execPath,
    [
      join(process.cwd(), "node_modules", "prisma", "build", "index.js"),
      "migrate",
      "deploy",
      "--schema",
      "prisma/schema.prisma"
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "ignore"
    }
  );
  return {
    prisma: new PrismaClient({ datasources: { db: { url: databaseUrl } } }),
    directory
  };
}

async function withTemporaryPrisma<T>(
  callback: (prisma: PrismaClient) => Promise<T>
): Promise<T> {
  const { prisma, directory } = await createTemporaryPrisma();
  try {
    return await callback(prisma);
  } finally {
    await prisma.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
}

async function createFixture(
  prisma: PrismaClient,
  index: number,
  now: Date,
  courseAlias = "account-pool-course"
): Promise<{ invocationId: string; decisionId: string }> {
  const invocationId = hash(`invocation:${courseAlias}:${index}`);
  const decisionId = hash(`decision:${courseAlias}:${index}`);
  await prisma.scheduledInvocation.create({
    data: {
      id: invocationId,
      invocationKey: hash(`invocation-key:${courseAlias}:${index}`),
      courseAlias,
      manifestHash: hash(`manifest:${courseAlias}`),
      scheduledFor: new Date(now.getTime() + index),
      mode: "SHADOW",
      status: "completed",
      phase: "completed",
      attempt: 1,
      startedAt: now,
      finishedAt: now,
      summaryJson: JSON.stringify({ containsForumText: false })
    }
  });
  await prisma.autonomyDecision.create({
    data: {
      id: decisionId,
      invocationId,
      courseAlias,
      decisionKey: hash(`decision-key:${courseAlias}:${index}`),
      threadKey: hash(`thread:${courseAlias}:${index}`),
      authorKey: hash(`author:${courseAlias}:${index}`),
      decision: "draft",
      decisionMode: "DRAFT_ELIGIBLE",
      reasonCode: "synthetic_fixture",
      observationReceiptHash: hash(`observation:${courseAlias}:${index}`),
      opportunityReceiptHash: hash(`opportunity:${courseAlias}:${index}`),
      evidenceBundleHash: hash(`evidence:${courseAlias}:${index}`),
      policyVersion: "account-pool.test.v1",
      worldHash: hash(`world:${courseAlias}:${index}`),
      candidateSetHash: hash(`candidates:${courseAlias}:${index}`),
      evidenceAsOf: now,
      decisionJson: JSON.stringify({ containsForumText: false }),
      bodyPersisted: false,
      publishAttempted: false,
      editorWriteAttempted: false
    }
  });
  return { invocationId, decisionId };
}

async function createManifest(
  prisma: PrismaClient,
  courseAlias = "account-pool-course"
): Promise<void> {
  await prisma.autonomyCourseManifest.create({
    data: {
      alias: courseAlias,
      manifestHash: hash(`manifest:${courseAlias}`),
      platformId: "synthetic.platform",
      platformCourseRefHash: hash(`course-ref:${courseAlias}`),
      canonicalLocatorHash: hash(`locator:${courseAlias}`),
      identityKeyFingerprint: hash(`identity:${courseAlias}`),
      allowedOrigin: "https://synthetic.example.test",
      timeZone: "Asia/Shanghai",
      defaultMode: "SHADOW",
      policyVersion: "account-pool.test.v1",
      enabled: true,
      realPublishEnabled: false
    }
  });
}

test("账号池校验课程 scope、披露 AI 与安全序列化边界", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const now = new Date("2026-08-10T02:00:00.000Z");
    await createManifest(prisma);
    const fixture = await createFixture(prisma, 0, now);

    await assert.rejects(
      () =>
        acquire({
          prisma,
          courseAlias: "account-pool-course",
          invocationId: fixture.invocationId,
          decisionId: fixture.decisionId,
          accounts: [descriptor("wrong-scope", { courseAliases: ["other"] })],
          now
        }),
      /EXECUTION_ACCOUNT_COURSE_SCOPE_INVALID/
    );
    await assert.rejects(
      () =>
        acquire({
          prisma,
          courseAlias: "account-pool-course",
          invocationId: fixture.invocationId,
          decisionId: fixture.decisionId,
          accounts: [descriptor("not-disclosed", { disclosedAi: false })],
          now
        }),
      /EXECUTION_ACCOUNT_DISCLOSURE_REQUIRED/
    );

    const selected = await acquire({
      prisma,
      courseAlias: "account-pool-course",
      invocationId: fixture.invocationId,
      decisionId: fixture.decisionId,
      accounts: [descriptor("safe")],
      now
    });
    assert.equal(selected.containsForumText, false);
    await assert.rejects(
      () =>
        acquire({
          prisma,
          courseAlias: "account-pool-course",
          invocationId: fixture.invocationId,
          decisionId: fixture.decisionId,
          accounts: [
            descriptor("safe", {
              credentialRefHash: hash("credential:drifted")
            })
          ],
          now: new Date(now.getTime() + 1_000)
        }),
      /EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH/
    );
    const serialized = JSON.stringify(selected);
    assert.doesNotMatch(serialized, /cookie|token|body|url|path|username/i);
    assert.doesNotMatch(serialized, /TRANSIENT_EXECUTION_BODY|secret-token/i);
  });
});

test("账号池按最少使用与稳定 hash tie-break 选择，并尊重 cooldown", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const now = new Date("2026-08-10T03:00:00.000Z");
    await createManifest(prisma);
    const first = await createFixture(prisma, 1, now);
    const second = await createFixture(prisma, 2, now);
    const third = await createFixture(prisma, 3, now);
    const a = descriptor("a");
    const b = descriptor("b");
    const ordered = [a, b].sort((left, right) =>
      left.accountRefHash.localeCompare(right.accountRefHash)
    );

    const firstLease = await acquire({
      prisma,
      courseAlias: "account-pool-course",
      invocationId: first.invocationId,
      decisionId: first.decisionId,
      accounts: [a, b],
      now
    });
    assert.equal(firstLease.accountRefHash, ordered[0].accountRefHash);
    await consume({ prisma, leaseKey: firstLease.leaseKey, now });

    const secondLease = await acquire({
      prisma,
      courseAlias: "account-pool-course",
      invocationId: second.invocationId,
      decisionId: second.decisionId,
      accounts: [a, b],
      now: new Date(now.getTime() + 1_000)
    });
    assert.equal(secondLease.accountRefHash, ordered[1].accountRefHash);
    await consume({
      prisma,
      leaseKey: secondLease.leaseKey,
      now
    });

    const tieLease = await acquire({
      prisma,
      courseAlias: "account-pool-course",
      invocationId: third.invocationId,
      decisionId: third.decisionId,
      accounts: [b, a],
      now: new Date(now.getTime() + 2_000)
    });
    assert.equal(tieLease.accountRefHash, ordered[0].accountRefHash);
    await consume({
      prisma,
      leaseKey: tieLease.leaseKey,
      now: new Date(now.getTime() + 2_000)
    });

    const cooldownAlias = "account-pool-cooldown";
    await createManifest(prisma, cooldownAlias);
    const cooldownDescriptor = descriptor("cooldown", {
      courseAliases: [cooldownAlias],
      cooldownMinutes: 60
    });
    const cooldownFirst = await createFixture(prisma, 10, now, cooldownAlias);
    const cooldownSecond = await createFixture(
      prisma,
      11,
      now,
      cooldownAlias
    );
    const cooldownLease = await acquire({
      prisma,
      courseAlias: cooldownAlias,
      invocationId: cooldownFirst.invocationId,
      decisionId: cooldownFirst.decisionId,
      accounts: [cooldownDescriptor],
      now
    });
    await consume({ prisma, leaseKey: cooldownLease.leaseKey, now });
    await assert.rejects(
      () =>
        acquire({
          prisma,
          courseAlias: cooldownAlias,
          invocationId: cooldownSecond.invocationId,
          decisionId: cooldownSecond.decisionId,
          accounts: [cooldownDescriptor],
          now: new Date(now.getTime() + 30 * 60_000)
        }),
      /EXECUTION_ACCOUNT_COOLDOWN_ACTIVE/
    );
    const afterCooldown = await acquire({
      prisma,
      courseAlias: cooldownAlias,
      invocationId: cooldownSecond.invocationId,
      decisionId: cooldownSecond.decisionId,
      accounts: [cooldownDescriptor],
      now: new Date(now.getTime() + 60 * 60_000)
    });
    assert.equal(afterCooldown.accountRefHash, cooldownDescriptor.accountRefHash);
  });
});

test("同一账号并发最多一条 active，日额五次后第六次拒绝", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const now = new Date("2026-08-10T04:00:00.000Z");
    await createManifest(prisma);
    const account = descriptor("concurrent");
    const concurrentFixtures = await Promise.all([
      createFixture(prisma, 20, now),
      createFixture(prisma, 21, now)
    ]);
    const raced = await Promise.allSettled(
      concurrentFixtures.map((fixture) =>
        acquire({
          prisma,
          courseAlias: "account-pool-course",
          invocationId: fixture.invocationId,
          decisionId: fixture.decisionId,
          accounts: [account],
          now
        })
      )
    );
    assert.equal(raced.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(
      await prisma.executionAccountLease.count({
        where: { accountRefHash: account.accountRefHash, status: "active" }
      }),
      1
    );
    const winner = raced.find(
      (item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof acquire>>> =>
        item.status === "fulfilled"
    )?.value;
    assert.ok(winner);
    await release({ prisma, leaseKey: winner.leaseKey, now });

    for (let index = 0; index < 5; index += 1) {
      const fixture = await createFixture(prisma, 30 + index, now);
      const lease = await acquire({
        prisma,
        courseAlias: "account-pool-course",
        invocationId: fixture.invocationId,
        decisionId: fixture.decisionId,
        accounts: [account],
        now: new Date(now.getTime() + index * 1_000)
      });
      await consume({
        prisma,
        leaseKey: lease.leaseKey,
        now: new Date(now.getTime() + index * 1_000)
      });
    }
    const sixth = await createFixture(prisma, 40, now);
    await assert.rejects(
      () =>
        acquire({
          prisma,
          courseAlias: "account-pool-course",
          invocationId: sixth.invocationId,
          decisionId: sixth.decisionId,
          accounts: [account],
          now: new Date(now.getTime() + 10_000)
        }),
      /EXECUTION_ACCOUNT_DAILY_LIMIT_EXCEEDED/
    );
  });
});

test("过期租约回收，consume/release CAS 幂等且冲突稳定", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const now = new Date("2026-08-10T05:00:00.000Z");
    await createManifest(prisma);
    const account = descriptor("transitions");
    const expiredFixture = await createFixture(prisma, 50, now);
    const expiredLease = await acquire({
      prisma,
      courseAlias: "account-pool-course",
      invocationId: expiredFixture.invocationId,
      decisionId: expiredFixture.decisionId,
      accounts: [account],
      now,
      validForMinutes: 1
    });
    const activeFixture = await createFixture(prisma, 51, now);
    const activeLease = await acquire({
      prisma,
      courseAlias: "account-pool-course",
      invocationId: activeFixture.invocationId,
      decisionId: activeFixture.decisionId,
      accounts: [account],
      now: new Date(now.getTime() + 61_000)
    });
    assert.equal(
      (await prisma.executionAccountLease.findUniqueOrThrow({
        where: { leaseKey: expiredLease.leaseKey }
      })).status,
      "expired"
    );
    assert.equal(
      (await loadActive({
        prisma,
        leaseKey: activeLease.leaseKey,
        now: new Date(now.getTime() + 61_000)
      }))?.leaseKey,
      activeLease.leaseKey
    );

    const consumed = await consume({
      prisma,
      leaseKey: activeLease.leaseKey,
      now: new Date(now.getTime() + 62_000)
    });
    assert.equal(consumed.status, "consumed");
    assert.equal(
      (
        await consume({
          prisma,
          leaseKey: activeLease.leaseKey,
          now: new Date(now.getTime() + 63_000)
        })
      ).idempotent,
      true
    );
    await assert.rejects(
      () =>
        release({
          prisma,
          leaseKey: activeLease.leaseKey,
          now: new Date(now.getTime() + 64_000)
        }),
      /EXECUTION_ACCOUNT_LEASE_ALREADY_CONSUMED/
    );
    assert.equal(
      await loadActive({
        prisma,
        leaseKey: activeLease.leaseKey,
        now: new Date(now.getTime() + 64_000)
      }),
      null
    );

    const releaseFixture = await createFixture(prisma, 52, now);
    const releaseLease = await acquire({
      prisma,
      courseAlias: "account-pool-course",
      invocationId: releaseFixture.invocationId,
      decisionId: releaseFixture.decisionId,
      accounts: [descriptor("release")],
      now
    });
    const released = await release({
      prisma,
      leaseKey: releaseLease.leaseKey,
      now
    });
    assert.equal(released.status, "released");
    assert.equal(
      (
        await release({
          prisma,
          leaseKey: releaseLease.leaseKey,
          now: new Date(now.getTime() + 1_000)
        })
      ).idempotent,
      true
    );
    await assert.rejects(
      () =>
        consume({
          prisma,
          leaseKey: releaseLease.leaseKey,
          now: new Date(now.getTime() + 2_000)
        }),
      /EXECUTION_ACCOUNT_LEASE_ALREADY_RELEASED/
    );
  });
});

test("事务租约绑定严格校验 scope/ref/status，并以 CAS consume/release", async () => {
  await withTemporaryPrisma(async (prisma) => {
    const now = new Date("2026-08-10T06:00:00.000Z");
    await createManifest(prisma);
    const fixture = await createFixture(prisma, 60, now);
    const account = descriptor("strict-tx");
    const lease = await acquire({
      prisma,
      courseAlias: "account-pool-course",
      invocationId: fixture.invocationId,
      decisionId: fixture.decisionId,
      accounts: [account],
      now
    });
    const strictInput = {
      executionAccountLeaseId: lease.leaseId,
      accountRefHash: lease.accountRefHash,
      credentialRefHash: lease.credentialRefHash,
      decisionId: fixture.decisionId,
      invocationId: fixture.invocationId,
      courseAlias: "account-pool-course",
      now
    } as const;
    const loaded = await prisma.$transaction((transaction) =>
      assertExecutionAccountLeaseBinding({
        prisma: transaction,
        ...strictInput
      })
    );
    assert.equal(loaded.status, "active");
    await assert.rejects(
      () =>
        prisma.$transaction((transaction) =>
          assertExecutionAccountLeaseBinding({
            prisma: transaction,
            ...strictInput,
            credentialRefHash: hash("credential:wrong")
          })
        ),
      /EXECUTION_ACCOUNT_LEASE_BINDING_MISMATCH/
    );
    const consumed = await prisma.$transaction((transaction) =>
      consumeExecutionAccountLeaseInTransaction({
        prisma: transaction,
        ...strictInput,
        now: new Date(now.getTime() + 1_000)
      })
    );
    assert.equal(consumed.status, "consumed");
    await assert.rejects(
      () =>
        prisma.$transaction((transaction) =>
          releaseExecutionAccountLeaseInTransaction({
            prisma: transaction,
            ...strictInput,
            now: new Date(now.getTime() + 2_000)
          })
        ),
      /EXECUTION_ACCOUNT_LEASE_ALREADY_CONSUMED/
    );
  });
});
