# Cursor Cloud Remote POC

This project tests whether Cursor SDK can support a remote-control style experience: a browser UI sends prompts to a small backend running on your Mac, and the backend starts Cursor agent runs without exposing Cursor credentials to the client.

The default mode is mock mode, so the app is runnable before a Cursor API key is available.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Open `http://localhost:5177`. The backend listens on `http://localhost:8787`.

### Cursor API key via 1Password CLI

If `CURSOR_API_KEY` in `.env` is a secret reference (for example `op://dev/dev-api-keys/cursor_api_key`), start with **`npm run dev:op`** or **`./scripts/dev-op.sh`** so `op run` resolves it before `npm run dev`. Plain `npm run dev` would leave the literal `op://…` string in the environment.

### Minimal MVP (Python hello world)

1. Set `CURSOR_RUNTIME=local` and `CURSOR_LOCAL_CWD` to the **absolute path of this project root** (the folder that contains `mvp_sandbox/`).
2. Configure `CURSOR_API_KEY` (plaintext or `op://…` reference).
3. Start the stack (`npm run dev:op` if the key uses 1Password references).
4. In the UI click **Run MVP: Python hello world**, or edit the prompt and use **Start Cursor run**. The backend waits for the SDK run to finish and shows `completed` or `failed`.
5. Confirm the file exists and runs: `python3 mvp_sandbox/hello_world.py` → `Hello, world!`

CLI shortcut (same SDK path as the server, no browser):

```bash
npm run mvp:run
```

Uses `op run` when `CURSOR_API_KEY` in `.env` is an `op://` reference. Plain key already in the environment: `npm run mvp:run:plain`.

## Real local Cursor SDK validation

This is the main path for the remote-control product idea. The Node backend runs on the same machine that has your code checkout, so Cursor SDK can access local files through `CURSOR_LOCAL_CWD`.

1. Create or obtain a Cursor API key from Cursor's account / developer settings.
2. Put it in `.env` as `CURSOR_API_KEY=...`.
3. Set `CURSOR_RUNTIME=local`.
4. Set `CURSOR_LOCAL_CWD=/absolute/path/to/your/repo`.
5. Restart `npm run dev` and submit a prompt.

The browser or phone talks only to this backend. If you want to access it from outside your LAN, expose this backend through your own secure tunnel or HTTPS endpoint, not by putting the Cursor key in the client.

## Real cloud Cursor SDK validation

Cloud mode is still useful as a comparison path, but it is not the primary validation for local-file remote control.

1. Create or obtain a Cursor API key from Cursor's account / developer settings.
2. Put it in `.env` as `CURSOR_API_KEY=...`.
3. Set `CURSOR_RUNTIME=cloud`.
4. Set `CURSOR_DEFAULT_REPO_URL=https://github.com/<owner>/<repo>` or enter a repo URL in the UI.
5. Restart `npm run dev` and submit a prompt.

The frontend never receives the Cursor API key. It only talks to this project's local `/api/*` endpoints.

## Commands

```bash
npm run typecheck
npm test
npm run coverage
npm run build
```

## Current scope

- Create a run from a prompt.
- List locally known runs.
- Use mock mode without credentials.
- Keep a typed server-side seam for Cursor SDK calls.
- Support both `local` and `cloud` runtime configuration, with local runtime as the target product path.

Not implemented yet:

- Streaming Cursor run events to the browser.
- Reconnecting to an existing Cursor run after server restart.
- Fetching diffs, file changes, or PR URLs from completed runs.
- User auth for exposing this service beyond localhost.
