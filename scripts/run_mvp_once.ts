/**
 * One-shot local SDK smoke test: writes mvp_sandbox/hello_world.py under CURSOR_LOCAL_CWD.
 *
 * Prefer (1Password key reference in .env):
 *   npm run mvp:run
 *
 * Or plain env already exported:
 *   npm run mvp:run:plain
 */
import 'dotenv/config';
import { loadConfig } from '../src/server/config.js';
import { createCursorGateway } from '../src/server/cursorAgent.js';

const MVP_PYTHON_HELLO_PROMPT = `In this repo, create or overwrite the file mvp_sandbox/hello_world.py with exactly:

print("Hello, world!")

Use nothing else in that file (no shebang, no imports). If mvp_sandbox/ does not exist, create it.`;

async function main(): Promise<void> {
  const config = loadConfig();
  console.error('[mvp] runtime=%s localCwd=%s hasKey=%s', config.runtime, config.localCwd ?? '(unset)', Boolean(config.cursorApiKey));
  console.error('[mvp] starting Cursor SDK run (often minutes on first call)…');

  const gateway = createCursorGateway(config);
  const run = await gateway.startRun({ prompt: MVP_PYTHON_HELLO_PROMPT });

  console.log(JSON.stringify(run, null, 2));
  console.error('[mvp] done status=%s id=%s', run.status, run.id);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
