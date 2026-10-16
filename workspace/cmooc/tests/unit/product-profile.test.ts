import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PRODUCT_PROFILE,
  resolveProductProfile
} from "../../lib/product-profile";

test("product profile supports one-deployment white labels without runtime authority", () => {
  assert.deepEqual(
    resolveProductProfile({
      NEXT_PUBLIC_PRODUCT_NAME: "小盒 · 课程共创智能体",
      NEXT_PUBLIC_PRODUCT_SHORT_NAME: "课程智能体",
      NEXT_PUBLIC_PRODUCT_DESCRIPTION: "连接课程现场、研判与运行证据",
      NEXT_PUBLIC_OPERATOR_LABEL: "小盒课程运营"
    }),
    {
      productName: "小盒 · 课程共创智能体",
      productShortName: "课程智能体",
      productDescription: "连接课程现场、研判与运行证据",
      operatorLabel: "小盒课程运营"
    }
  );
});

test("product profile strips control characters and rejects oversized labels", () => {
  const profile = resolveProductProfile({
    NEXT_PUBLIC_PRODUCT_NAME: "  Buyer\u0000  Studio  ",
    NEXT_PUBLIC_PRODUCT_SHORT_NAME: "x".repeat(25)
  });
  assert.equal(profile.productName, "Buyer Studio");
  assert.equal(
    profile.productShortName,
    DEFAULT_PRODUCT_PROFILE.productShortName
  );
});
