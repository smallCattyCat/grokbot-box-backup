import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  COURSE_MANIFEST_SCHEMA_VERSION,
  COURSE_MANIFEST_SCHEMA_VERSION_V2,
  COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION,
  COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION_V2,
  parseCourseManifest,
  parseCourseManifestTemplateV2,
  type CourseManifestTemplate,
  type CourseManifestTemplateV2,
  type CourseManifestV2
} from "../../lib/autonomy/course-manifest";
import {
  AutonomyObserverRegistry,
  createAutonomyObserverRegistry
} from "../../lib/autonomy/observer-registry";
import type {
  AutonomyCourseObserver
} from "../../lib/autonomy/platform-observer";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function v1Fixture() {
  const courseId = "1234567890";
  const template: CourseManifestTemplate = {
    schemaVersion: COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION,
    alias: "cmooc-current",
    platformId: "cmooc.bnu",
    courseIdSha256: sha256(courseId),
    canonicalOrigin: "https://cmooc.example.test",
    canonicalPath: "/cMOOC/course",
    timeZone: "Asia/Shanghai",
    defaultMode: "SHADOW",
    policyVersion: "test.shadow.v1",
    realPublishEnabled: false
  };
  const manifest = parseCourseManifest({
    template,
    sourcePath: "C:\\tmp\\cmooc-current-course.json",
    value: {
      schemaVersion: COURSE_MANIFEST_SCHEMA_VERSION,
      alias: template.alias,
      platformId: "cmooc.bnu",
      courseId,
      canonicalUrl:
        `https://cmooc.example.test/cMOOC/course?courseId=${courseId}&isBack=1`,
      allowedOrigins: [template.canonicalOrigin],
      adapterId: "cmooc.api.v2",
      timeZone: template.timeZone,
      defaultMode: template.defaultMode,
      policyVersion: template.policyVersion,
      scan: {
        maxThreadsPerTick: 20,
        maxCommentsPerThread: 500,
        pageSize: 50
      },
      budget: {
        dailySlots: 3,
        workloadCost: 1,
        authorTouchLimit30d: 2
      },
      schedule: {
        intervalMinutes: 30,
        leaseSeconds: 120
      },
      realPublishEnabled: false
    }
  });
  return { template, manifest };
}

function v2Fixture(overrides: Record<string, unknown> = {}) {
  const courseId = "course:opaque:synthetic/2026-08";
  const canonicalUrl =
    "https://learn.example.test/catalog/course/alpha?tenant=demo";
  const allowedOrigins = [
    "https://learn.example.test",
    "https://api.example.test"
  ];
  const template: CourseManifestTemplateV2 = {
    schemaVersion: COURSE_MANIFEST_TEMPLATE_SCHEMA_VERSION_V2,
    alias: "synthetic-course",
    platformId: "synthetic.timeline",
    adapterId: "synthetic.timeline.v1",
    courseIdHash: sha256(courseId),
    canonicalUrlHash: sha256(new URL(canonicalUrl).toString()),
    allowedOrigins,
    timeZone: "UTC",
    defaultMode: "SHADOW",
    policyVersion: "synthetic.shadow.v1",
    realPublishEnabled: false
  };
  const value = {
    schemaVersion: COURSE_MANIFEST_SCHEMA_VERSION_V2,
    alias: template.alias,
    platformId: template.platformId,
    adapterId: template.adapterId,
    courseId,
    courseIdHash: template.courseIdHash,
    canonicalUrl,
    canonicalUrlHash: template.canonicalUrlHash,
    allowedOrigins: [...template.allowedOrigins],
    timeZone: template.timeZone,
    defaultMode: template.defaultMode,
    policyVersion: template.policyVersion,
    scan: {
      maxThreadsPerTick: 20,
      maxCommentsPerThread: 500,
      pageSize: 50
    },
    budget: {
      dailySlots: 3,
      workloadCost: 1,
      authorTouchLimit30d: 2
    },
    schedule: {
      intervalMinutes: 30,
      leaseSeconds: 120
    },
    realPublishEnabled: false,
    ...overrides
  };
  const manifest = parseCourseManifest({
    value,
    template,
    sourcePath: "C:\\tmp\\synthetic-course.json"
  });
  return { template, value, manifest };
}

test("现有 cMOOC v1 manifest 仍按原契约解析", () => {
  const { manifest } = v1Fixture();
  assert.equal(manifest.schemaVersion, COURSE_MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.platformId, "cmooc.bnu");
  assert.equal(manifest.adapterId, "cmooc.api.v2");
  assert.equal(manifest.courseIdSha256, sha256(manifest.courseId));
  assert.equal(manifest.realPublishEnabled, false);
});

test("v2 允许非数字 opaque course ref 和非 cMOOC URL", () => {
  const { manifest, template } = v2Fixture();
  assert.equal(manifest.schemaVersion, COURSE_MANIFEST_SCHEMA_VERSION_V2);
  assert.equal(manifest.platformId, "synthetic.timeline");
  assert.equal(manifest.adapterId, "synthetic.timeline.v1");
  assert.equal(manifest.courseId, "course:opaque:synthetic/2026-08");
  assert.equal(manifest.courseIdHash, template.courseIdHash);
  assert.equal(manifest.canonicalUrlHash, template.canonicalUrlHash);
  assert.deepEqual(manifest.allowedOrigins, template.allowedOrigins);
  assert.equal(manifest.realPublishEnabled, false);
  assert.match(manifest.manifestHash, /^[a-f0-9]{64}$/);
});

test("v2 模板只接受精确的平台、adapter、course hash、URL hash 和 origin 集合", () => {
  const { template, value } = v2Fixture();
  assert.deepEqual(
    parseCourseManifestTemplateV2(template, "synthetic-course"),
    template
  );

  assert.throws(
    () =>
      parseCourseManifest({
        value: { ...value, courseId: "course:opaque:other" },
        template,
        sourcePath: "C:\\tmp\\synthetic-course.json"
      }),
    /精确课程标识/
  );
  assert.throws(
    () =>
      parseCourseManifest({
        value: {
          ...value,
          canonicalUrl: "https://learn.example.test/catalog/course/other"
        },
        template,
        sourcePath: "C:\\tmp\\synthetic-course.json"
      }),
    /精确地址/
  );
  assert.throws(
    () =>
      parseCourseManifest({
        value: {
          ...value,
          allowedOrigins: ["https://other.example.test"]
        },
        template,
        sourcePath: "C:\\tmp\\synthetic-course.json"
      }),
    /origin 与模板/
  );
  assert.throws(
    () =>
      parseCourseManifest({
        value: { ...value, adapterId: "other.adapter.v1" },
        template,
        sourcePath: "C:\\tmp\\synthetic-course.json"
      }),
    /adapter 不匹配/
  );
  assert.throws(
    () =>
      parseCourseManifest({
        value: { ...value, platformId: "other.platform" },
        template,
        sourcePath: "C:\\tmp\\synthetic-course.json"
      }),
    /平台不匹配/
  );
});

function markerObserver(): AutonomyCourseObserver {
  return {
    async observe() {
      throw new Error("marker observer should not perform a read in this test");
    }
  };
}

test("observer registry 按 platformId+adapterId 选择 v1/v2 observer", () => {
  const current = v1Fixture().manifest;
  const synthetic = v2Fixture().manifest;
  const cmoocObserver = markerObserver();
  const syntheticObserver = markerObserver();
  const seen: string[] = [];
  const registry = createAutonomyObserverRegistry([
    {
      platformId: "cmooc.bnu",
      adapterId: "cmooc.api.v2",
      factory: ({ manifest }) => {
        seen.push(`${manifest.platformId}:${manifest.adapterId}`);
        return cmoocObserver;
      }
    },
    {
      platformId: "synthetic.timeline",
      adapterId: "synthetic.timeline.v1",
      factory: ({ manifest }) => {
        seen.push(`${manifest.platformId}:${manifest.adapterId}`);
        return syntheticObserver;
      }
    }
  ]);

  assert.equal(registry.create(current), cmoocObserver);
  assert.equal(registry.create(synthetic), syntheticObserver);
  assert.deepEqual(seen, [
    "cmooc.bnu:cmooc.api.v2",
    "synthetic.timeline:synthetic.timeline.v1"
  ]);
  assert.equal(
    registry.has({
      platformId: synthetic.platformId,
      adapterId: synthetic.adapterId
    }),
    true
  );
});

test("observer registry 对 unknown 和 platform/adapter 错配 fail closed", () => {
  const synthetic = v2Fixture().manifest;
  const registry = new AutonomyObserverRegistry().register({
    platformId: "other.platform",
    adapterId: "shared.adapter.v1",
    factory: () => markerObserver()
  });

  assert.throws(
    () =>
      registry.create({
        ...synthetic,
        adapterId: "unknown.adapter.v1"
      } as CourseManifestV2),
    /AUTONOMY_OBSERVER_NOT_REGISTERED/
  );
  assert.throws(
    () =>
      registry.resolve({
        platformId: "synthetic.timeline",
        adapterId: "shared.adapter.v1"
      }),
    /AUTONOMY_OBSERVER_PLATFORM_ADAPTER_MISMATCH/
  );
  assert.throws(
    () =>
      registry.register({
        platformId: "other.platform",
        adapterId: "shared.adapter.v1",
        factory: () => markerObserver()
      }),
    /AUTONOMY_OBSERVER_DUPLICATE_REGISTRATION/
  );
});

