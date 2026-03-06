import { createClient } from "@supabase/supabase-js";

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function createAdminSupabaseClient() {
  const url = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, serviceRoleKey);
}

export function getMixcloudOAuthRedirectUri() {
  if (process.env.MIXCLOUD_OAUTH_REDIRECT_URI) {
    return process.env.MIXCLOUD_OAUTH_REDIRECT_URI;
  }

  const base = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
  return new URL("/api/mixcloud/oauth/callback", base).toString();
}

export function getMixcloudOAuthAuthUrl() {
  const clientId = getRequiredEnv("MIXCLOUD_CLIENT_ID");
  const redirectUri = getMixcloudOAuthRedirectUri();

  const url = new URL("https://www.mixcloud.com/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
}

function extractAccessTokenFromResponse(body: string) {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed.access_token === "string" ? parsed.access_token : null;
    } catch {
      return null;
    }
  }

  const params = new URLSearchParams(trimmed);
  return params.get("access_token");
}

export async function upsertMixcloudAccessToken(code: string, updatedByEmail: string) {
  const clientId = getRequiredEnv("MIXCLOUD_CLIENT_ID");
  const clientSecret = getRequiredEnv("MIXCLOUD_CLIENT_SECRET");
  const redirectUri = getMixcloudOAuthRedirectUri();

  const tokenUrl = new URL("https://www.mixcloud.com/oauth/access_token");
  tokenUrl.searchParams.set("client_id", clientId);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("client_secret", clientSecret);
  tokenUrl.searchParams.set("code", code);

  const response = await fetch(tokenUrl.toString(), { method: "GET" });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Failed to fetch Mixcloud access token: ${body || response.statusText}`);
  }

  const accessToken = extractAccessTokenFromResponse(body);
  if (!accessToken) {
    throw new Error("Mixcloud did not return an access token.");
  }

  const supabase = createAdminSupabaseClient();
  const { error } = await supabase.from("google_oauth_tokens").upsert(
    {
      provider: "mixcloud",
      refresh_token: accessToken,
      scope: null,
      token_type: "Bearer",
      expiry_date: null,
      updated_by_email: updatedByEmail,
    },
    { onConflict: "provider" },
  );

  if (error) {
    throw new Error(`Failed to store Mixcloud access token: ${error.message}`);
  }
}

export async function getStoredMixcloudAccessToken() {
  const supabase = createAdminSupabaseClient();
  const { data, error } = await supabase
    .from("google_oauth_tokens")
    .select("refresh_token")
    .eq("provider", "mixcloud")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read Mixcloud OAuth token: ${error.message}`);
  }

  return data?.refresh_token || null;
}
