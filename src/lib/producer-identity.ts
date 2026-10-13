type ProducerIdentityUser = {
  email?: string | null;
  app_metadata?: Record<string, unknown>;
};

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function getProducerEmail(user: ProducerIdentityUser) {
  const canonicalEmail = normalizeEmail(user.app_metadata?.producer_email);
  return canonicalEmail || normalizeEmail(user.email);
}

export function getProducerCalendarEmails(user: ProducerIdentityUser) {
  return Array.from(
    new Set([getProducerEmail(user), normalizeEmail(user.email)].filter(Boolean)),
  );
}
