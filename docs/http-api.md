# Catchbox HTTP capture API

Catchbox exposes its online JSON API under `/api/v1`. Every capture and inbox request requires an
authenticated session and a live connection, even on a trusted local network. The current script
workflow uses the same opaque cookie session as the PWA; token credential lifecycle is outside this
API slice. Before using this API, the PWA stores the complete identified text batch in its IndexedDB
outbox. It then submits pending work on reconnect or foreground startup while the browser session is
authenticated. Repeated submissions retain their original client IDs and rely on this endpoint's
idempotency guarantees. Offline shell access is tied to one explicit local account marker. Login
and authenticated account checks update it; successful in-app logout and observed unauthenticated
responses clear it while retaining that account's outbox. Remote session invalidation cannot be
observed by a client that remains continuously offline, so the marker is cleared when that client
next receives an unauthenticated server response.

The PWA outbox stores attempt count, eligibility time, last attempt, error code, and actionable
detail alongside the complete request. Retryable failures use bounded exponential backoff. Invalid
requests become failed entries with explicit Retry and Discard actions; discard removes only the
local failed entry and never calls a server delete route.

The examples assume `CATCHBOX_URL` contains the Catchbox origin, such as
`http://catchbox.home:3000`. Keep the cookie jar private and remove it when the script finishes.

## Authenticate

Create a session and store its `HttpOnly` cookie in a temporary cookie jar:

```sh
curl --fail-with-body \
  --cookie-jar ./catchbox-cookies.txt \
  --header 'content-type: application/json' \
  --data '{"username":"operator","password":"your private password"}' \
  "$CATCHBOX_URL/api/v1/auth/login"
```

Successful login returns the public account identity. Capture requests send the stored cookie with
`--cookie ./catchbox-cookies.txt`.

## Submit one text batch

Clients generate and retain one UUID for the batch and one UUID for the item before submission.
`capturedAt` is an RFC 3339 timestamp with an offset. This online slice accepts exactly one non-empty
one or more non-empty text items per JSON batch; URLs, attachments, multipart requests, and offline
retry are not part of the endpoint itself.

```sh
curl --fail-with-body \
  --cookie ./catchbox-cookies.txt \
  --header 'content-type: application/json' \
  --data @- \
  "$CATCHBOX_URL/api/v1/capture-batches" <<'JSON'
{
  "clientBatchId": "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
  "capturedAt": "2026-07-18T08:15:30.000Z",
  "source": {
    "platform": "script",
    "app": "daily-notes"
  },
  "items": [
    {
      "clientItemId": "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
      "type": "text",
      "text": "Remember the adapter"
    }
  ]
}
JSON
```

A new capture returns `201 Created` after the batch and item have been committed together:

```json
{
  "batch": {
    "id": "33128080-cf27-4517-a3fa-c8ce1895a8c8",
    "clientBatchId": "79d34d4b-662f-4d7b-95bc-a2cb509872a8",
    "result": "created",
    "capturedAt": "2026-07-18T08:15:30.000Z",
    "receivedAt": "2026-07-18T08:15:31.000Z"
  },
  "items": [
    {
      "id": "25b9d4c4-801a-4707-9072-d5920be3c44e",
      "clientItemId": "f427a1f5-c2e3-4cd9-b9b0-64585fac9206",
      "result": "created",
      "type": "text",
      "state": "ready"
    }
  ]
}
```

Persistence is synchronous and does not wait for previews, metadata, extraction, indexing, or any
other derived work.

## Idempotency

Idempotency is scoped to the authenticated user:

- Resubmitting an existing `clientBatchId` returns that batch and its original item.
- Submitting a new batch ID with an existing `clientItemId` returns the item's original batch and
  item.
- Duplicate responses use `200 OK` and set both `result` fields to `existing`.
- Conflicting text or other changed fields on a retry do not overwrite the original capture and do
  not create an empty batch or another item.

Keep both client UUIDs until a response is known. A script may safely retry the same request after
an ambiguous connection failure.

## Reconcile an ambiguous submission

Before resubmitting an attempted batch, clients ask which stable identities the authenticated
account already owns:

```sh
curl --fail-with-body \
  --cookie ./catchbox-cookies.txt \
  --header 'content-type: application/json' \
  --data '{
    "clientBatchIds":["79d34d4b-662f-4d7b-95bc-a2cb509872a8"],
    "clientItemIds":["f427a1f5-c2e3-4cd9-b9b0-64585fac9206"]
  }' \
  "$CATCHBOX_URL/api/v1/outbox/status"
```

The response contains only identities already known for the authenticated account. Unknown IDs are
omitted. Each known batch includes its server ID, capture and receipt timestamps, and known item
outcomes. The client can therefore mark a committed capture synced after a lost response without
submitting it again. Both arrays accept at most 100 UUIDs, and at least one identity is required.

When only selected failed members of a retained batch are eligible, the PWA posts the complete
stable batch envelope plus those `clientItemIds` to `/api/v1/outbox/retry-items`. The authenticated
server creates or reuses the stable batch and persists only the selected items. Later retries can
append other stable members without changing the original batch or item identifiers; repeating the
same selected item is idempotent.

## List the inbox

The inbox is ordered deterministically by server receipt time, newest first, with server item ID as
the tie-breaker:

```sh
curl --fail-with-body \
  --cookie ./catchbox-cookies.txt \
  "$CATCHBOX_URL/api/v1/captures?limit=50"
```

The response contains `captures` and an opaque `nextCursor`. The cursor is `null` on the final page.
To continue, pass the returned value unchanged:

```sh
curl --fail-with-body \
  --cookie ./catchbox-cookies.txt \
  "$CATCHBOX_URL/api/v1/captures?limit=50&cursor=RETURNED_CURSOR"
```

`limit` must be an integer from 1 through 100. Clients must not parse or construct cursors.

## Errors

Errors use one JSON envelope:

```json
{
  "code": "INVALID_REQUEST",
  "message": "Capture batch request is invalid"
}
```

- `400 INVALID_REQUEST`: the JSON body, UUID, timestamp, text, page limit, or cursor is invalid.
- `401 AUTHENTICATION_REQUIRED`: the session cookie is missing, invalid, or expired.
- `404 NOT_FOUND`: the versioned route does not exist.
- `500 INTERNAL_ERROR`: Catchbox could not complete the request; retry with the same client IDs
  only after the service is healthy.

Error responses never include capture data. Invalid and unauthorized submissions create nothing.
