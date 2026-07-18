/// <reference lib="webworker" />

import { fetchCurrentAccount } from "./auth-api";
import { CaptureApiError } from "./capture-api";
import {
  clearOfflineAuthorizationIfCurrent,
  drainPendingCaptures,
  loadOfflineAuthorizationSnapshot,
  loadOfflineAuthorizedAccount,
  OUTBOX_SYNC_TAG,
} from "./local-captures";

const serviceWorker = self as unknown as ServiceWorkerGlobalScope;
const CACHE_NAME = "catchbox-shell-v1";
const STATIC_SHELL = [
  "/manifest.webmanifest",
  "/icons/catchbox-192.png",
  "/icons/catchbox-512.png",
];

async function cacheBuiltShell() {
  const cache = await caches.open(CACHE_NAME);
  const shellResponse = await fetch("/", { cache: "reload" });
  if (!shellResponse.ok) throw new Error("Catchbox shell was unavailable during installation");
  const html = await shellResponse.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(
    (match) => match[1],
  );
  await cache.put("/", shellResponse);
  await cache.addAll([...STATIC_SHELL, ...assets]);
}

serviceWorker.addEventListener("install", (event) => {
  event.waitUntil(cacheBuiltShell());
});

serviceWorker.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  );
});

serviceWorker.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).pathname.startsWith("/api/")) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === "navigate") return (await caches.match("/")) ?? Response.error();
      return Response.error();
    }),
  );
});

serviceWorker.addEventListener("sync", ((event: ExtendableEvent & { tag: string }) => {
  if (event.tag === OUTBOX_SYNC_TAG) {
    event.waitUntil(
      loadOfflineAuthorizationSnapshot().then(async (authorization) => {
        if (!authorization) return;
        const account = await fetchCurrentAccount();
        if (!account) {
          await clearOfflineAuthorizationIfCurrent(authorization.generation);
          return;
        }
        // A delayed background response must never resurrect access after foreground logout.
        const offlineAccount = await loadOfflineAuthorizedAccount();
        const currentAuthorization = await loadOfflineAuthorizationSnapshot();
        if (
          offlineAccount?.id !== account.id ||
          currentAuthorization?.generation !== authorization.generation
        ) {
          return;
        }
        try {
          await drainPendingCaptures({ accountId: account.id });
        } catch (error) {
          if (error instanceof CaptureApiError && error.code === "AUTHENTICATION_REQUIRED") {
            await clearOfflineAuthorizationIfCurrent(authorization.generation);
            return;
          }
          throw error;
        }
      }),
    );
  }
}) as EventListener);
