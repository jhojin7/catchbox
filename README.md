# Catchbox

Catchbox is a self-hosted, local-first capture inbox for text, URLs, images, and files. Its first priority is dependable input: accept a share locally, preserve it through connectivity failures, synchronize without duplicates, and keep the original data easy to export.

## Why Catchbox?

Sending something into an inbox should not depend on a perfect network connection. Catchbox treats capture as a durable workflow rather than a best-effort request:

- A client stores the complete capture locally before reporting success.
- One mixed share becomes a batch of independent items linked by a batch ID.
- Stable client IDs make retries and ambiguous-response reconciliation idempotent.
- Successful items survive when a sibling item fails.
- Original attachment bytes are preserved; previews and extracted content are reproducible.
- Slow metadata and extraction work never delays capture persistence.

## Planned v1

Catchbox v1 will provide:

- A responsive PWA for quick capture and a chronological inbox.
- Android and iOS share integrations for text, URLs, images, and arbitrary files.
- A documented authenticated HTTP interface for scripts and future clients.
- Durable client outboxes with automatic retry, manual retry, discard, and reconciliation.
- Clear pending, synced, and failed states.
- Authenticated attachment downloads and a portable metadata-plus-originals export.
- A single-user, ARM64-compatible Compose deployment for a trusted local network.
- Backup, restore, migration, health-check, and recovery procedures.

Authentication remains mandatory for every data and attachment route, even on the LAN.

## Planned architecture

The project will use a Bun workspace monorepo with TypeScript wherever practical:

```text
apps/
  web/          React + Vite PWA
  api/          Express 5 HTTP server
  worker/       Asynchronous jobs
clients/
  android/      Android share target
  ios/          iOS share extension
packages/
  db/           Drizzle schema, migrations, and repositories
  shared/       Zod contracts and shared domain types
services/
  extractor/    Isolated Python text extraction
infra/          Local container and Compose assets
```

Server metadata will live in SQLite using Drizzle migrations. Original attachments will live in a configurable server-owned filesystem directory and become ready only after an atomic final write. Derived work will run through durable jobs outside the capture request.

## Core reliability invariants

Contributions must preserve these rules:

1. A mixed share is a batch of independently stored items linked by `batch_id`.
2. A client persists input locally before reporting capture success.
3. Network retries cannot create duplicate batches or items.
4. Capture persistence does not wait for previews, metadata extraction, OCR, or indexing.
5. Original attachment bytes are authoritative and preserved.
6. Every data and attachment route requires authentication.

## Project status and roadmap

The implementation will proceed in small vertical slices:

1. Workspace, shared contracts, configuration, logging, and automated checks.
2. SQLite migrations, attachment storage, backup, and restore.
3. Account bootstrap, sessions, authorization, and password changes.
4. Idempotent batch ingestion, reconciliation, and authenticated downloads.
5. PWA quick capture, durable outbox, retry behavior, and inbox.
6. Worker jobs and isolated extraction.
7. Android and iOS share integrations.
8. ARM64 deployment, export, operations documentation, and recovery drills.

## Documentation

- [Implementation plan](PLAN.md) — product scope, architecture, interfaces, and delivery sequence.
- [Catchbox v1 specification](https://github.com/jhojin7/catchbox/issues/1) — implementation-ready behavior, user stories, decisions, and acceptance strategy.
- [Agent guide](AGENTS.md) — repository invariants, conventions, and quality gates for contributors and coding agents.

## Contributing

Implementation tickets will be derived from the v1 specification and linked through explicit blocking relationships. Work should proceed blockers-first, one small vertical slice at a time, with tests at the highest observable seam.

Before contributing, read the implementation plan and agent guide. Do not expand v1 into collaboration, public hosting, Postgres, S3 storage, semantic search, OCR, reminders, or full note-editor parity unless that scope is explicitly changed.
