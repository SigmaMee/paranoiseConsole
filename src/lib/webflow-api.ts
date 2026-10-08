const WEBFLOW_API_BASE = "https://api.webflow.com/v2";

export const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID || "6083f5777a8a723f8b5d9a6f";
export const WEBFLOW_RESIDENTS_COLLECTION_ID =
  process.env.WEBFLOW_RESIDENTS_COLLECTION_ID || "6083f919fa3c2258f1cd9ca2";
export const WEBFLOW_SHOWS_COLLECTION_ID =
  process.env.WEBFLOW_SHOWS_COLLECTION_ID || "65326284a02877d79b4e8f5d";

function getToken() {
  const token = process.env.WEBFLOW_API_TOKEN;
  if (!token) throw new Error("Missing required environment variable: WEBFLOW_API_TOKEN");
  return token;
}

async function webflowRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${WEBFLOW_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Webflow request failed (${response.status}): ${body}`);
  }

  return response.json();
}

function normalizeName(value: string) {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en");
}

export async function findResidentItemId(producerName: string): Promise<string> {
  const matches: string[] = [];
  let offset = 0;

  while (true) {
    const data = (await webflowRequest(
      `/collections/${WEBFLOW_RESIDENTS_COLLECTION_ID}/items?limit=100&offset=${offset}`,
    )) as { items?: Array<{ id?: string; fieldData?: { name?: string } }> };
    const items = data.items || [];

    for (const item of items) {
      if (
        item.id &&
        typeof item.fieldData?.name === "string" &&
        normalizeName(item.fieldData.name) === normalizeName(producerName)
      ) {
        matches.push(item.id);
      }
    }

    if (items.length < 100) break;
    offset += items.length;
  }

  if (matches.length === 0) {
    throw new Error(`No Webflow Resident matches producer "${producerName}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple Webflow Residents match producer "${producerName}".`);
  }
  return matches[0];
}

export function toWebflowSlug(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 240) || "radio-show";
}

export async function createPublishedShow(params: {
  name: string;
  slug: string;
  imageUrl: string;
  residentItemId: string;
  mixcloudUrl: string;
}) {
  const data = (await webflowRequest(
    `/collections/${WEBFLOW_SHOWS_COLLECTION_ID}/items/live?skipInvalidFiles=false`,
    {
      method: "POST",
      body: JSON.stringify({
        isArchived: false,
        isDraft: false,
        fieldData: {
          name: params.name,
          slug: params.slug,
          image: { url: params.imageUrl, alt: `${params.name} cover` },
          resident: params.residentItemId,
          mixcloud: params.mixcloudUrl,
        },
      }),
    },
  )) as { id?: string };

  if (!data.id) throw new Error("Webflow did not return a CMS item ID.");
  return data.id;
}
