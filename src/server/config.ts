import 'dotenv/config';
import { runtimeSchema, type CursorRuntime } from '../shared/contracts.js';

export interface AppConfig {
  port: number;
  cursorApiKey?: string | undefined;
  runtime: CursorRuntime;
  localCwd?: string | undefined;
  defaultRepoUrl?: string | undefined;
  defaultRef: string;
  defaultModel: string;
}

function optionalEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsedPort = Number(env.PORT ?? '8787');
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 8787;
  const runtime = runtimeSchema.catch('mock').parse(env.CURSOR_RUNTIME);

  return {
    port,
    cursorApiKey: optionalEnv(env.CURSOR_API_KEY),
    runtime,
    localCwd: optionalEnv(env.CURSOR_LOCAL_CWD),
    defaultRepoUrl: optionalEnv(env.CURSOR_DEFAULT_REPO_URL),
    defaultRef: optionalEnv(env.CURSOR_DEFAULT_REF) ?? 'main',
    defaultModel: optionalEnv(env.CURSOR_DEFAULT_MODEL) ?? 'composer-2'
  };
}
