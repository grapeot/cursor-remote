# cursor_cloud_remote_poc local notes

This project is a technical validation for a Cursor Cloud SDK remote-control style web app.

## Structure

- `docs/prd.md` defines product scope and success criteria.
- `docs/rfc.md` defines architecture and API boundaries.
- `docs/working.md` records daily changes and lessons learned. Update it after meaningful changes.
- `docs/test.md` defines the test strategy and validation contract.
- `src/server/` contains the Node/Express backend and Cursor SDK wrapper.
- `src/shared/` contains shared TypeScript contracts used by backend and frontend.
- `frontend/` contains the React + Vite app.
- `tests/` contains backend and shared unit tests.

## Engineering rules

- Keep Cursor API keys server-side only. Never expose `CURSOR_API_KEY` to frontend code.
- The default backend runs in mock mode unless `CURSOR_API_KEY` is present and `CURSOR_RUNTIME=cloud` or `local` is configured.
- Avoid `as any`, `@ts-ignore`, and `@ts-expect-error`.
- Prefer typed adapters over leaking raw SDK objects into route handlers.
- Update `docs/working.md` whenever implementation direction or known constraints change.

## Commands

- **Running tests**: `npm test` / `vitest` only spin up ephemeral HTTP listeners (`listen(0)` inside test files). Do **not** start `npm run dev`, `npm run dev:server`, or `npm run dev:frontend` before tests; the engineer may already be using `:8787` / `:5173` / `:5177` manually, and parallel dev servers cause confusion even when ports differ.
- Install dependencies: `npm install`
- Development: `npm run dev`
- Backend only: `npm run dev:server`
- Frontend only: `npm run dev:frontend`
- Typecheck: `npm run typecheck`
- Unit tests: `npm test`
- Coverage: `npm run coverage`
- Build: `npm run build`
