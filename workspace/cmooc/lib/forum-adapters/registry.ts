import {
  canonicalHashList,
  canonicalProtocolHash,
  type CanonicalJsonValue
} from "../facilitation-protocol";
import {
  FORUM_ADAPTER_CONTRACT_VERSION,
  assertAdapterManifest,
  type AdapterManifest,
  type ForumAdapter
} from "./contract";

export const FORUM_ADAPTER_REGISTRY_VERSION =
  "cmooc.forum-adapter-registry.v1" as const;

export class ForumAdapterRegistry {
  readonly #adapters = new Map<string, ForumAdapter>();

  register(adapter: ForumAdapter): this {
    const manifest = assertAdapterManifest(adapter.manifest());
    if (this.#adapters.has(manifest.adapterId)) {
      throw new Error(
        `DUPLICATE_FORUM_ADAPTER: ${manifest.adapterId}`
      );
    }
    this.#adapters.set(manifest.adapterId, adapter);
    return this;
  }

  get(adapterId: string): ForumAdapter {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) {
      throw new Error(`UNKNOWN_FORUM_ADAPTER: ${adapterId}`);
    }
    return adapter;
  }

  manifests(): AdapterManifest[] {
    return [...this.#adapters.values()]
      .map((adapter) => assertAdapterManifest(adapter.manifest()))
      .sort((left, right) =>
        left.adapterId.localeCompare(right.adapterId)
      );
  }

  snapshot(): {
    schemaVersion: typeof FORUM_ADAPTER_REGISTRY_VERSION;
    contractVersion: typeof FORUM_ADAPTER_CONTRACT_VERSION;
    adapterCount: number;
    realExternalWriteAdapterCount: number;
    manifestSetHash: string;
    containsForumText: false;
  } {
    const manifests = this.manifests();
    const manifestHashes = manifests.map((manifest) =>
      canonicalProtocolHash(
        manifest.schemaVersion,
        manifest as unknown as CanonicalJsonValue
      )
    );
    return {
      schemaVersion: FORUM_ADAPTER_REGISTRY_VERSION,
      contractVersion: FORUM_ADAPTER_CONTRACT_VERSION,
      adapterCount: manifests.length,
      realExternalWriteAdapterCount: manifests.filter(
        (manifest) =>
          manifest.externalWriteMode === "gateway_authorized"
      ).length,
      manifestSetHash: canonicalHashList(
        "cmooc.forum-adapter-manifest-set.v1",
        manifestHashes
      ),
      containsForumText: false
    };
  }
}
