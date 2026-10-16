import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCmoocExecutionAccountRuntime
} from "../../lib/forum/cmooc-execution-account-config";
import {
  parseCmoocExecutionPartnerCredentials
} from "../../lib/forum/cmooc-api";

const SECRET = Buffer.alloc(32, 7);

function metadataJson(overrides?: Record<string, unknown>): string {
  return JSON.stringify([
    {
      credentialIndex: 0,
      roleKey: "socratic_guide",
      courseAliases: ["course-a"],
      dailyActionLimit: 5,
      cooldownMinutes: 30,
      disclosedAi: true,
      containsForumText: false,
      ...overrides
    },
    {
      credentialIndex: 1,
      roleKey: "evidence_connector",
      courseAliases: ["course-a", "course-b"],
      dailyActionLimit: 5,
      cooldownMinutes: 15,
      disclosedAi: true,
      containsForumText: false
    }
  ]);
}

test("execution account metadata produces only opaque descriptors", () => {
  const runtime = buildCmoocExecutionAccountRuntime({
    metadataJson: metadataJson(),
    credentials: [
      { account: "PRIVATE_ACCOUNT_ALPHA", password: "PRIVATE_PASSWORD_ALPHA" },
      { account: "PRIVATE_ACCOUNT_BETA", password: "PRIVATE_PASSWORD_BETA" }
    ],
    secret: SECRET
  });
  const descriptors = runtime.listDescriptors("course-a");
  assert.equal(descriptors.length, 2);
  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.roleKey),
    ["socratic_guide", "evidence_connector"]
  );
  for (const descriptor of descriptors) {
    assert.match(descriptor.accountRefHash, /^[a-f0-9]{64}$/);
    assert.match(descriptor.credentialRefHash, /^[a-f0-9]{64}$/);
    assert.equal(descriptor.disclosedAi, true);
    assert.equal(descriptor.containsForumText, false);
    assert.equal(descriptor.dailyActionLimit, 5);
  }
  const serialized = JSON.stringify(runtime);
  for (const forbidden of [
    "PRIVATE_ACCOUNT_ALPHA",
    "PRIVATE_PASSWORD_ALPHA",
    "PRIVATE_ACCOUNT_BETA",
    "PRIVATE_PASSWORD_BETA",
    "password",
    "credentialIndex"
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("an opaque account reference resolves exactly one in-memory credential", () => {
  const runtime = buildCmoocExecutionAccountRuntime({
    metadataJson: metadataJson(),
    credentials: [
      { account: "PRIVATE_ACCOUNT_ALPHA", password: "PRIVATE_PASSWORD_ALPHA" },
      { account: "PRIVATE_ACCOUNT_BETA", password: "PRIVATE_PASSWORD_BETA" }
    ],
    secret: SECRET
  });
  const selected = runtime.listDescriptors("course-a")[1];
  const credential = runtime.resolveCredential(selected.accountRefHash);
  assert.equal(credential.account, "PRIVATE_ACCOUNT_BETA");
  assert.equal(credential.password, "PRIVATE_PASSWORD_BETA");
  assert.equal(credential.credentialRefHash, selected.credentialRefHash);
  assert.throws(
    () => runtime.resolveCredential("f".repeat(64)),
    /CMOOC_EXECUTION_ACCOUNT_NOT_CONFIGURED/
  );
});

test("execution account references survive password rotation but not account substitution", () => {
  const first = buildCmoocExecutionAccountRuntime({
    metadataJson: metadataJson(),
    credentials: [
      { account: "PRIVATE_ACCOUNT_ALPHA", password: "OLD_PASSWORD" },
      { account: "PRIVATE_ACCOUNT_BETA", password: "PRIVATE_PASSWORD_BETA" }
    ],
    secret: SECRET
  }).listDescriptors("course-a")[0];
  const rotated = buildCmoocExecutionAccountRuntime({
    metadataJson: metadataJson(),
    credentials: [
      { account: "PRIVATE_ACCOUNT_ALPHA", password: "NEW_PASSWORD" },
      { account: "PRIVATE_ACCOUNT_BETA", password: "PRIVATE_PASSWORD_BETA" }
    ],
    secret: SECRET
  }).listDescriptors("course-a")[0];
  const substituted = buildCmoocExecutionAccountRuntime({
    metadataJson: metadataJson(),
    credentials: [
      { account: "DIFFERENT_ACCOUNT", password: "NEW_PASSWORD" },
      { account: "PRIVATE_ACCOUNT_BETA", password: "PRIVATE_PASSWORD_BETA" }
    ],
    secret: SECRET
  }).listDescriptors("course-a")[0];
  assert.equal(first.accountRefHash, rotated.accountRefHash);
  assert.equal(first.credentialRefHash, rotated.credentialRefHash);
  assert.notEqual(first.accountRefHash, substituted.accountRefHash);
  assert.notEqual(first.credentialRefHash, substituted.credentialRefHash);
});

test("account pool metadata is exact, disclosed, scoped and bounded", () => {
  const credentials = [
    { account: "PRIVATE_ACCOUNT_ALPHA", password: "PRIVATE_PASSWORD_ALPHA" },
    { account: "PRIVATE_ACCOUNT_BETA", password: "PRIVATE_PASSWORD_BETA" }
  ];
  for (const overrides of [
    { disclosedAi: false },
    { containsForumText: true },
    { dailyActionLimit: 6 },
    { cooldownMinutes: -1 },
    { courseAliases: [] },
    { roleKey: "hidden_human" },
    { unexpected: "field" },
    { credentialIndex: 9 }
  ]) {
    assert.throws(
      () =>
        buildCmoocExecutionAccountRuntime({
          metadataJson: metadataJson(overrides),
          credentials,
          secret: SECRET
        }),
      /CMOOC_EXECUTION_ACCOUNT_CONFIG_INVALID/
    );
  }
});

test("execution credential indices never shift through filtering or duplicate accounts", () => {
  assert.deepEqual(
    parseCmoocExecutionPartnerCredentials({
      accountsJson: JSON.stringify([
        { account: "agent-a", password: "secret-a" },
        { account: "agent-b", password: "secret-b" }
      ])
    }).map((credential) => credential.account),
    ["agent-a", "agent-b"]
  );
  for (const accountsJson of [
    JSON.stringify([
      { account: "", password: "invalid" },
      { account: "agent-b", password: "secret-b" }
    ]),
    JSON.stringify([
      { account: "agent-a", password: "secret-a" },
      { account: "agent-a", password: "secret-b" }
    ]),
    JSON.stringify([
      { account: "agent-a", password: "secret-a", role: "unexpected" }
    ])
  ]) {
    assert.throws(
      () => parseCmoocExecutionPartnerCredentials({ accountsJson }),
      /^Error: CMOOC_EXECUTION_ACCOUNT_CONFIG_INVALID$/
    );
  }
});
