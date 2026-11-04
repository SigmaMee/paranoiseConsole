import assert from "node:assert/strict";
import test from "node:test";

import {
  DRIVE_MISC_FALLBACK_FOLDER_ID,
  requireDriveDestinationFolderId,
  resolveDriveWeekdayFolderId,
} from "./google-drive-destination.mjs";

test("returns the resolved weekday folder ID", () => {
  assert.equal(requireDriveDestinationFolderId(" weekday-folder-id "), "weekday-folder-id");
});

test("rejects a missing weekday folder instead of allowing a parent-folder fallback", () => {
  assert.throws(
    () => requireDriveDestinationFolderId("  "),
    /no weekday destination folder was resolved.*No file was uploaded/i,
  );
});

test("uses the matched weekday folder when available", () => {
  assert.equal(resolveDriveWeekdayFolderId(" weekday-folder-id "), "weekday-folder-id");
});

test("uses the Misc folder when no weekday folder matches", () => {
  assert.equal(resolveDriveWeekdayFolderId(undefined), DRIVE_MISC_FALLBACK_FOLDER_ID);
});
