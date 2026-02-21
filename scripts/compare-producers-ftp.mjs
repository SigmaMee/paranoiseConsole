import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { Client } from "basic-ftp";

dotenv.config({ path: ".env.local" });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var: ${name}`);
  }
  return value;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenSet(value) {
  return new Set(normalizeName(value).split(" ").filter(Boolean));
}

function jaccard(aSet, bSet) {
  if (aSet.size === 0 && bSet.size === 0) {
    return 1;
  }

  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) {
      intersection += 1;
    }
  }

  const union = aSet.size + bSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function similarity(a, b) {
  const normA = normalizeName(a);
  const normB = normalizeName(b);

  if (!normA || !normB) {
    return 0;
  }

  if (normA === normB) {
    return 1;
  }

  const aIncludesB = normA.includes(normB) && normB.length >= 4;
  const bIncludesA = normB.includes(normA) && normA.length >= 4;
  const includeBoost = aIncludesB || bIncludesA ? 0.85 : 0;

  const tokenScore = jaccard(tokenSet(normA), tokenSet(normB));
  return Math.max(includeBoost, tokenScore);
}

function toCsvValue(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes("\n") || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows) {
  const header = ["producer_name", "status", "db_name", "ftp_folder", "match_score", "notes"];
  const lines = [header.join(",")];

  for (const row of rows) {
    lines.push(
      [
        row.producer_name,
        row.status,
        row.db_name,
        row.ftp_folder,
        row.match_score,
        row.notes,
      ]
        .map(toCsvValue)
        .join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

async function fetchDbProducerNames() {
  const supabaseUrl = required("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRole = required("SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(supabaseUrl, serviceRole);

  const { data, error } = await supabase
    .from("profiles")
    .select("full_name")
    .order("full_name", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch profiles from Supabase: ${error.message}`);
  }

  const unique = new Map();
  for (const row of data || []) {
    const name = typeof row.full_name === "string" ? row.full_name.trim() : "";
    if (!name) {
      continue;
    }
    const key = normalizeName(name);
    if (!key) {
      continue;
    }
    if (!unique.has(key)) {
      unique.set(key, name);
    }
  }

  return Array.from(unique.values());
}

async function fetchFtpFolders() {
  const host = required("FTP_HOST");
  const user = required("FTP_USER");
  const password = required("FTP_PASSWORD");
  const secure = process.env.FTP_SECURE === "true";
  const root = process.env.FTP_PRODUCER_ROOT_DIR || "media";

  const client = new Client();
  client.ftp.verbose = false;

  try {
    await client.access({ host, user, password, secure });
    const entries = await client.list(root);

    const folders = entries
      .filter((entry) => entry.isDirectory || entry.type === 2)
      .map((entry) => entry.name.trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    return folders;
  } finally {
    client.close();
  }
}

function buildComparisonRows(dbNames, ftpFolders) {
  const rows = [];

  const dbRemaining = new Map(dbNames.map((name) => [name, normalizeName(name)]));
  const ftpRemaining = new Map(ftpFolders.map((folder) => [folder, normalizeName(folder)]));

  const exactByNorm = new Map();
  for (const [folder, norm] of ftpRemaining.entries()) {
    if (!exactByNorm.has(norm)) {
      exactByNorm.set(norm, []);
    }
    exactByNorm.get(norm).push(folder);
  }

  for (const [dbName, dbNorm] of Array.from(dbRemaining.entries())) {
    const exactFolders = exactByNorm.get(dbNorm);
    if (!exactFolders || exactFolders.length === 0) {
      continue;
    }

    const ftpFolder = exactFolders.shift();
    ftpRemaining.delete(ftpFolder);
    dbRemaining.delete(dbName);

    rows.push({
      producer_name: dbName,
      status: "fully aligned",
      db_name: dbName,
      ftp_folder: ftpFolder,
      match_score: "1.00",
      notes: "Exact normalized match",
    });
  }

  const fuzzyCandidates = [];
  for (const [dbName] of dbRemaining.entries()) {
    for (const [ftpFolder] of ftpRemaining.entries()) {
      const score = similarity(dbName, ftpFolder);
      if (score >= 0.45) {
        fuzzyCandidates.push({ dbName, ftpFolder, score });
      }
    }
  }

  fuzzyCandidates.sort((a, b) => b.score - a.score);

  const usedDb = new Set();
  const usedFtp = new Set();

  for (const candidate of fuzzyCandidates) {
    if (candidate.score < 0.65) {
      continue;
    }
    if (usedDb.has(candidate.dbName) || usedFtp.has(candidate.ftpFolder)) {
      continue;
    }

    usedDb.add(candidate.dbName);
    usedFtp.add(candidate.ftpFolder);
    dbRemaining.delete(candidate.dbName);
    ftpRemaining.delete(candidate.ftpFolder);

    rows.push({
      producer_name: candidate.dbName,
      status: "somewhat aligned",
      db_name: candidate.dbName,
      ftp_folder: candidate.ftpFolder,
      match_score: candidate.score.toFixed(2),
      notes: "Fuzzy/token similarity match",
    });
  }

  for (const [dbName] of dbRemaining.entries()) {
    rows.push({
      producer_name: dbName,
      status: "missing in ftp",
      db_name: dbName,
      ftp_folder: "",
      match_score: "",
      notes: "No FTP folder match found",
    });
  }

  for (const [ftpFolder] of ftpRemaining.entries()) {
    rows.push({
      producer_name: ftpFolder,
      status: "missing in db",
      db_name: "",
      ftp_folder: ftpFolder,
      match_score: "",
      notes: "No DB producer match found",
    });
  }

  const statusOrder = {
    "fully aligned": 0,
    "somewhat aligned": 1,
    "missing in db": 2,
    "missing in ftp": 3,
  };

  return rows.sort((a, b) => {
    const statusCmp = (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99);
    if (statusCmp !== 0) {
      return statusCmp;
    }
    return a.producer_name.localeCompare(b.producer_name);
  });
}

async function run() {
  const dbNames = await fetchDbProducerNames();
  const ftpFolders = await fetchFtpFolders();

  const rows = buildComparisonRows(dbNames, ftpFolders);

  const outputDir = path.resolve("reports");
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, "producer_ftp_alignment.csv");
  await fs.writeFile(outputPath, toCsv(rows), "utf8");

  const statusCounts = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  console.log(`Wrote ${rows.length} rows to ${outputPath}`);
  console.log("Counts by status:");
  for (const [status, count] of Object.entries(statusCounts)) {
    console.log(`- ${status}: ${count}`);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
