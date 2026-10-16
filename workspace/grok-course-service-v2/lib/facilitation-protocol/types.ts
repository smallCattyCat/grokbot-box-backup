import type { FromSchema } from "json-schema-to-ts";
import {
  boundTargetV1Schema,
  capabilityRequestV1Schema,
  decisionEvidenceRefV1Schema,
  executionCommandV1Schema,
  executionReceiptV1Schema,
  facilitationMoveSpecV1Schema,
  interventionEventV1Schema,
  interventionIntentV1Schema,
  observationEnvelopeV1Schema,
  reviewBundleV1Schema
} from "./schemas";

export type ObservationEnvelopeV1 =
  FromSchema<typeof observationEnvelopeV1Schema>;

export type DecisionEvidenceRefV1 =
  FromSchema<typeof decisionEvidenceRefV1Schema>;

export type InterventionIntentV1 =
  FromSchema<typeof interventionIntentV1Schema>;

export type FacilitationMoveSpecV1 =
  FromSchema<typeof facilitationMoveSpecV1Schema>;

export type BoundTargetV1 =
  FromSchema<typeof boundTargetV1Schema>;

export type ReviewBundleV1 =
  FromSchema<typeof reviewBundleV1Schema>;

export type CapabilityRequestV1 =
  FromSchema<typeof capabilityRequestV1Schema>;

export type ExecutionCommandV1 =
  FromSchema<typeof executionCommandV1Schema>;

export type ExecutionReceiptV1 =
  FromSchema<typeof executionReceiptV1Schema>;

export type InterventionEventV1 =
  FromSchema<typeof interventionEventV1Schema>;

export type ProtocolTypeMap = {
  observationEnvelope: ObservationEnvelopeV1;
  decisionEvidenceRef: DecisionEvidenceRefV1;
  interventionIntent: InterventionIntentV1;
  facilitationMoveSpec: FacilitationMoveSpecV1;
  boundTarget: BoundTargetV1;
  reviewBundle: ReviewBundleV1;
  capabilityRequest: CapabilityRequestV1;
  executionCommand: ExecutionCommandV1;
  executionReceipt: ExecutionReceiptV1;
  interventionEvent: InterventionEventV1;
};

export type FacilitationFunction =
  InterventionIntentV1["facilitationFunction"];

export type TargetObject = InterventionIntentV1["targetObject"];
