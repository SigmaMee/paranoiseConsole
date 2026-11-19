export const MIXCLOUD_DESCRIPTION_MAX_LENGTH = 1_000;

export function limitMixcloudDescription(description) {
  if (description.length <= MIXCLOUD_DESCRIPTION_MAX_LENGTH) return description;

  const limited = description.slice(0, MIXCLOUD_DESCRIPTION_MAX_LENGTH);
  const finalCodeUnit = limited.charCodeAt(limited.length - 1);
  const endsWithUnpairedHighSurrogate = finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff;

  return endsWithUnpairedHighSurrogate ? limited.slice(0, -1) : limited;
}
