import fs from "node:fs";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: ".env.local" });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const source = fs.readFileSync("EVENT_ATTENDEES_2026-02.md", "utf8").split("\n");

const events = [];
for (const line of source) {
  if (!line.startsWith("- ")) {
    continue;
  }

  const body = line.slice(2);
  const idx = body.lastIndexOf(" | ");
  if (idx < 0) {
    continue;
  }

  const title = body.slice(0, idx).trim();
  const emailsPart = body.slice(idx + 3).trim();
  const emails =
    emailsPart === "(none)"
      ? []
      : emailsPart
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean);

  events.push({ title, emails });
}

function normalize(value) {
  return (value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value) {
  return normalize(value).replace(/\s+/g, "");
}

function normalizeForIdentity(value) {
  return normalize(value)
    .replace(/\b(dj|mc|aka)\b/g, " ")
    .replace(/\b(x|and|n|vs)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );

  for (let i = 0; i <= a.length; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j <= b.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[a.length][b.length];
}

function extractCoreName(fullName) {
  return fullName.replace(/\([^)]*\)/g, "").trim();
}

function titleMatchesProfile(title, fullName) {
  const titleNorm = normalize(title);
  const nameNorm = normalize(fullName);
  const coreNorm = normalize(extractCoreName(fullName));
  const titleIdentity = normalizeForIdentity(title);
  const nameIdentity = normalizeForIdentity(fullName);
  const titleCompact = compact(titleIdentity);
  const nameCompact = compact(nameIdentity);

  if (!nameNorm) {
    return false;
  }

  if (titleNorm === nameNorm || titleNorm.startsWith(`${nameNorm} `)) {
    return true;
  }

  if (coreNorm && (titleNorm === coreNorm || titleNorm.startsWith(`${coreNorm} `))) {
    return true;
  }

  if (nameNorm.length >= 6 && (` ${titleNorm} `).includes(` ${nameNorm} `)) {
    return true;
  }

  if (coreNorm.length >= 6 && (` ${titleNorm} `).includes(` ${coreNorm} `)) {
    return true;
  }

  if (nameCompact && titleCompact && titleCompact.startsWith(nameCompact)) {
    return true;
  }

  if (nameCompact && titleCompact && nameCompact.length >= 6) {
    const distance = levenshtein(nameCompact, titleCompact.slice(0, nameCompact.length));
    if (distance <= 1) {
      return true;
    }
  }

  return false;
}

async function run() {
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("id,full_name,producer_email")
    .ilike("producer_email", "pending+%@paranoise.local");

  if (error) {
    throw error;
  }

  const updates = [];
  const ambiguous = [];
  const unmatched = [];

  for (const profile of profiles) {
    const matchedEvents = events.filter((event) =>
      titleMatchesProfile(event.title, profile.full_name),
    );

    const candidateEmails = new Set();
    for (const event of matchedEvents) {
      for (const email of event.emails) {
        if (email !== "paranoise.webradio@gmail.com") {
          candidateEmails.add(email);
        }
      }
    }

    const uniqueCandidates = [...candidateEmails];

    if (uniqueCandidates.length === 1) {
      updates.push({
        id: profile.id,
        fullName: profile.full_name,
        email: uniqueCandidates[0],
      });
    } else if (uniqueCandidates.length > 1) {
      ambiguous.push({
        fullName: profile.full_name,
        emails: uniqueCandidates,
      });
    } else {
      unmatched.push({ fullName: profile.full_name });
    }
  }

  for (const update of updates) {
    const { error: updateError } = await supabase
      .from("profiles")
      .update({ producer_email: update.email })
      .eq("id", update.id);

    if (updateError) {
      throw updateError;
    }
  }

  console.log(`Auto-updated: ${updates.length}`);
  for (const update of updates) {
    console.log(`  ${update.fullName} -> ${update.email}`);
  }

  console.log(`\nAmbiguous: ${ambiguous.length}`);
  for (const item of ambiguous) {
    console.log(`  ${item.fullName} -> ${item.emails.join(", ")}`);
  }

  console.log(`\nUnmatched: ${unmatched.length}`);
  for (const item of unmatched.slice(0, 50)) {
    console.log(`  ${item.fullName}`);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
