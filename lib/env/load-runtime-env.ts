import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

type RuntimeEnvSnapshot = {
  projectDir: string;
  envLocalPath: string;
  envLocalExists: boolean;
  loadedFilePaths: string[];
};

let initialized = false;
let snapshot: RuntimeEnvSnapshot | null = null;

function buildSnapshot(loadedFilePaths: string[]): RuntimeEnvSnapshot {
  const projectDir = process.cwd();
  const envLocalPath = path.join(projectDir, ".env.local");

  return {
    projectDir,
    envLocalPath,
    envLocalExists: existsSync(envLocalPath),
    loadedFilePaths,
  };
}

export function ensureRuntimeEnvLoaded(force = false): RuntimeEnvSnapshot {
  if (initialized && !force && snapshot) {
    return snapshot;
  }

  const { loadedEnvFiles } = loadEnvConfig(
    process.cwd(),
    process.env.NODE_ENV !== "production",
    undefined,
    force,
  );

  snapshot = buildSnapshot(loadedEnvFiles.map((file) => file.path));
  initialized = true;
  return snapshot;
}

export function readRuntimeEnv(name: string): string | undefined {
  ensureRuntimeEnvLoaded();
  const value = process.env[name];
  if (value == null) {
    return undefined;
  }

  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readRuntimeEnvPresence(names: string[]): Record<string, boolean> {
  ensureRuntimeEnvLoaded();
  return Object.fromEntries(names.map((name) => [name, readRuntimeEnv(name) !== undefined]));
}
