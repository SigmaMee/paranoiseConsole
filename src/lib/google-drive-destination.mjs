export const DRIVE_MISC_FALLBACK_FOLDER_ID = "1pkScMs6_83wZmsFC0Y-J3GyqGdbRB8QN";

export function requireDriveDestinationFolderId(destinationFolderId) {
  const folderId = destinationFolderId.trim();

  if (!folderId) {
    throw new Error(
      "Google Drive upload failed: no weekday destination folder was resolved. No file was uploaded.",
    );
  }

  return folderId;
}

export function resolveDriveWeekdayFolderId(matchedFolderId) {
  return matchedFolderId?.trim() || DRIVE_MISC_FALLBACK_FOLDER_ID;
}
