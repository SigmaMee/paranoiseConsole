import assert from "node:assert/strict";
import test from "node:test";
import {
  limitMixcloudDescription,
  MIXCLOUD_DESCRIPTION_MAX_LENGTH,
} from "./submission-limits.mjs";

test("leaves descriptions within the Mixcloud limit unchanged", () => {
  const description = "a".repeat(MIXCLOUD_DESCRIPTION_MAX_LENGTH);

  assert.equal(limitMixcloudDescription(description), description);
});

test("shortens legacy descriptions to the Mixcloud limit", () => {
  const description = "a".repeat(MIXCLOUD_DESCRIPTION_MAX_LENGTH + 991);

  assert.equal(
    limitMixcloudDescription(description),
    "a".repeat(MIXCLOUD_DESCRIPTION_MAX_LENGTH),
  );
});

test("does not leave an unpaired surrogate at the truncation boundary", () => {
  const description = `${"a".repeat(MIXCLOUD_DESCRIPTION_MAX_LENGTH - 1)}😀tail`;
  const limited = limitMixcloudDescription(description);

  assert.equal(limited, "a".repeat(MIXCLOUD_DESCRIPTION_MAX_LENGTH - 1));
  assert.equal(limited.includes("�"), false);
});
