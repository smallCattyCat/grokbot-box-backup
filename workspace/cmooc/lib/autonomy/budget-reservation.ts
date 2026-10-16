import type {
  AutonomyDecision,
  BudgetReservation,
  Prisma,
  PrismaClient,
  ScheduledInvocation
} from "@prisma/client";
import { canonicalProtocolHash } from "@/lib/facilitation-protocol";
import type { VerifiedAutonomyPolicy } from "./autonomy-policy";

export const BUDGET_RESERVATION_SCHEMA_VERSION =
  "cmooc.budget-reservation.v1" as const;

type PrismaLike = Prisma.TransactionClient | PrismaClient;

export type DecisionBudgetEvidence = {
  availableSlots: number;
  workloadCost: number;
  authorTouchLimit30d: number;
};

export type BudgetUsage = {
  budgetDate: string;
  dayStart: Date;
  dayEnd: Date;
  reservedUnitsToday: number;
  consumedUnitsToday: number;
  reservedUnitsThisInvocation: number;
  consumedUnitsThisInvocation: number;
  authorTouches30d: number | null;
  /**
   * Latest confirmed remote publication for this author at or before the
   * requested as-of time. SHADOW decisions and editor staging are deliberately
   * excluded: they are not a learner-facing system touch.
   */
  lastSystemTouchAt: Date | null;
};

function safePositiveInteger(
  value: unknown,
  label: string,
  max = 10_000
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(`${label}必须是正整数。`);
  }
  return value;
}

function safeNonnegativeInteger(
  value: unknown,
  label: string,
  max = 10_000
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  ) {
    throw new Error(`${label}必须是非负整数。`);
  }
  return value;
}

function jsonRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象。`);
  }
  return value as Record<string, unknown>;
}

export function parseDecisionBudgetEvidence(
  decision: Pick<AutonomyDecision, "decisionJson">
): DecisionBudgetEvidence {
  let raw: unknown;
  try {
    raw = JSON.parse(decision.decisionJson) as unknown;
  } catch {
    throw new Error("BUDGET_DECISION_EVIDENCE_INVALID_JSON");
  }
  const summary = jsonRecord(raw, "决定摘要");
  const budget = jsonRecord(summary.budget, "决定预算证据");
  return {
    availableSlots: safeNonnegativeInteger(
      budget.availableSlots,
      "决定可用预算"
    ),
    workloadCost: safePositiveInteger(
      budget.workloadCost,
      "决定工作量成本"
    ),
    authorTouchLimit30d: safePositiveInteger(
      budget.authorTouchLimit30d,
      "决定作者触达上限"
    )
  };
}

export function computeBudgetReservationKey(input: {
  decisionId: string;
  invocationId: string;
  courseAlias: string;
  policyHash: string;
  workloadCost: number;
}): string {
  return canonicalProtocolHash(
    BUDGET_RESERVATION_SCHEMA_VERSION,
    {
      schemaVersion: BUDGET_RESERVATION_SCHEMA_VERSION,
      decisionId: input.decisionId,
      invocationId: input.invocationId,
      courseAlias: input.courseAlias,
      policyHash: input.policyHash,
      workloadCost: input.workloadCost,
      containsForumText: false
    }
  );
}

function shanghaiDay(value: Date): {
  budgetDate: string;
  dayStart: Date;
  dayEnd: Date;
} {
  const budgetDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value);
  const dayStart = new Date(`${budgetDate}T00:00:00+08:00`);
  return {
    budgetDate,
    dayStart,
    dayEnd: new Date(dayStart.getTime() + 24 * 60 * 60_000)
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export async function readBudgetUsage(input: {
  prisma: PrismaLike;
  courseAlias: string;
  invocationId: string;
  authorKey: string | null;
  now: Date;
  legacyWorkloadCost: number;
}): Promise<BudgetUsage> {
  const day = shanghaiDay(input.now);
  const thirtyDaysAgo = new Date(
    input.now.getTime() - 30 * 24 * 60 * 60_000
  );
  const activeReservations =
    await input.prisma.budgetReservation.findMany({
      where: {
        courseAlias: input.courseAlias,
        status: "active",
        expiresAt: { gt: input.now }
      },
      select: {
        decisionId: true,
        invocationId: true,
        authorKey: true,
        workloadCost: true,
        createdAt: true
      }
    });
  const consumedReservations =
    await input.prisma.budgetReservation.findMany({
      where: {
        courseAlias: input.courseAlias,
        status: "consumed",
        consumedAt: {
          gte: day.dayStart,
          lt: day.dayEnd,
          lte: input.now
        }
      },
      select: {
        decisionId: true,
        invocationId: true,
        authorKey: true,
        workloadCost: true,
        consumedAt: true
      }
    });
  const courseDecisionIds = (
    await input.prisma.autonomyDecision.findMany({
      where: {
        courseAlias: input.courseAlias,
        evidenceAsOf: { lte: input.now }
      },
      select: { id: true, invocationId: true, authorKey: true }
    })
  );
  const decisionIds = courseDecisionIds.map(({ id }) => id);
  const confirmedAttempts = decisionIds.length
    ? await input.prisma.executionAttempt.findMany({
        where: {
          decisionId: { in: decisionIds },
          status: "confirmed_published",
          finishedAt: {
            gte: day.dayStart,
            lt: day.dayEnd,
            lte: input.now
          }
        },
        select: { decisionId: true }
      })
    : [];
  const authorDecisionIds =
    input.authorKey === null
      ? []
      : courseDecisionIds
          .filter(
            (decision) =>
              decision.authorKey === input.authorKey
          )
          .map(({ id }) => id);
  const [authorReservations, authorConfirmedAttempts] =
    input.authorKey === null
      ? [[], []]
      : await Promise.all([
          input.prisma.budgetReservation.findMany({
            where: {
              courseAlias: input.courseAlias,
              authorKey: input.authorKey,
              OR: [
                {
                  status: "active",
                  expiresAt: { gt: input.now }
                },
                {
                  status: "consumed",
                  consumedAt: {
                    gte: thirtyDaysAgo,
                    lte: input.now
                  }
                }
              ]
            },
            select: { decisionId: true }
          }),
          authorDecisionIds.length
            ? input.prisma.executionAttempt.findMany({
                where: {
                  decisionId: { in: authorDecisionIds },
                  status: "confirmed_published",
                  finishedAt: {
                    gte: thirtyDaysAgo,
                    lte: input.now
                  }
                },
                select: { decisionId: true, finishedAt: true }
              })
            : Promise.resolve([])
        ]);
  const confirmedDecisionIds = unique(
    confirmedAttempts.map(({ decisionId }) => decisionId)
  );
  const consumedReservationDecisionIds = new Set(
    consumedReservations
      .map(({ decisionId }) => decisionId)
      .filter((value): value is string => value !== null)
  );
  const legacyConfirmedDecisionIds = confirmedDecisionIds.filter(
    (decisionId) => !consumedReservationDecisionIds.has(decisionId)
  );
  const legacyDecisionById = new Map(
    courseDecisionIds.map((decision) => [decision.id, decision])
  );
  const reservedUnitsToday = activeReservations.reduce(
    (sum, reservation) => sum + reservation.workloadCost,
    0
  );
  const consumedUnitsToday =
    consumedReservations.reduce(
      (sum, reservation) => sum + reservation.workloadCost,
      0
    ) +
    legacyConfirmedDecisionIds.length * input.legacyWorkloadCost;
  const reservedUnitsThisInvocation = activeReservations
    .filter(
      (reservation) =>
        reservation.invocationId === input.invocationId
    )
    .reduce(
      (sum, reservation) => sum + reservation.workloadCost,
      0
    );
  const consumedUnitsThisInvocation =
    consumedReservations
      .filter(
        (reservation) =>
          reservation.invocationId === input.invocationId
      )
      .reduce(
        (sum, reservation) => sum + reservation.workloadCost,
        0
      ) +
    legacyConfirmedDecisionIds.filter(
      (decisionId) =>
        legacyDecisionById.get(decisionId)?.invocationId ===
        input.invocationId
    ).length *
      input.legacyWorkloadCost;
  const authorTouches30d =
    input.authorKey === null
      ? null
      : unique([
          ...authorReservations
            .map(({ decisionId }) => decisionId)
            .filter((value): value is string => value !== null),
          ...authorConfirmedAttempts.map(
            ({ decisionId }) => decisionId
          )
        ]).length;
  const lastSystemTouchAt =
    input.authorKey === null
      ? null
      : authorConfirmedAttempts.reduce<Date | null>(
          (latest, attempt) => {
            if (!attempt.finishedAt) return latest;
            return !latest || attempt.finishedAt > latest
              ? attempt.finishedAt
              : latest;
          },
          null
        );
  return {
    ...day,
    reservedUnitsToday,
    consumedUnitsToday,
    reservedUnitsThisInvocation,
    consumedUnitsThisInvocation,
    authorTouches30d,
    lastSystemTouchAt
  };
}

function assertReservationBinding(input: {
  reservation: BudgetReservation;
  decision: AutonomyDecision;
  reservationKey: string;
  workloadCost: number;
}): void {
  if (
    input.reservation.reservationKey !== input.reservationKey ||
    input.reservation.decisionId !== input.decision.id ||
    input.reservation.invocationId !== input.decision.invocationId ||
    input.reservation.courseAlias !== input.decision.courseAlias ||
    input.reservation.authorKey !== input.decision.authorKey ||
    input.reservation.workloadCost !== input.workloadCost
  ) {
    throw new Error("BUDGET_RESERVATION_BINDING_MISMATCH");
  }
}

async function refreshInvocationLedger(input: {
  prisma: PrismaLike;
  decision: AutonomyDecision;
  invocation: ScheduledInvocation;
  usage: BudgetUsage;
  dailyLimit: number;
  authorTouchLimit30d: number;
}): Promise<void> {
  const reservedSlots = input.usage.reservedUnitsToday;
  const consumedSlots = input.usage.consumedUnitsToday;
  const availableSlots = Math.max(
    0,
    input.dailyLimit - reservedSlots - consumedSlots
  );
  const ledgerHash = canonicalProtocolHash(
    "cmooc.scheduling-ledger.v1",
    {
      worldHash: input.decision.worldHash,
      candidateSetHash: input.decision.candidateSetHash,
      budgetDate: input.usage.budgetDate,
      availableSlots,
      reservedSlots,
      consumedSlots,
      authorTouchLimit: input.authorTouchLimit30d
    }
  );
  await input.prisma.schedulingLedger.upsert({
    where: { invocationId: input.invocation.id },
    create: {
      invocationId: input.invocation.id,
      courseAlias: input.decision.courseAlias,
      snapshotHash: input.decision.worldHash,
      candidateSetHash: input.decision.candidateSetHash,
      budgetDate: input.usage.budgetDate,
      availableSlots,
      reservedSlots,
      consumedSlots,
      authorTouchWindowDays: 30,
      authorTouchLimit: input.authorTouchLimit30d,
      reason: "execution_permit_budget_reservation",
      ledgerHash
    },
    update: {
      availableSlots,
      reservedSlots,
      consumedSlots,
      authorTouchLimit: input.authorTouchLimit30d,
      reason: "execution_permit_budget_reservation",
      ledgerHash
    }
  });
}

export async function ensureBudgetReservation(input: {
  prisma: PrismaLike;
  decision: AutonomyDecision;
  invocation: ScheduledInvocation;
  verifiedPolicy: VerifiedAutonomyPolicy;
  expiresAt: Date;
  now: Date;
}): Promise<{
  reservation: BudgetReservation;
  reservationKey: string;
  workloadCost: number;
  idempotent: boolean;
}> {
  if (!input.decision.authorKey) {
    throw new Error("BUDGET_AUTHOR_UNRESOLVED");
  }
  const budgetEvidence = parseDecisionBudgetEvidence(input.decision);
  const policyBudget = input.verifiedPolicy.policy.budget;
  const authorTouchLimit = Math.min(
    budgetEvidence.authorTouchLimit30d,
    policyBudget.authorTouchLimit30d
  );
  if (budgetEvidence.availableSlots < budgetEvidence.workloadCost) {
    throw new Error("BUDGET_DECISION_EVIDENCE_EXHAUSTED");
  }
  const reservationKey = computeBudgetReservationKey({
    decisionId: input.decision.id,
    invocationId: input.decision.invocationId,
    courseAlias: input.decision.courseAlias,
    policyHash: input.verifiedPolicy.policyHash,
    workloadCost: budgetEvidence.workloadCost
  });
  const existing =
    await input.prisma.budgetReservation.findUnique({
      where: { reservationKey }
    });
  if (existing) {
    assertReservationBinding({
      reservation: existing,
      decision: input.decision,
      reservationKey,
      workloadCost: budgetEvidence.workloadCost
    });
    if (
      existing.status !== "active" ||
      existing.expiresAt.getTime() <= input.now.getTime() ||
      existing.releasedAt ||
      existing.consumedAt
    ) {
      throw new Error("BUDGET_RESERVATION_NOT_ACTIVE");
    }
    return {
      reservation: existing,
      reservationKey,
      workloadCost: budgetEvidence.workloadCost,
      idempotent: true
    };
  }

  await input.prisma.budgetReservation.updateMany({
    where: {
      courseAlias: input.decision.courseAlias,
      status: "active",
      expiresAt: { lte: input.now }
    },
    data: { status: "expired", releasedAt: input.now }
  });
  const pending = await input.prisma.budgetReservation.create({
    data: {
      invocationId: input.decision.invocationId,
      decisionId: input.decision.id,
      courseAlias: input.decision.courseAlias,
      reservationKey,
      authorKey: input.decision.authorKey,
      workloadCost: budgetEvidence.workloadCost,
      status: "pending",
      expiresAt: input.expiresAt,
      consumedAt: null,
      releasedAt: null
    }
  });
  const usage = await readBudgetUsage({
    prisma: input.prisma,
    courseAlias: input.decision.courseAlias,
    invocationId: input.decision.invocationId,
    authorKey: input.decision.authorKey,
    now: input.now,
    legacyWorkloadCost: budgetEvidence.workloadCost
  });
  if (
    usage.consumedUnitsToday +
      usage.reservedUnitsToday +
      budgetEvidence.workloadCost >
    policyBudget.dailyActionLimit
  ) {
    throw new Error("BUDGET_DAILY_LIMIT_EXCEEDED");
  }
  if (
    usage.consumedUnitsThisInvocation +
      usage.reservedUnitsThisInvocation +
      budgetEvidence.workloadCost >
    policyBudget.perTickActionLimit
  ) {
    throw new Error("BUDGET_PER_TICK_LIMIT_EXCEEDED");
  }
  if (
    usage.authorTouches30d === null ||
    usage.authorTouches30d + 1 > authorTouchLimit
  ) {
    throw new Error("BUDGET_AUTHOR_TOUCH_LIMIT_EXCEEDED");
  }
  const reservation =
    await input.prisma.budgetReservation.update({
      where: { id: pending.id },
      data: { status: "active" }
    });
  await refreshInvocationLedger({
    prisma: input.prisma,
    decision: input.decision,
    invocation: input.invocation,
    usage: {
      ...usage,
      reservedUnitsToday:
        usage.reservedUnitsToday + budgetEvidence.workloadCost,
      reservedUnitsThisInvocation:
        usage.reservedUnitsThisInvocation +
        budgetEvidence.workloadCost
    },
    dailyLimit: policyBudget.dailyActionLimit,
    authorTouchLimit30d: authorTouchLimit
  });
  return {
    reservation,
    reservationKey,
    workloadCost: budgetEvidence.workloadCost,
    idempotent: false
  };
}

export async function loadActiveBudgetReservation(input: {
  prisma: PrismaLike;
  decision: AutonomyDecision;
  verifiedPolicy: VerifiedAutonomyPolicy;
  now: Date;
}): Promise<BudgetReservation> {
  const budgetEvidence = parseDecisionBudgetEvidence(input.decision);
  const reservationKey = computeBudgetReservationKey({
    decisionId: input.decision.id,
    invocationId: input.decision.invocationId,
    courseAlias: input.decision.courseAlias,
    policyHash: input.verifiedPolicy.policyHash,
    workloadCost: budgetEvidence.workloadCost
  });
  const reservation =
    await input.prisma.budgetReservation.findUnique({
      where: { reservationKey }
    });
  if (!reservation) {
    throw new Error("BUDGET_RESERVATION_NOT_FOUND");
  }
  assertReservationBinding({
    reservation,
    decision: input.decision,
    reservationKey,
    workloadCost: budgetEvidence.workloadCost
  });
  if (
    reservation.status !== "active" ||
    reservation.expiresAt.getTime() <= input.now.getTime() ||
    reservation.releasedAt ||
    reservation.consumedAt
  ) {
    throw new Error("BUDGET_RESERVATION_NOT_ACTIVE");
  }
  return reservation;
}

export async function releaseBudgetReservation(input: {
  prisma: PrismaLike;
  decision: AutonomyDecision;
  now: Date;
}): Promise<boolean> {
  const reservation =
    await input.prisma.budgetReservation.findFirst({
      where: {
        decisionId: input.decision.id,
        invocationId: input.decision.invocationId,
        courseAlias: input.decision.courseAlias
      },
      orderBy: { createdAt: "desc" }
    });
  if (!reservation) return false;
  if (
    reservation.status === "released" ||
    reservation.status === "expired"
  ) {
    return false;
  }
  if (
    reservation.status === "consumed" ||
    reservation.consumedAt
  ) {
    throw new Error("BUDGET_RESERVATION_ALREADY_CONSUMED");
  }
  await input.prisma.budgetReservation.update({
    where: { id: reservation.id },
    data: {
      status: "released",
      releasedAt: input.now
    }
  });
  const ledger =
    await input.prisma.schedulingLedger.findUnique({
      where: { invocationId: input.decision.invocationId }
    });
  if (ledger) {
    const reservedSlots = Math.max(
      0,
      ledger.reservedSlots - reservation.workloadCost
    );
    const availableSlots =
      ledger.availableSlots + reservation.workloadCost;
    await input.prisma.schedulingLedger.update({
      where: { id: ledger.id },
      data: {
        reservedSlots,
        availableSlots,
        reason: "execution_permit_budget_released",
        ledgerHash: canonicalProtocolHash(
          "cmooc.scheduling-ledger.v1",
          {
            worldHash: input.decision.worldHash,
            candidateSetHash: input.decision.candidateSetHash,
            budgetDate: ledger.budgetDate,
            availableSlots,
            reservedSlots,
            consumedSlots: ledger.consumedSlots,
            authorTouchLimit: ledger.authorTouchLimit
          }
        )
      }
    });
  }
  return true;
}

export async function consumeBudgetReservation(input: {
  prisma: PrismaLike;
  decision: AutonomyDecision;
  now: Date;
}): Promise<BudgetReservation> {
  const reservation =
    await input.prisma.budgetReservation.findFirst({
      where: {
        decisionId: input.decision.id,
        invocationId: input.decision.invocationId,
        courseAlias: input.decision.courseAlias
      },
      orderBy: { createdAt: "desc" }
    });
  if (!reservation) {
    throw new Error("BUDGET_RESERVATION_NOT_FOUND");
  }
  if (reservation.status === "consumed" && reservation.consumedAt) {
    return reservation;
  }
  if (
    reservation.status !== "active" ||
    reservation.releasedAt ||
    reservation.consumedAt
  ) {
    throw new Error("BUDGET_RESERVATION_NOT_CONSUMABLE");
  }
  const consumed = await input.prisma.budgetReservation.update({
    where: { id: reservation.id },
    data: {
      status: "consumed",
      consumedAt: input.now
    }
  });
  const ledger =
    await input.prisma.schedulingLedger.findUnique({
      where: { invocationId: input.decision.invocationId }
    });
  if (ledger) {
    const reservedSlots = Math.max(
      0,
      ledger.reservedSlots - reservation.workloadCost
    );
    const consumedSlots =
      ledger.consumedSlots + reservation.workloadCost;
    await input.prisma.schedulingLedger.update({
      where: { id: ledger.id },
      data: {
        reservedSlots,
        consumedSlots,
        reason: "execution_permit_budget_consumed",
        ledgerHash: canonicalProtocolHash(
          "cmooc.scheduling-ledger.v1",
          {
            worldHash: input.decision.worldHash,
            candidateSetHash: input.decision.candidateSetHash,
            budgetDate: ledger.budgetDate,
            availableSlots: ledger.availableSlots,
            reservedSlots,
            consumedSlots,
            authorTouchLimit: ledger.authorTouchLimit
          }
        )
      }
    });
  }
  return consumed;
}
