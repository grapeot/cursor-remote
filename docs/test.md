# Test Strategy

## Unit tests

Unit tests cover code that should remain deterministic without Cursor credentials:

- `loadConfig()` parses environment variables and defaults safely.
- `RunStore` stores and orders run summaries.
- Express routes validate requests, report health, create runs through an injected gateway, and list runs.

## Integration tests

Live Cursor SDK integration is intentionally excluded from default tests because it requires a real API key and may spend Cursor usage credits.

Future live integration tests should run only when `RUN_CURSOR_LIVE_TESTS=1` and `CURSOR_API_KEY` are present.

## Frontend validation

The first version relies on TypeScript build validation for the React app. Browser e2e tests are deferred until the real SDK flow is confirmed.

## Validation contract

For a normal development change, run:

```bash
npm run typecheck
npm test
npm run build
```

For coverage reporting, run:

```bash
npm run coverage
```

The project is considered healthy when typecheck, tests, coverage generation, and build all pass without requiring Cursor credentials.

Vitest runs test files serially in a single fork because importing the Cursor SDK can initialize native/platform packages. Serial execution keeps default tests deterministic while the live SDK boundary is still under validation.
