# Catchbox — v1 Implementation Plan

## 1. Product definition

Catchbox is a self-hosted, local-first capture inbox. Its first milestone is not a complete Google Keep replacement: it succeeds when sending information into Catchbox from other apps is fast, reliable, and easy to recover or export.

The initial deployment target is a single ARM64 home server on a trusted local network. Access still requires a normal username/password login. Postgres, collaboration, public hosting, and a polished knowledge-management UI are deliberately deferred.

### v1 success criteria

- Capture text, URLs, images, and arbitrary files from the web UI and supported OS share sheets.
- Never lose an accepted capture because connectivity disappears mid-share.
- Show every capture in one chronological inbox with clear pending, synced, and failed states.
- Preserve original attachment bytes and enough source metadata to export or migrate the data later.
- Keep the HTTP API straightforward so new capture clients can be added without changing the database directly.

## 2. Capture behavior

### Input surfaces

1. Responsive web/PWA quick capture for text, URLs, clipboard contents, drag-and-drop, and file selection.
2. Android share target for shared text, URLs, images, and files.
3. iOS share extension for the same supported types.
4. A documented authenticated HTTP capture endpoint for scripts and future integrations.

Native share integrations may be thin wrappers, but they must write to the same local outbox contract as the PWA and use the same server API.

### Share batches and item boundaries

A single OS share action creates one `capture_batch`. Its payload is split into independent `capture_item` records so each shared attachment can be searched, retried, edited, or deleted separately. Shared text or a URL becomes its own item when present. Every resulting item retains the same `batch_id`, preserving the relationship and allowing the UI to display the group together.

This avoids treating a mixed share as one indivisible note while still preserving its original context.

### Offline and failure behavior

- The client assigns stable UUIDs before network submission and persists the complete pending batch locally.
- The UI acknowledges capture only after the local transaction succeeds.
- An outbox retries automatically with bounded exponential backoff when connectivity returns.
- Submission is idempotent by `(user_id, client_batch_id)` and `(user_id, client_item_id)`; retries must never duplicate data.
- Unsupported or inaccessible shared files remain visible as failed items with an actionable error. Successfully persisted siblings are not rolled back.
- The client exposes manual retry and discard for failed outbox entries.

## 3. Technical architecture

Use a Bun workspace monorepo with TypeScript wherever practical:

```text
apps/
  web/          React + Vite PWA, responsive inbox and quick capture
  api/          Express 5 JSON/multipart API
  worker/       asynchronous metadata and extraction jobs
clients/
  android/      Android share target
  ios/          iOS share extension
packages/
  db/           Drizzle schema, SQLite migrations, repositories
  shared/       Zod API contracts and shared domain types
services/
  extractor/    isolated Python document/text extraction service
infra/          local Docker/Compose deployment assets
```

### Client

- React, Vite, and TypeScript.
- Dexie/IndexedDB stores the local inbox cache, complete outbox payloads, attempt counts, and last errors.
- A service worker provides the installable shell and resumes eligible sync work; foreground startup also drains the outbox because background execution is platform-dependent.
- TanStack Query may manage server state, but Dexie is the durable authority for unsent input.
- Use accessible, keyboard-friendly components; shadcn/ui is acceptable as a starting point rather than a visual constraint.

### Server

- Express 5 on Bun, with Zod validation at every HTTP boundary.
- Drizzle ORM over SQLite in WAL mode. Use portable SQL types and repository boundaries so a later Postgres migration does not leak into clients, but do not build or test Postgres in v1.
- Store attachment metadata in SQLite and bytes in a server-owned filesystem directory. Writes use a temporary file plus atomic rename; a database row becomes ready only after the final file exists.
- The worker owns slow preview, metadata, and text-extraction jobs. API requests persist first and return without waiting for extraction.
- Run extraction in a separate Python service/process so parsing libraries and crashes do not destabilize the API.

### Authentication

- One local account in v1, with a unique username and an Argon2id password hash.
- Bootstrap credentials come from deployment configuration and must be changed through an authenticated password-change flow.
- Browser clients use an opaque server-side session in an `HttpOnly`, `SameSite=Strict` cookie. Sessions have idle and absolute expiry and are revoked on password change.
- Native clients authenticate through a login endpoint and store a revocable opaque token in the platform secure store.
- All capture, file, inbox, and export routes require authentication even on the LAN.

### Data model

- `users`: identity, password hash, password/session version, timestamps.
- `sessions`: hashed token, user, client kind, expiry, last-used and revoked timestamps.
- `capture_batches`: server UUID, user, client UUID, source app/platform, share timestamp, receive timestamp.
- `capture_items`: server UUID, batch, client UUID, type (`text`, `url`, `image`, `file`), text/URL fields, processing state, inbox state, timestamps.
- `attachments`: item, original filename, media type, byte size, checksum, storage key, extraction status and error.
- `jobs`: job kind, target, state, attempt count, next attempt, lease and error fields.

Use UUIDs and explicit timestamps. Avoid SQLite-only identifiers and implicit row ordering.

## 4. Public interfaces

All endpoints are versioned under `/api/v1` and return a consistent error envelope containing `code`, `message`, and optional field details.

- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password`
- `POST /capture-batches`: multipart or JSON batch ingestion; returns per-item results and is idempotent by client IDs
- `GET /captures`: cursor-paginated inbox, filterable by state and type
- `GET /captures/:id`, `PATCH /captures/:id`, `DELETE /captures/:id`
- `GET /attachments/:id/content`: authenticated download with safe content headers
- `POST /outbox/status`: efficiently reconcile a set of client IDs after an ambiguous network failure
- `GET /export`: streamed, documented export containing metadata plus original attachments
- `GET /health/live` and `GET /health/ready`

The shared package defines Zod schemas for request/response envelopes, capture types, batch submission, item results, cursors, and error codes. Generated or inferred TypeScript types are the client contract; database row types are never exposed directly.

## 5. Delivery sequence

1. Scaffold the workspace, shared contracts, environment validation, logging, and automated checks.
2. Implement Drizzle schema/migrations, filesystem attachment storage, and backup/restore commands.
3. Implement local account bootstrap, login/session handling, authorization middleware, and password change.
4. Implement idempotent batch ingestion and authenticated attachment download.
5. Build the PWA quick-capture UI, Dexie outbox, retry/reconciliation, and chronological inbox.
6. Add worker jobs and the isolated Python extractor, keeping extraction optional to capture success.
7. Implement Android share target, then iOS share extension, both against the shared batch semantics.
8. Add Compose deployment for ARM64, operational documentation, data export, and recovery drills.

## 6. Verification and acceptance

- Unit-test Zod contracts, authentication policy, batch splitting, idempotency, cursor pagination, retry scheduling, path sanitization, and attachment state transitions.
- Integration-test login/logout/expiry, unauthorized access, duplicate submissions, multipart limits, interrupted uploads, atomic file persistence, worker leases, and migration from an empty database.
- Browser-test offline capture, reload before sync, reconnect, ambiguous timeout reconciliation, manual retry/discard, mixed-share grouping, and inbox rendering.
- Device-test Android and iOS shares from a browser, gallery, file manager, and at least one app that sends text plus multiple mixed attachments.
- Verify that one mixed share produces separate items linked by one batch, with no duplicates after repeated retries.
- Verify backup and restore into a fresh deployment and compare attachment checksums.
- Verify the container images and Compose stack on the target ARM64 server.

## 7. Explicit boundaries and defaults

- v1 is single-user and LAN-only, but authentication remains mandatory.
- SQLite is the only supported v1 database; later Postgres migration is an architectural consideration, not current scope.
- The server filesystem is the attachment store; S3-compatible storage is deferred.
- Search may initially cover titles/text, filenames, URLs, and extracted text. OCR, semantic search, reminders, collaboration, labels, drawing, and rich-note parity are deferred.
- No dependency on Google Keep or Google APIs is required. Import from Google Takeout can be added after capture reliability is proven.
- Original data is never replaced by derived previews or extracted text.

