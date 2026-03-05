export function getReferenceNow() {
  const overrideIso = process.env.DEV_TIME_OVERRIDE_ISO;
  const canUseOverride = process.env.NODE_ENV !== "production";

  if (canUseOverride && overrideIso) {
    const parsed = new Date(overrideIso);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return new Date();
}
