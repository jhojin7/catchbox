# Catchbox Agent Guide

## Mission

Build a dependable self-hosted capture inbox. The input layer is the product priority: receiving, persisting, retrying, and exporting shared data matters more than recreating Google Keep's editing UI.

Read `PLAN.md` before making architectural or product decisions. Treat it as the source of truth until the user explicitly changes it.

## Non-negotiable invariants

- A mixed OS share is a batch of independently stored items linked by `batch_id`.
- A client persists input locally before reporting capture success.
- Network retries are idempotent and must not create duplicate batches or items.
- Capture persistence does not wait for previews, metadata extraction, OCR, or indexing.
- Original attachment bytes are preserved; derived content is disposable and reproducible.
- Every data and attachment route requires authentication.
- v1 uses Express 5, Drizzle, SQLite, and a simple local username/password account.
- Keep SQL and repository design portable enough for a later Postgres migration, but do not implement Postgres prematurely.

## Repository conventions

- Use Bun workspaces and TypeScript for the web, API, worker, shared contracts, and database packages.
- Keep Python extraction isolated under `services/extractor`.
- Define external request and response contracts in `packages/shared` with Zod. Do not expose Drizzle row shapes as API contracts.
- Add schema changes only through committed Drizzle migrations.
- Keep secrets and runtime data out of Git. Commit `.env.example`, never `.env`.
- Store runtime SQLite files, sessions, uploads, previews, and extraction artifacts under configurable data directories ignored by Git.
- Prefer small vertical slices with tests over broad unverified scaffolding.

## Quality gates

Before calling a change complete, run the relevant type checks, unit/integration tests, and build. For capture-path changes, also test offline/retry and duplicate-submission behavior. For schema or storage changes, test migration plus backup/restore. Do not silently weaken tests or validation to make a check pass.

## Scope discipline

Do not add collaboration, public internet exposure, Postgres support, S3 storage, semantic search, OCR, reminders, or full note-editor parity unless the user explicitly brings that feature into scope. When a choice is not covered by `PLAN.md`, prefer the smallest reversible design and record the assumption.
