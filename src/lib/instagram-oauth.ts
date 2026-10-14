import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const PROVIDER = "instagram";
const DEFAULT_GRAPH_API_VERSION = "v24.0";

type MetaTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string };
};

type MetaPage = {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string };
};

type MetaPagesResponse = {
  data?: MetaPage[];
  error?: { message?: string };
};

type MetaMeResponse = {
  id?: string;
  error?: { message?: string };
};

type MetaPermissionsResponse = {
  data?: Array<{ permission?: string; status?: string }>;
};

export type InstagramConnection = {
  status: string;
  accountId: string;
  accountUsername: string | null;
  pageId: string;
  pageName: string | null;
  connectedAt: string;
  connectedByEmail: string | null;
  lastVerifiedAt: string | null;
  tokenExpiresAt: string | null;
};

export function isFacebookCrosspostEnabled() {
  return process.env.FACEBOOK_CROSSPOST_ENABLED?.trim().toLowerCase() !== "false";
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function graphVersion() {
  const value = process.env.INSTAGRAM_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(value)) {
    throw new Error("INSTAGRAM_GRAPH_API_VERSION must use a value such as v24.0.");
  }
  return value;
}

function graphUrl(path: string) {
  return new URL(`${path.replace(/^\//, "")}`, `https://graph.facebook.com/${graphVersion()}/`);
}

function adminSupabase() {
  return createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function encryptionKey() {
  const key = Buffer.from(requiredEnv("INSTAGRAM_TOKEN_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) {
    throw new Error("INSTAGRAM_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

export function encryptInstagramToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptInstagramToken(payload: string) {
  const [version, encodedIv, encodedTag, encodedCiphertext] = payload.split(".");
  if (version !== "v1" || !encodedIv || !encodedTag || !encodedCiphertext) {
    throw new Error("Stored Instagram token has an unsupported format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function getInstagramRedirectUri() {
  return requiredEnv("INSTAGRAM_OAUTH_REDIRECT_URI");
}

export function buildInstagramAuthorizationUrl(state: string) {
  const url = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`);
  url.searchParams.set("client_id", requiredEnv("INSTAGRAM_APP_ID"));
  url.searchParams.set("redirect_uri", getInstagramRedirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("config_id", requiredEnv("INSTAGRAM_LOGIN_CONFIG_ID"));
  return url;
}

async function metaJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok || body.error) {
    throw new Error(body.error?.message || `Meta API request failed with HTTP ${response.status}.`);
  }
  return body;
}

async function exchangeCode(code: string) {
  const shortTokenUrl = graphUrl("oauth/access_token");
  shortTokenUrl.searchParams.set("client_id", requiredEnv("INSTAGRAM_APP_ID"));
  shortTokenUrl.searchParams.set("client_secret", requiredEnv("INSTAGRAM_APP_SECRET"));
  shortTokenUrl.searchParams.set("redirect_uri", getInstagramRedirectUri());
  shortTokenUrl.searchParams.set("code", code);
  const shortToken = await metaJson<MetaTokenResponse>(shortTokenUrl);
  if (!shortToken.access_token) throw new Error("Meta did not return a user access token.");

  const longTokenUrl = graphUrl("oauth/access_token");
  longTokenUrl.searchParams.set("grant_type", "fb_exchange_token");
  longTokenUrl.searchParams.set("client_id", requiredEnv("INSTAGRAM_APP_ID"));
  longTokenUrl.searchParams.set("client_secret", requiredEnv("INSTAGRAM_APP_SECRET"));
  longTokenUrl.searchParams.set("fb_exchange_token", shortToken.access_token);
  const longToken = await metaJson<MetaTokenResponse>(longTokenUrl);
  if (!longToken.access_token) throw new Error("Meta did not return a long-lived user access token.");
  return longToken;
}

export async function connectInstagram(code: string, connectedByUserId: string, connectedByEmail: string | null) {
  const userToken = await exchangeCode(code);

  const meUrl = graphUrl("me");
  meUrl.searchParams.set("fields", "id");
  meUrl.searchParams.set("access_token", userToken.access_token!);
  const me = await metaJson<MetaMeResponse>(meUrl);
  if (!me.id) throw new Error("Meta did not return the connected user ID.");

  const pagesUrl = graphUrl("me/accounts");
  pagesUrl.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username}");
  pagesUrl.searchParams.set("access_token", userToken.access_token!);
  const pages = await metaJson<MetaPagesResponse>(pagesUrl);
  const eligiblePages = (pages.data || []).filter(
    (page): page is MetaPage & { access_token: string; instagram_business_account: { id: string; username?: string } } =>
      Boolean(page.access_token && page.instagram_business_account?.id),
  );
  if (eligiblePages.length === 0) {
    throw new Error("No Facebook Page with a connected professional Instagram account was returned.");
  }
  if (eligiblePages.length > 1) {
    throw new Error("More than one publishable Instagram account was returned. Limit the Meta configuration to Paranoise Radio.");
  }
  const page = eligiblePages[0];

  const permissionsUrl = graphUrl("me/permissions");
  permissionsUrl.searchParams.set("access_token", userToken.access_token!);
  const permissions = await metaJson<MetaPermissionsResponse>(permissionsUrl);
  const grantedScopes = (permissions.data || [])
    .filter((permission) => permission.status === "granted" && permission.permission)
    .map((permission) => permission.permission as string);
  if (isFacebookCrosspostEnabled() && !grantedScopes.includes("pages_manage_posts")) {
    throw new Error("Facebook publishing requires pages_manage_posts. Add it to the Meta login configuration, then reconnect.");
  }

  const expiresAt = typeof userToken.expires_in === "number"
    ? new Date(Date.now() + userToken.expires_in * 1000).toISOString()
    : null;
  const now = new Date().toISOString();
  const { error } = await adminSupabase().from("integration_connections").upsert({
    provider: PROVIDER,
    status: "connected",
    external_user_id: me.id,
    account_id: page.instagram_business_account.id,
    account_username: page.instagram_business_account.username || null,
    page_id: page.id,
    page_name: page.name || null,
    encrypted_access_token: encryptInstagramToken(page.access_token),
    token_expires_at: expiresAt,
    granted_scopes: grantedScopes,
    connected_by_user_id: connectedByUserId,
    connected_by_email: connectedByEmail,
    connected_at: now,
    last_verified_at: now,
    disconnected_at: null,
    data_deletion_code: null,
    data_deletion_requested_at: null,
    updated_at: now,
  }, { onConflict: "provider" });
  if (error) throw new Error(`Could not store the Instagram connection: ${error.message}`);
}

export async function getInstagramConnection(): Promise<InstagramConnection | null> {
  const { data, error } = await adminSupabase()
    .from("integration_connections")
    .select("status,account_id,account_username,page_id,page_name,connected_at,connected_by_email,last_verified_at,token_expires_at")
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error) throw new Error(`Could not read the Instagram connection: ${error.message}`);
  if (!data) return null;
  return {
    status: data.status,
    accountId: data.account_id,
    accountUsername: data.account_username,
    pageId: data.page_id,
    pageName: data.page_name,
    connectedAt: data.connected_at,
    connectedByEmail: data.connected_by_email,
    lastVerifiedAt: data.last_verified_at,
    tokenExpiresAt: data.token_expires_at,
  };
}

export async function getInstagramPublishingCredentials() {
  const { data, error } = await adminSupabase()
    .from("integration_connections")
    .select("account_id,page_id,encrypted_access_token,status")
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (error) throw new Error(`Could not read the Instagram connection: ${error.message}`);
  if (!data || data.status !== "connected" || !data.encrypted_access_token) {
    throw new Error("Instagram is not connected.");
  }
  return {
    accountId: data.account_id as string,
    pageId: data.page_id as string,
    accessToken: decryptInstagramToken(data.encrypted_access_token as string),
  };
}

export function getInstagramGraphUrl(path: string) {
  return graphUrl(path);
}

export async function disconnectInstagram() {
  const { error } = await adminSupabase().from("integration_connections").update({
    status: "disconnected",
    encrypted_access_token: null,
    disconnected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("provider", PROVIDER);
  if (error) throw new Error(`Could not disconnect Instagram: ${error.message}`);
}

function decodeBase64UrlJson(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function verifyMetaSignedRequest(signedRequest: string) {
  const [encodedSignature, encodedPayload] = signedRequest.split(".");
  if (!encodedSignature || !encodedPayload) throw new Error("Invalid signed_request format.");
  const expected = createHmac("sha256", requiredEnv("INSTAGRAM_APP_SECRET"))
    .update(encodedPayload)
    .digest();
  const supplied = Buffer.from(encodedSignature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new Error("Invalid signed_request signature.");
  }
  return decodeBase64UrlJson(encodedPayload);
}

export async function handleMetaDeauthorization(externalUserId: string) {
  const { error } = await adminSupabase().from("integration_connections").update({
    status: "revoked",
    encrypted_access_token: null,
    disconnected_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("provider", PROVIDER).eq("external_user_id", externalUserId);
  if (error) throw new Error(`Could not record Meta deauthorization: ${error.message}`);
}

export async function handleMetaDataDeletion(externalUserId: string) {
  const confirmationCode = randomBytes(24).toString("base64url");
  const now = new Date().toISOString();
  const { error } = await adminSupabase().from("integration_connections").update({
    status: "deletion_requested",
    encrypted_access_token: null,
    disconnected_at: now,
    data_deletion_code: confirmationCode,
    data_deletion_requested_at: now,
    updated_at: now,
  }).eq("provider", PROVIDER).eq("external_user_id", externalUserId);
  if (error) throw new Error(`Could not record Meta data deletion request: ${error.message}`);
  return confirmationCode;
}

export async function getDataDeletionStatus(code: string) {
  const { data, error } = await adminSupabase().from("integration_connections")
    .select("data_deletion_requested_at")
    .eq("provider", PROVIDER)
    .eq("data_deletion_code", code)
    .maybeSingle();
  if (error) throw new Error(`Could not read deletion status: ${error.message}`);
  return data?.data_deletion_requested_at || null;
}
