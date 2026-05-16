import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ensureRuntimeEnvLoaded,
  readRuntimeEnv,
} from "@/lib/env/load-runtime-env";

export type TikTokOAuthCredentials = {
  appKey: string;
  appSecret: string;
  source: "env" | "connection";
  connectionId: string | null;
};

export type TikTokOAuthCredentialsDebug = {
  resolutionOrder: Array<"connection" | "env">;
  runtimeEnv: {
    projectDir: string;
    envLocalPath: string;
    envLocalExists: boolean;
    loadedFilePaths: string[];
  };
  env: {
    appKeyPresent: boolean;
    appKeyLength: number;
    appSecretPresent: boolean;
    appSecretLength: number;
  };
  connection: {
    attempted: boolean;
    requestedConnectionId: string | null;
    rowFound: boolean;
    connectionId: string | null;
    appKeyPresent: boolean;
    appKeyLength: number;
    appSecretPresent: boolean;
    appSecretLength: number;
    error: string | null;
  };
  selectedSource: TikTokOAuthCredentials["source"] | null;
};

export type ResolveTikTokOAuthCredentialsResult = {
  data: TikTokOAuthCredentials | null;
  error: string | null;
  debug: TikTokOAuthCredentialsDebug;
};

const ENV_APP_KEY = "TIKTOK_SHOP_APP_KEY";
const ENV_APP_SECRET = "TIKTOK_SHOP_APP_SECRET";

function readEnvValue(name: string): string | null {
  const value = readRuntimeEnv(name);
  return value ?? null;
}

function buildRuntimeEnvDebug(): TikTokOAuthCredentialsDebug["runtimeEnv"] {
  const runtimeEnv = ensureRuntimeEnvLoaded();
  return {
    projectDir: runtimeEnv.projectDir,
    envLocalPath: runtimeEnv.envLocalPath,
    envLocalExists: runtimeEnv.envLocalExists,
    loadedFilePaths: runtimeEnv.loadedFilePaths,
  };
}

function buildEnvDebug(): TikTokOAuthCredentialsDebug["env"] {
  const appKey = readEnvValue(ENV_APP_KEY);
  const appSecret = readEnvValue(ENV_APP_SECRET);

  return {
    appKeyPresent: appKey !== null,
    appKeyLength: appKey?.length ?? 0,
    appSecretPresent: appSecret !== null,
    appSecretLength: appSecret?.length ?? 0,
  };
}

function readEnvCredentials(): TikTokOAuthCredentials | null {
  const appKey = readEnvValue(ENV_APP_KEY);
  const appSecret = readEnvValue(ENV_APP_SECRET);
  if (!appKey || !appSecret) {
    return null;
  }

  return {
    appKey,
    appSecret,
    source: "env",
    connectionId: null,
  };
}

function buildConnectionCredentials(
  row: { id?: unknown; app_key?: unknown; app_secret?: unknown },
  connectionId: string,
): TikTokOAuthCredentials | null {
  const appKey = String(row.app_key ?? "").trim();
  const appSecret = String(row.app_secret ?? "").trim();
  if (!appKey || !appSecret) {
    return null;
  }

  return {
    appKey,
    appSecret,
    source: "connection",
    connectionId,
  };
}

async function readConnectionCredentials(
  supabase: SupabaseClient,
  connectionId?: string | null,
): Promise<{
  data: TikTokOAuthCredentials | null;
  debug: TikTokOAuthCredentialsDebug["connection"];
}> {
  const requestedConnectionId = connectionId?.trim() || null;
  const debug: TikTokOAuthCredentialsDebug["connection"] = {
    attempted: true,
    requestedConnectionId,
    rowFound: false,
    connectionId: null,
    appKeyPresent: false,
    appKeyLength: 0,
    appSecretPresent: false,
    appSecretLength: 0,
    error: null,
  };

  if (requestedConnectionId) {
    const { data, error } = await supabase
      .from("tiktok_api_connections")
      .select("id, app_key, app_secret")
      .eq("id", requestedConnectionId)
      .maybeSingle();

    if (error) {
      debug.error = error.message;
      return { data: null, debug };
    }

    if (!data?.id) {
      return { data: null, debug };
    }

    debug.rowFound = true;
    debug.connectionId = String(data.id);
    const appKey = String(data.app_key ?? "").trim();
    const appSecret = String(data.app_secret ?? "").trim();
    debug.appKeyPresent = appKey.length > 0;
    debug.appKeyLength = appKey.length;
    debug.appSecretPresent = appSecret.length > 0;
    debug.appSecretLength = appSecret.length;

    return {
      data: buildConnectionCredentials(data, debug.connectionId),
      debug,
    };
  }

  const { data, error } = await supabase
    .from("tiktok_api_connections")
    .select("id, app_key, app_secret")
    .order("updated_at", { ascending: false });

  if (error) {
    debug.error = error.message;
    return { data: null, debug };
  }

  for (const row of data ?? []) {
    const connectionRowId = String(row.id ?? "").trim();
    if (!connectionRowId) {
      continue;
    }

    const appKey = String(row.app_key ?? "").trim();
    const appSecret = String(row.app_secret ?? "").trim();
    if (!appKey || !appSecret) {
      continue;
    }

    debug.rowFound = true;
    debug.connectionId = connectionRowId;
    debug.appKeyPresent = true;
    debug.appKeyLength = appKey.length;
    debug.appSecretPresent = true;
    debug.appSecretLength = appSecret.length;

    return {
      data: buildConnectionCredentials(row, connectionRowId),
      debug,
    };
  }

  return { data: null, debug };
}

export async function resolveTikTokOAuthCredentials(
  supabase: SupabaseClient,
  connectionId?: string | null,
): Promise<ResolveTikTokOAuthCredentialsResult> {
  const debug: TikTokOAuthCredentialsDebug = {
    resolutionOrder: ["connection", "env"],
    runtimeEnv: buildRuntimeEnvDebug(),
    env: buildEnvDebug(),
    connection: {
      attempted: false,
      requestedConnectionId: connectionId?.trim() || null,
      rowFound: false,
      connectionId: null,
      appKeyPresent: false,
      appKeyLength: 0,
      appSecretPresent: false,
      appSecretLength: 0,
      error: null,
    },
    selectedSource: null,
  };

  const connectionResult = await readConnectionCredentials(supabase, connectionId);
  debug.connection = connectionResult.debug;

  if (connectionResult.data) {
    debug.selectedSource = "connection";
    return { data: connectionResult.data, error: null, debug };
  }

  const fromEnv = readEnvCredentials();
  debug.env = buildEnvDebug();
  if (fromEnv) {
    debug.selectedSource = "env";
    return { data: fromEnv, error: null, debug };
  }

  if (connectionId?.trim()) {
    return {
      data: null,
      error: "指定した接続に app_key / app_secret が設定されていません",
      debug,
    };
  }

  if (debug.connection.error) {
    return {
      data: null,
      error: debug.connection.error,
      debug,
    };
  }

  return {
    data: null,
    error:
      "TikTok Shop の app_key / app_secret が未設定です。接続設定に保存するか、環境変数 TIKTOK_SHOP_APP_KEY / TIKTOK_SHOP_APP_SECRET を設定してください。",
    debug,
  };
}
