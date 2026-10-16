import { canonicalProtocolHash } from "@/lib/facilitation-protocol";

export const TRANSIENT_DRAFT_CONTENT_SCHEMA_VERSION =
  "cmooc.transient-draft-content.v1" as const;

export function normalizeTransientDraftBody(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

export function hashTransientDraftBody(value: string): string {
  return canonicalProtocolHash(
    TRANSIENT_DRAFT_CONTENT_SCHEMA_VERSION,
    {
      schemaVersion: TRANSIENT_DRAFT_CONTENT_SCHEMA_VERSION,
      body: normalizeTransientDraftBody(value)
    }
  );
}
