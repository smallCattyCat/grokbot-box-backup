import {
  type CourseWorldFrozenEvidenceV1,
  assertBasisPoints,
  assertSafeCount,
  assertSha256,
  protocolHash
} from "./contracts";

export const OASIS_SCENE_PACK_SCHEMA_VERSION =
  "cmooc.oasis-scene-pack.v1" as const;
export const OASIS_SCENE_TEMPLATE_REF =
  "course-support-network-64-v1" as const;
export const OASIS_SEED_SET_REF = "courseworld-seeds-16-v1" as const;

export const OASIS_REFERENCE_SEEDS = [
  104_729,
  130_363,
  155_921,
  181_081,
  206_369,
  231_481,
  256_739,
  282_001,
  307_261,
  332_623,
  357_941,
  383_249,
  408_523,
  433_819,
  459_089,
  484_397
] as const;

export type OasisSceneArmId =
  | "wait-baseline"
  | "facilitation-k1"
  | "facilitation-k3"
  | "facilitation-k5";

export interface OasisScenePackV1 {
  schemaVersion: typeof OASIS_SCENE_PACK_SCHEMA_VERSION;
  sceneTemplateRef: typeof OASIS_SCENE_TEMPLATE_REF;
  seedSetRef: typeof OASIS_SEED_SET_REF;
  datasetRef: "p3a-2025-holdout-v1";
  sourceEvidenceHash: string;
  evidenceClass: "synthetic_sensitivity_input";
  platformModel: {
    family: "reddit_like_forum";
    adapterTarget: "camel-ai/oasis";
    recommendationMode: "chronological_interest_mix";
    enabledActionCodes: [
      "create_post",
      "create_comment",
      "like",
      "follow",
      "search"
    ];
  };
  evidenceAnchors: {
    cohortYear: 2025;
    eligibleUnansweredCount: number;
    organicResponseBaselineBps: number;
    supportGapBaselineBps: number;
    clockKind: "p3a_historical";
    decisionLagHours: 22;
    simulationHorizonHours: 64;
  };
  syntheticPopulation: {
    agentCount: 96;
    threadCount: 64;
    archetypes: Array<{
      archetypeId:
        | "learner_initiator"
        | "peer_connector"
        | "synthesis_peer"
        | "facilitation_observer";
      agentCount: number;
      profileTemplateRef: string;
    }>;
  };
  arms: Array<{
    armId: OasisSceneArmId;
    dailyFacilitationBudget: 0 | 1 | 3 | 5;
    policyRef: "wait" | "constrained_structural";
  }>;
  syntheticAssumptions: {
    facilitatedReplyProbabilityBps: 5_000;
    recommendationAmplificationBps: 1_200;
    calibrationStatus: "protocol_conformance_only";
  };
  runConfig: {
    seeds: number[];
    schedulerTickMinutes: 30;
    maxActionsPerTick: 1;
    modelPolicyRef: "server_managed_oasis_model_policy_v1";
  };
  governance: {
    decisionUse: "research_only";
    externalWritesAllowed: false;
    coursePlatformWritesAllowed: false;
    interventionEligible: false;
    containsForumText: false;
    containsIdentity: false;
    containsRowLevelKeys: false;
  };
  scenePackHash: string;
}

function ratioBps(numerator: number, denominator: number): number {
  if (denominator <= 0) throw new Error("OASIS_SCENE_EVIDENCE_EMPTY");
  const value = Math.round((numerator * 10_000) / denominator);
  assertBasisPoints(value, "evidence anchor ratio");
  return value;
}

export function compileOasisScenePack(
  evidence: CourseWorldFrozenEvidenceV1
): OasisScenePackV1 {
  assertSha256(evidence.evidenceHash, "sourceEvidenceHash");
  if (
    evidence.datasetRef !== "p3a-2025-holdout-v1" ||
    evidence.evidenceClass !== "observed_frozen_aggregate" ||
    evidence.clock.kind !== "p3a_historical"
  ) {
    throw new Error("OASIS_SCENE_EVIDENCE_UNSUPPORTED");
  }
  const eligible = evidence.counts.eligibleUnansweredCount;
  const organic = evidence.counts.organicExternalResponseInWindowCount;
  const supportGap = evidence.counts.supportGapAtHorizonCount;
  if (organic + supportGap !== eligible) {
    throw new Error("OASIS_SCENE_EVIDENCE_PARTITION_MISMATCH");
  }

  const body = {
    schemaVersion: OASIS_SCENE_PACK_SCHEMA_VERSION,
    sceneTemplateRef: OASIS_SCENE_TEMPLATE_REF,
    seedSetRef: OASIS_SEED_SET_REF,
    datasetRef: evidence.datasetRef,
    sourceEvidenceHash: evidence.evidenceHash,
    evidenceClass: "synthetic_sensitivity_input" as const,
    platformModel: {
      family: "reddit_like_forum" as const,
      adapterTarget: "camel-ai/oasis" as const,
      recommendationMode: "chronological_interest_mix" as const,
      enabledActionCodes: [
        "create_post",
        "create_comment",
        "like",
        "follow",
        "search"
      ] as ["create_post", "create_comment", "like", "follow", "search"]
    },
    evidenceAnchors: {
      cohortYear: 2025 as const,
      eligibleUnansweredCount: eligible,
      organicResponseBaselineBps: ratioBps(organic, eligible),
      supportGapBaselineBps: ratioBps(supportGap, eligible),
      clockKind: "p3a_historical" as const,
      decisionLagHours: evidence.clock.decisionLagHours,
      simulationHorizonHours: evidence.clock.outcomeWindowHours
    },
    syntheticPopulation: {
      agentCount: 96 as const,
      threadCount: 64 as const,
      archetypes: [
        {
          archetypeId: "learner_initiator" as const,
          agentCount: 48,
          profileTemplateRef: "courseworld-profile-learner-initiator-v1"
        },
        {
          archetypeId: "peer_connector" as const,
          agentCount: 24,
          profileTemplateRef: "courseworld-profile-peer-connector-v1"
        },
        {
          archetypeId: "synthesis_peer" as const,
          agentCount: 16,
          profileTemplateRef: "courseworld-profile-synthesis-peer-v1"
        },
        {
          archetypeId: "facilitation_observer" as const,
          agentCount: 8,
          profileTemplateRef: "courseworld-profile-facilitation-observer-v1"
        }
      ]
    },
    arms: [
      {
        armId: "wait-baseline" as const,
        dailyFacilitationBudget: 0 as const,
        policyRef: "wait" as const
      },
      {
        armId: "facilitation-k1" as const,
        dailyFacilitationBudget: 1 as const,
        policyRef: "constrained_structural" as const
      },
      {
        armId: "facilitation-k3" as const,
        dailyFacilitationBudget: 3 as const,
        policyRef: "constrained_structural" as const
      },
      {
        armId: "facilitation-k5" as const,
        dailyFacilitationBudget: 5 as const,
        policyRef: "constrained_structural" as const
      }
    ],
    syntheticAssumptions: {
      facilitatedReplyProbabilityBps: 5_000 as const,
      recommendationAmplificationBps: 1_200 as const,
      calibrationStatus: "protocol_conformance_only" as const
    },
    runConfig: {
      seeds: [...OASIS_REFERENCE_SEEDS],
      schedulerTickMinutes: 30 as const,
      maxActionsPerTick: 1 as const,
      modelPolicyRef: "server_managed_oasis_model_policy_v1" as const
    },
    governance: {
      decisionUse: "research_only" as const,
      externalWritesAllowed: false as const,
      coursePlatformWritesAllowed: false as const,
      interventionEligible: false as const,
      containsForumText: false as const,
      containsIdentity: false as const,
      containsRowLevelKeys: false as const
    }
  };
  const scenePack: OasisScenePackV1 = {
    ...body,
    scenePackHash: protocolHash(body.schemaVersion, body)
  };
  assertOasisScenePack(scenePack);
  return scenePack;
}

export function assertOasisScenePack(
  scenePack: OasisScenePackV1
): void {
  assertSha256(scenePack.scenePackHash, "scenePackHash");
  const { scenePackHash, ...body } = scenePack;
  if (protocolHash(scenePack.schemaVersion, body) !== scenePackHash) {
    throw new Error("OASIS_SCENE_PACK_HASH_MISMATCH");
  }
  if (
    scenePack.schemaVersion !== OASIS_SCENE_PACK_SCHEMA_VERSION ||
    scenePack.sceneTemplateRef !== OASIS_SCENE_TEMPLATE_REF ||
    scenePack.seedSetRef !== OASIS_SEED_SET_REF
  ) {
    throw new Error("OASIS_SCENE_PACK_SCHEMA_MISMATCH");
  }
  const populationCount = scenePack.syntheticPopulation.archetypes.reduce(
    (sum, archetype) => {
      assertSafeCount(archetype.agentCount, archetype.archetypeId);
      return sum + archetype.agentCount;
    },
    0
  );
  if (populationCount !== scenePack.syntheticPopulation.agentCount) {
    throw new Error("OASIS_SCENE_POPULATION_MISMATCH");
  }
  if (
    new Set(scenePack.runConfig.seeds).size !==
      scenePack.runConfig.seeds.length ||
    scenePack.runConfig.seeds.length !== 16
  ) {
    throw new Error("OASIS_SCENE_SEED_SET_MISMATCH");
  }
  for (const seed of scenePack.runConfig.seeds) {
    assertSafeCount(seed, "scene seed");
  }
  if (
    scenePack.arms.map((arm) => arm.dailyFacilitationBudget).join(",") !==
    "0,1,3,5"
  ) {
    throw new Error("OASIS_SCENE_ARMS_MISMATCH");
  }
  assertBasisPoints(
    scenePack.evidenceAnchors.organicResponseBaselineBps,
    "organicResponseBaselineBps"
  );
  assertBasisPoints(
    scenePack.evidenceAnchors.supportGapBaselineBps,
    "supportGapBaselineBps"
  );
  if (
    Math.abs(
      scenePack.evidenceAnchors.organicResponseBaselineBps +
        scenePack.evidenceAnchors.supportGapBaselineBps -
        10_000
    ) > 1
  ) {
    throw new Error("OASIS_SCENE_ANCHOR_PARTITION_MISMATCH");
  }
  if (
    scenePack.governance.externalWritesAllowed ||
    scenePack.governance.coursePlatformWritesAllowed ||
    scenePack.governance.interventionEligible ||
    scenePack.governance.containsForumText ||
    scenePack.governance.containsIdentity ||
    scenePack.governance.containsRowLevelKeys
  ) {
    throw new Error("OASIS_SCENE_GOVERNANCE_MISMATCH");
  }
}
