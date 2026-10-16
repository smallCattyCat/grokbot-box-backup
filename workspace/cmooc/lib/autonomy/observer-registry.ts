import type {
  AnyCourseManifest
} from "./course-manifest";
import type {
  AutonomyCourseObserver
} from "./platform-observer";

export type AutonomyObserverFactoryInput = {
  manifest: AnyCourseManifest;
};

export type AutonomyObserverFactory = (
  input: AutonomyObserverFactoryInput
) => AutonomyCourseObserver;

export type AutonomyObserverRegistration = {
  platformId: string;
  adapterId: string;
  factory: AutonomyObserverFactory;
};

export type AutonomyObserverManifestIdentity = Pick<
  AnyCourseManifest,
  "platformId" | "adapterId"
>;

function exactIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f\s]/u.test(value)
  ) {
    throw new Error(`AUTONOMY_OBSERVER_${label.toUpperCase()}_INVALID`);
  }
  return value;
}

function registryKey(platformId: string, adapterId: string): string {
  // JSON encoding avoids collisions that a delimiter-based key could create.
  return JSON.stringify([platformId, adapterId]);
}

function isObserver(value: unknown): value is AutonomyCourseObserver {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { observe?: unknown }).observe === "function"
  );
}

/**
 * Resolves an autonomy observer only from the complete platform/adapter pair.
 * There is intentionally no default observer: an unregistered or mismatched
 * manifest must stop before any platform read is attempted.
 */
export class AutonomyObserverRegistry {
  readonly #registrations = new Map<
    string,
    AutonomyObserverRegistration
  >();

  register(registration: AutonomyObserverRegistration): this {
    const platformId = exactIdentifier(
      registration.platformId,
      "PLATFORM_ID"
    );
    const adapterId = exactIdentifier(
      registration.adapterId,
      "ADAPTER_ID"
    );
    if (typeof registration.factory !== "function") {
      throw new Error("AUTONOMY_OBSERVER_FACTORY_INVALID");
    }
    const key = registryKey(platformId, adapterId);
    if (this.#registrations.has(key)) {
      throw new Error("AUTONOMY_OBSERVER_DUPLICATE_REGISTRATION");
    }
    this.#registrations.set(key, {
      platformId,
      adapterId,
      factory: registration.factory
    });
    return this;
  }

  resolve(
    identity: AutonomyObserverManifestIdentity
  ): AutonomyObserverFactory {
    const platformId = exactIdentifier(
      identity.platformId,
      "PLATFORM_ID"
    );
    const adapterId = exactIdentifier(
      identity.adapterId,
      "ADAPTER_ID"
    );
    const registration = this.#registrations.get(
      registryKey(platformId, adapterId)
    );
    if (!registration) {
      const adapterExistsForAnotherPlatform = [...this.#registrations.values()].some(
        (candidate) =>
          candidate.adapterId === adapterId &&
          candidate.platformId !== platformId
      );
      throw new Error(
        adapterExistsForAnotherPlatform
          ? "AUTONOMY_OBSERVER_PLATFORM_ADAPTER_MISMATCH"
          : "AUTONOMY_OBSERVER_NOT_REGISTERED"
      );
    }
    return registration.factory;
  }

  create(manifest: AnyCourseManifest): AutonomyCourseObserver {
    const factory = this.resolve(manifest);
    const observer = factory({ manifest });
    if (!isObserver(observer)) {
      throw new Error("AUTONOMY_OBSERVER_FACTORY_RESULT_INVALID");
    }
    return observer;
  }

  has(identity: AutonomyObserverManifestIdentity): boolean {
    try {
      const platformId = exactIdentifier(
        identity.platformId,
        "PLATFORM_ID"
      );
      const adapterId = exactIdentifier(
        identity.adapterId,
        "ADAPTER_ID"
      );
      return this.#registrations.has(registryKey(platformId, adapterId));
    } catch {
      return false;
    }
  }

  registrations(): readonly AutonomyObserverRegistration[] {
    return [...this.#registrations.values()].map((registration) => ({
      ...registration
    }));
  }
}

export function createAutonomyObserverRegistry(
  registrations: readonly AutonomyObserverRegistration[] = []
): AutonomyObserverRegistry {
  const registry = new AutonomyObserverRegistry();
  for (const registration of registrations) {
    registry.register(registration);
  }
  return registry;
}
