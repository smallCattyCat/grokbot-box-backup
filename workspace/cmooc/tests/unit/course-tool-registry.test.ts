import assert from "node:assert/strict";
import test from "node:test";
import {
  CourseToolRegistry,
  CourseToolRegistryError,
  defineCourseTool
} from "../../lib/course-tools/registry";
import { makeToolRegistration } from "./course-tool-test-fixtures";

test("registry resolves exact versions and exposes a safe deterministic manifest", () => {
  const registry = new CourseToolRegistry()
    .register(
      makeToolRegistration({
        name: "course.snapshot_read",
        version: "2",
        defaultForName: true
      })
    )
    .register(
      makeToolRegistration({
        name: "course.snapshot_read",
        version: "1"
      })
    )
    .register(
      makeToolRegistration({ name: "opportunity.list", version: "1" })
    )
    .seal();

  assert.equal(registry.resolve("course.snapshot_read").definition.version, "2");
  assert.equal(
    registry.resolve("course.snapshot_read", "1").definition.version,
    "1"
  );
  const manifest = registry.manifest();
  assert.equal(manifest.sealed, true);
  assert.deepEqual(
    manifest.tools.map((entry) => `${entry.name}@${entry.version}`),
    [
      "course.snapshot_read@1",
      "course.snapshot_read@2",
      "opportunity.list@1"
    ]
  );
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes("handler"), false);
  assert.equal(serialized.includes("projectOutput"), false);
  assert.equal(serialized.includes("fencingToken"), false);
  assert.equal(serialized.includes("courseId"), false);
});

test("registry rejects collisions, ambiguous versions, duplicate defaults, and post-seal mutation", () => {
  const registration = makeToolRegistration({
    name: "course.snapshot_read",
    version: "1"
  });
  const collision = new CourseToolRegistry().register(registration);
  assert.throws(
    () => collision.register(registration),
    (error: unknown) =>
      error instanceof CourseToolRegistryError &&
      error.code === "COURSE_TOOL_REGISTRY_COLLISION"
  );

  const ambiguous = new CourseToolRegistry()
    .register(
      makeToolRegistration({ name: "course.snapshot_read", version: "1" })
    )
    .register(
      makeToolRegistration({ name: "course.snapshot_read", version: "2" })
    );
  assert.throws(
    () => ambiguous.resolve("course.snapshot_read"),
    (error: unknown) =>
      error instanceof CourseToolRegistryError &&
      error.code === "COURSE_TOOL_VERSION_REQUIRED"
  );

  const duplicateDefault = new CourseToolRegistry().register(
    makeToolRegistration({
      name: "course.snapshot_read",
      version: "1",
      defaultForName: true
    })
  );
  assert.throws(
    () =>
      duplicateDefault.register(
        makeToolRegistration({
          name: "course.snapshot_read",
          version: "2",
          defaultForName: true
        })
      ),
    (error: unknown) =>
      error instanceof CourseToolRegistryError &&
      error.code === "COURSE_TOOL_DEFAULT_VERSION_COLLISION"
  );

  const sealed = new CourseToolRegistry().seal();
  assert.throws(
    () => sealed.register(registration),
    (error: unknown) =>
      error instanceof CourseToolRegistryError &&
      error.code === "COURSE_TOOL_REGISTRY_SEALED"
  );
});

test("definitions bind capability to effect and require real L2/L3 recovery semantics", () => {
  assert.throws(
    () =>
      defineCourseTool(
        makeToolRegistration({
          effect: "read",
          capability: "L1_ARTIFACT"
        })
      ),
    /capability/i
  );

  const reversible = makeToolRegistration({ effect: "reversible_write" });
  assert.throws(
    () =>
      defineCourseTool({
        ...reversible,
        definition: { ...reversible.definition, recovery: undefined }
      }),
    /compensation|safe-state/i
  );

  const stage = makeToolRegistration({ effect: "external_stage" });
  assert.throws(
    () =>
      defineCourseTool({
        ...stage,
        definition: { ...stage.definition, recovery: undefined }
      }),
    /reconcile/i
  );
  assert.throws(
    () =>
      defineCourseTool({
        ...stage,
        definition: {
          ...stage.definition,
          verification: {
            ...stage.definition.verification,
            onFailure: "failed"
          }
        }
      }),
    /unknown outcome/i
  );
});

test("external tools cannot declare blind retry or fake irreversible undo", () => {
  const stage = makeToolRegistration({ effect: "external_stage" });
  assert.throws(
    () =>
      defineCourseTool({
        ...stage,
        definition: {
          ...stage.definition,
          idempotency: { strategy: "input_hash", scope: "step" }
        }
      }),
    /stage nonce|server key/i
  );

  const irreversible = makeToolRegistration({
    effect: "irreversible_external"
  });
  assert.throws(
    () =>
      defineCourseTool({
        ...irreversible,
        definition: {
          ...irreversible.definition,
          recovery: {
            kind: "compensation",
            toolName: "publication.fake_undo",
            toolVersion: "1"
          }
        }
      }),
    /generic compensation/i
  );
});

test("registered definitions are frozen so callers cannot weaken policy metadata", () => {
  const registration = defineCourseTool(makeToolRegistration());
  assert.equal(Object.isFrozen(registration), true);
  assert.equal(Object.isFrozen(registration.definition), true);
  assert.equal(Object.isFrozen(registration.definition.verification), true);
  assert.equal(Object.isFrozen(registration.definition.retry), true);
  assert.equal(
    Reflect.set(registration.definition as object, "capability", "L4_IRREVERSIBLE"),
    false
  );
  assert.equal(registration.definition.capability, "L0_READ");
});
