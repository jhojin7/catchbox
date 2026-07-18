/// <reference lib="webworker" />

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
