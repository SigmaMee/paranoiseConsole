import { google } from "googleapis";
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

export function createGoogleOAuth2Client() {
  const clientId = getRequiredEnv("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = getRequiredEnv("GOOGLE_OAUTH_CLIENT_SECRET");
  const redirectUri = getRequiredEnv("GOOGLE_OAUTH_REDIRECT_URI");

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getGoogleDriveOAuthAuthUrl() {
  const client = createGoogleOAuth2Client();

  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive"],
    include_granted_scopes: true,
  });
}

export async function upsertGoogleDriveOAuthTokens(
  code: string,
  updatedByEmail: string,
) {
  const client = createGoogleOAuth2Client();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Re-run connect flow and ensure consent prompt is shown.",
    );
  }

  const supabase = createAdminSupabaseClient();
  const { error } = await supabase.from("google_oauth_tokens").upsert(
    {
      provider: "google_drive",
      refresh_token: tokens.refresh_token,
      scope: tokens.scope || null,
      token_type: tokens.token_type || null,
      expiry_date: tokens.expiry_date || null,
      updated_by_email: updatedByEmail,
    },
    { onConflict: "provider" },
  );

  if (error) {
    throw new Error(`Failed to store OAuth tokens: ${error.message}`);
  }
}

export async function getStoredGoogleDriveRefreshToken() {
  const supabase = createAdminSupabaseClient();
  const { data, error } = await supabase
    .from("google_oauth_tokens")
    .select("refresh_token")
    .eq("provider", "google_drive")
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read OAuth token: ${error.message}`);
  }

  return data?.refresh_token || null;
}

export async function getGoogleDriveOAuthClientFromStoredToken() {
  const refreshToken = await getStoredGoogleDriveRefreshToken();
  if (!refreshToken) {
    return null;
  }

  const client = createGoogleOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
