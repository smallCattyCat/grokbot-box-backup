import { z } from "zod";
import { portableCourseActionSchema } from "../lib/workbench/portable-course-contracts";
import { browserObservationSchema, browserProposalSchema, browserStageSchema, browserReplyReceiptSchema, browserReplyUptakeSchema, browserParticipationChoiceSchema } from "../lib/workbench/browser-course-contracts";

// Emit local machine-readable contracts; never inspect platform data or start a model.
process.stdout.write(JSON.stringify({ schemaVersion: "cmooc-portable-contracts.v1", realPublishEnabled: false,
  management: z.toJSONSchema(portableCourseActionSchema),
  observation: z.toJSONSchema(browserObservationSchema),
  proposals: z.toJSONSchema(z.array(browserProposalSchema)),
  editorReadback: z.toJSONSchema(browserStageSchema),
  replyReceipt: z.toJSONSchema(browserReplyReceiptSchema),
  replyUptake: z.toJSONSchema(browserReplyUptakeSchema),
  participationChoice: z.toJSONSchema(browserParticipationChoiceSchema)
}, null, 2) + "\n");
