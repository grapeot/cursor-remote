# Cursor Remote

This project tests whether Cursor SDK can support a remote-control style experience: a browser UI sends prompts to a small backend running on your Mac, and the backend starts Cursor agent runs without exposing Cursor credentials to the client.

The default mode is mock mode, so the app is runnable before a Cursor API key is available.

## Quick start

```bash
npm install
cp .env.example .env
# Edit .env: set CURSOR_API_KEY from Cursor account / developer settings (see below).
npm run dev
```

Open `http://localhost:5177`. The backend listens on `http://localhost:8787`.

### API key

1. Create or obtain a **Cursor API key** from Cursor’s account / developer settings.
2. Put it in `.env` as `CURSOR_API_KEY=…` (plaintext is fine for local dev).

Optional: store the secret in **1Password** (or another manager) and inject it when you launch Node. Example only — vault and item names are fictional:

```bash
# Illustration: substitute your own vault/item path and CLI.
CURSOR_API_KEY="op://AcmeCorp Dev Vault/Example Item/api_token" npm run dev
```

If you are not using a secret manager, you do not need that step; just paste the API key into `.env`.

### Minimal MVP (Python hello world)

1. Set `CURSOR_RUNTIME=local` and `CURSOR_LOCAL_CWD=.` (repo root — the folder that contains `mvp_sandbox/`), or another path relative to where you start the backend.
2. Ensure `CURSOR_API_KEY` is set in `.env`.
3. Start the stack with `npm run dev`.
4. In the UI, use **Fill Python hello world prompt** / **Use smoke prompt** (mock mode), or paste your task and **Send**.
5. Confirm the file exists and runs: `python3 mvp_sandbox/hello_world.py` → `Hello, world!`

CLI shortcut (same SDK path as the server, no browser):

```bash
npm run mvp:run
```

Loads `.env` via `dotenv` (see `scripts/run_mvp_once.ts`).

## Real local Cursor SDK validation

The Node backend runs on the machine that holds your checkout, so Cursor SDK can access local files through `CURSOR_LOCAL_CWD`.

1. Set `CURSOR_API_KEY`, `CURSOR_RUNTIME=local`, and `CURSOR_LOCAL_CWD` (`.` or another directory).
2. Restart `npm run dev` and submit a prompt.

The browser only talks to this backend. If you expose it beyond localhost, use your own tunnel or VPN (for example Tailscale); do not put the Cursor key in the client.

## Real cloud Cursor SDK validation

Comparison path — not primary for local-file remote control.

1. Set `CURSOR_RUNTIME=cloud` and `CURSOR_DEFAULT_REPO_URL=https://github.com/<owner>/<repo>`.
2. Restart `npm run dev` and submit a prompt.

## Commands

```bash
npm run typecheck
npm test
npm run coverage
npm run build
```

## Current scope

- Create or resume a session in the browser.
- Create a session-scoped run from a prompt without blocking the HTTP response.
- Stream run lifecycle events to the browser over SSE.
- List session-scoped runs and messages from server-side projections.
- Use mock mode without credentials.
- Keep a typed server-side seam for Cursor SDK calls.
- Support both `local` and `cloud` runtime configuration, with local runtime as the target product path.

Not implemented yet:

- Reconnecting to an existing Cursor run after server restart.
- Fetching diffs, file changes, or PR URLs from completed runs.
- User auth for exposing this service beyond localhost.
