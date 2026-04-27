# Gemini CLI Instructions for PPPoE Bandwidth Monitor

This file provides context and specific instructions for Gemini CLI when working within this project.

## Project Context
- **Type:** Web Service / Prometheus Exporter
- **Runtime:** Bun
- **Framework:** Hono
- **Language:** TypeScript
- **Purpose:** Fetches active PPPoE sessions from one or more MikroTik routers and compares their bandwidth limits against a central Database Gateway. If there's a discrepancy (mismatch >= tolerance), it exposes a metric for Prometheus alerting.

## Mandates and Conventions
- **Package Manager:** Strictly use `bun` for all package management tasks (e.g., `bun install`, `bun add`, `bun run`). Do NOT use `npm`, `yarn`, or `pnpm`.
- **Formatting:** The project uses Biome for formatting. Ensure all code modifications adhere to the established rules (`indentStyle: space`, `quoteStyle: single`, `semicolons: asNeeded`). You can format code manually by running `bun run format`.
- **Pre-commit Hooks:** The project uses Husky and `lint-staged`. Code is automatically formatted on commit.
- **Environment Variables:** Credentials and gateway URLs are stored in `.env`. Router configurations are stored in `routers.json`. Do NOT commit `.env` or `routers.json`. Use `.env.example` and `routers.example.json` for templates.
- **Metrics:** Ensure any new metrics follow Prometheus naming conventions (snake_case) and include appropriate HELP and TYPE comments.
- **Error Handling:** When interacting with external APIs (MikroTik or DB Gateway), ensure robust error handling and avoid crashing the main loop. Log errors with timestamps.