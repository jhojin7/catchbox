import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";

const ORIGINAL_PASSWORD = "a-strong-test-passphrase";

async function signIn(page: Page, password = ORIGINAL_PASSWORD) {
  await page.goto("/");
  await page.getByLabel("Username").fill("operator");
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Capture inbox", exact: true })).toBeVisible();
  await expect(page.locator(".inbox")).toHaveAttribute("aria-busy", "false");
  await page.evaluate(() => navigator.serviceWorker.ready);
}

async function localSyncStatus(page: Page, clientItemId: string) {
  return page.evaluate(
    (id) =>
      new Promise<string | undefined>((resolve, reject) => {
        const open = indexedDB.open("catchbox-local-v1");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction("items").objectStore("items").get(id);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            resolve((request.result as { syncStatus?: string } | undefined)?.syncStatus);
            open.result.close();
          };
        };
      }),
    clientItemId,
  );
}

async function localAuthorizedAccountId(page: Page) {
  return page.evaluate(
    () =>
      new Promise<string | undefined>((resolve, reject) => {
        const open = indexedDB.open("catchbox-local-v1");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result
            .transaction("offlineAuthorizations")
            .objectStore("offlineAuthorizations")
            .get("active");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            resolve((request.result as { accountId?: string } | undefined)?.accountId);
            open.result.close();
          };
        };
      }),
  );
}

async function localCaptureIdByText(page: Page, text: string) {
  return page.evaluate(
    (expectedText) =>
      new Promise<string | undefined>((resolve, reject) => {
        const open = indexedDB.open("catchbox-local-v1");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction("items").objectStore("items").getAll();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const item = (request.result as Array<{ clientItemId: string; text: string }>).find(
              (candidate) => candidate.text === expectedText,
            );
            resolve(item?.clientItemId);
            open.result.close();
          };
        };
      }),
    text,
  );
}

test("offline capture survives shell reload, syncs on reconnect, and repeated drains stay idempotent", async ({
  page,
  context,
}) => {
  await signIn(page);

  await context.setOffline(true);
  await page.getByLabel("Capture text").fill("Held safely while offline");
  await page.getByRole("button", { name: "Save capture" }).click();

  await expect(page.getByRole("status")).toHaveText("Capture saved locally");
  const item = page.locator(".capture-item", { hasText: "Held safely while offline" });
  await expect(item.getByText("Pending")).toBeVisible();
  const clientItemId = await item.getAttribute("data-client-item-id");
  expect(clientItemId).toMatch(/^[0-9a-f-]{36}$/);

  await page.getByLabel("Capture text").fill("Held later while offline");
  await page.getByRole("button", { name: "Save capture" }).click();
  await expect(
    page.locator(".capture-item", { hasText: "Held later while offline" }).getByText("Pending"),
  ).toBeVisible();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Capture inbox", exact: true })).toBeVisible();
  await expect(
    page.locator(".capture-item", { hasText: "Held safely while offline" }).getByText("Pending"),
  ).toBeVisible();

  await page.close();
  const restartedPage = await context.newPage();
  await restartedPage.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    restartedPage.getByRole("heading", { name: "Capture inbox", exact: true }),
  ).toBeVisible();
  const restartedItem = restartedPage.locator(".capture-item", {
    hasText: "Held safely while offline",
  });
  await expect(restartedItem.getByText("Pending")).toBeVisible();
  await expect(restartedItem).toHaveAttribute("data-client-item-id", clientItemId!);

  await context.setOffline(false);
  await expect(restartedItem.getByText("Synced")).toBeVisible();
  await expect(restartedItem).toHaveAttribute("data-client-item-id", clientItemId!);
  await expect(
    restartedPage.locator(".capture-item", { hasText: "Held later while offline" }).getByText("Synced"),
  ).toBeVisible();
  const offlineTexts = await restartedPage.locator(".capture-item p").allTextContents();
  expect(offlineTexts.indexOf("Held later while offline")).toBeLessThan(
    offlineTexts.indexOf("Held safely while offline"),
  );
  const serverMatches = await restartedPage.evaluate(async () => {
    const response = await fetch("/api/v1/captures");
    const page = (await response.json()) as { captures: Array<{ text: string }> };
    return page.captures.filter((capture) => capture.text.startsWith("Held ") && capture.text.endsWith("offline")).length;
  });
  expect(serverMatches).toBe(2);

  await restartedPage.evaluate(() => {
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
  });
  await restartedPage.reload();
  await expect(
    restartedPage.locator(".capture-item", { hasText: "Held safely while offline" }),
  ).toHaveCount(1);
});

test("eligible foreground startup drains pending work after a failed submission", async ({ page }) => {
  await signIn(page);
  await page.route("**/api/v1/capture-batches", (route) => route.abort("internetdisconnected"));

  await page.getByLabel("Capture text").fill("Recover when foregrounded");
  await page.getByRole("button", { name: "Save capture" }).click();
  const pendingItem = page.locator(".capture-item", { hasText: "Recover when foregrounded" });
  await expect(pendingItem.getByText("Pending", { exact: true })).toBeVisible();
  const clientItemId = await pendingItem.getAttribute("data-client-item-id");

  await page.unroute("**/api/v1/capture-batches");
  await page.reload();

  const syncedItem = page.locator(".capture-item", { hasText: "Recover when foregrounded" });
  await expect(syncedItem.getByText("Synced")).toBeVisible();
  await expect(syncedItem).toHaveAttribute("data-client-item-id", clientItemId!);
});

test("pending work survives a browser process restart while the shell is offline", async ({}, testInfo) => {
  const profileDirectory = mkdtempSync(join(tmpdir(), "catchbox-browser-profile-"));
  const baseURL = testInfo.project.use.baseURL as string;
  let persistentContext: BrowserContext | undefined;

  try {
    persistentContext = await chromium.launchPersistentContext(profileDirectory, { baseURL });
    const firstPage = persistentContext.pages()[0] ?? (await persistentContext.newPage());
    await signIn(firstPage);
    await persistentContext.setOffline(true);
    await firstPage.getByLabel("Capture text").fill("Persist through browser restart");
    await firstPage.getByRole("button", { name: "Save capture" }).click();
    const firstItem = firstPage.locator(".capture-item", {
      hasText: "Persist through browser restart",
    });
    await expect(firstItem.getByText("Pending")).toBeVisible();
    const clientItemId = await firstItem.getAttribute("data-client-item-id");

    await persistentContext.close();
    persistentContext = await chromium.launchPersistentContext(profileDirectory, { baseURL });
    await persistentContext.setOffline(true);
    const restartedPage = persistentContext.pages()[0] ?? (await persistentContext.newPage());
    await restartedPage.goto("/", { waitUntil: "domcontentloaded" });
    const restartedItem = restartedPage.locator(".capture-item", {
      hasText: "Persist through browser restart",
    });
    await expect(restartedItem.getByText("Pending")).toBeVisible();
    await expect(restartedItem).toHaveAttribute("data-client-item-id", clientItemId!);

    await persistentContext.setOffline(false);
    await expect(restartedItem.getByText("Synced")).toBeVisible();
  } finally {
    await persistentContext?.close();
    rmSync(profileDirectory, { recursive: true, force: true });
  }
});

test("a local transaction failure reports capture failure without submitting", async ({ page }) => {
  await signIn(page);
  let submissions = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/v1/capture-batches")) {
      submissions += 1;
    }
  });
  await page.evaluate(() => {
    const originalAdd = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value, key) {
      if (this.name === "items") {
        throw new DOMException("Test storage failure", "QuotaExceededError");
      }
      return originalAdd.call(this, value, key);
    };
  });

  await page.getByLabel("Capture text").fill("This local write must fail");
  await page.getByRole("button", { name: "Save capture" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "The capture could not be saved on this device.",
  );
  await expect(
    page.locator(".capture-item", { hasText: "This local write must fail" }),
  ).toHaveCount(0);
  expect(submissions).toBe(0);
});

test("repeated delivery of one pending batch creates one server batch and item", async ({ page }) => {
  await signIn(page);
  const deliveryStatuses: number[] = [];
  await page.route("**/api/v1/capture-batches", async (route) => {
    const request = route.request().postDataJSON() as { items: [{ text: string }] };
    if (request.items[0].text !== "Deliver this identity repeatedly") {
      return route.continue();
    }
    const first = await route.fetch();
    const duplicate = await route.fetch();
    deliveryStatuses.push(first.status(), duplicate.status());
    await route.fulfill({ response: first });
  });

  await page.getByLabel("Capture text").fill("Deliver this identity repeatedly");
  await page.getByRole("button", { name: "Save capture" }).click();
  await expect(
    page.locator(".capture-item", { hasText: "Deliver this identity repeatedly" }).getByText("Synced"),
  ).toBeVisible();

  expect(deliveryStatuses).toContain(201);
  expect(deliveryStatuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
  const matches = await page.evaluate(async () => {
    const response = await fetch("/api/v1/captures");
    const page = (await response.json()) as { captures: Array<{ text: string }> };
    return page.captures.filter((capture) => capture.text === "Deliver this identity repeatedly").length;
  });
  expect(matches).toBe(1);
});

test("durable state is observable before submission and the final inbox is chronological", async ({
  page,
}) => {
  await signIn(page);
  let persistedBeforeRequest = false;
  await page.route("**/api/v1/capture-batches", async (route) => {
    const request = route.request().postDataJSON() as {
      clientBatchId: string;
      items: [{ clientItemId: string }];
    };
    persistedBeforeRequest = await page.evaluate(
      ({ clientBatchId, clientItemId }) =>
        new Promise<boolean>((resolve, reject) => {
          const open = indexedDB.open("catchbox-local-v1");
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const transaction = open.result.transaction(["batches", "items"]);
            const batch = transaction.objectStore("batches").get(clientBatchId);
            const item = transaction.objectStore("items").get(clientItemId);
            transaction.oncomplete = () => {
              resolve(batch.result?.syncStatus === "pending" && item.result?.syncStatus === "pending");
              open.result.close();
            };
            transaction.onerror = () => reject(transaction.error);
          };
        }),
      { clientBatchId: request.clientBatchId, clientItemId: request.items[0].clientItemId },
    );
    await route.continue();
  });

  const text = page.getByLabel("Capture text");
  await text.fill("Earlier chronological capture");
  await page.getByRole("button", { name: "Save capture" }).click();
  await expect(
    page.locator(".capture-item", { hasText: "Earlier chronological capture" }).getByText("Synced"),
  ).toBeVisible();
  expect(persistedBeforeRequest).toBe(true);

  await text.fill("Later chronological capture");
  await page.getByRole("button", { name: "Save capture" }).click();
  await expect(
    page.locator(".capture-item", { hasText: "Later chronological capture" }).getByText("Synced"),
  ).toBeVisible();
  const texts = await page.locator(".capture-item p").allTextContents();
  expect(texts.indexOf("Later chronological capture")).toBeLessThan(
    texts.indexOf("Earlier chronological capture"),
  );
});

test("in-app logout revokes the offline shell while preserving pending work for same-account reauthentication", async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.route("**/api/v1/capture-batches", (route) => route.abort("internetdisconnected"));
  await page.getByLabel("Capture text").fill("Remain pending through logout");
  await page.getByRole("button", { name: "Save capture" }).click();
  const pendingItem = page.locator(".capture-item", { hasText: "Remain pending through logout" });
  await expect(pendingItem.getByText("Pending", { exact: true })).toBeVisible();
  const clientItemId = await pendingItem.getAttribute("data-client-item-id");

  expect(await localAuthorizedAccountId(page)).toBeTruthy();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Catchbox" })).toBeVisible();
  expect(await localSyncStatus(page, clientItemId!)).toBe("pending");
  expect(await localAuthorizedAccountId(page)).toBeUndefined();

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Sign in to Catchbox" })).toBeVisible();
  await expect(page.getByText("Remain pending through logout")).toHaveCount(0);

  await context.setOffline(false);
  await page.unroute("**/api/v1/capture-batches");
  await signIn(page);
  const syncedItem = page.locator(".capture-item", { hasText: "Remain pending through logout" });
  await expect(syncedItem.getByText("Synced")).toBeVisible();
  await expect(syncedItem).toHaveAttribute("data-client-item-id", clientItemId!);
});

test("observed password invalidation revokes later offline access without deleting pending work", async ({
  page,
  context,
}) => {
  const changedPassword = "a-different-strong-passphrase";
  await signIn(page);
  await page.route("**/api/v1/capture-batches", (route) => route.abort("internetdisconnected"));
  await page.getByLabel("Capture text").fill("Remain pending through password change");
  await page.getByRole("button", { name: "Save capture" }).click();
  const pendingItem = page.locator(".capture-item", {
    hasText: "Remain pending through password change",
  });
  await expect(pendingItem.getByText("Pending", { exact: true })).toBeVisible();
  const clientItemId = await pendingItem.getAttribute("data-client-item-id");

  const changeStatus = await page.evaluate(
    async ({ currentPassword, newPassword }) =>
      (
        await fetch("/api/v1/auth/change-password", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ currentPassword, newPassword }),
        })
      ).status,
    { currentPassword: ORIGINAL_PASSWORD, newPassword: changedPassword },
  );
  expect(changeStatus).toBe(204);
  expect(await localSyncStatus(page, clientItemId!)).toBe("pending");

  // This online /auth/me response is the first point where the browser can observe revocation.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in to Catchbox" })).toBeVisible();
  expect(await localAuthorizedAccountId(page)).toBeUndefined();

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Sign in to Catchbox" })).toBeVisible();
  await expect(page.getByText("Remain pending through password change")).toHaveCount(0);

  await context.setOffline(false);
  await page.unroute("**/api/v1/capture-batches");
  await signIn(page, changedPassword);
  const syncedItem = page.locator(".capture-item", {
    hasText: "Remain pending through password change",
  });
  await expect(syncedItem.getByText("Synced")).toBeVisible();
  await expect(syncedItem).toHaveAttribute("data-client-item-id", clientItemId!);

  const restoreStatus = await page.evaluate(
    async ({ currentPassword, newPassword }) =>
      (
        await fetch("/api/v1/auth/change-password", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ currentPassword, newPassword }),
        })
      ).status,
    { currentPassword: changedPassword, newPassword: ORIGINAL_PASSWORD },
  );
  expect(restoreStatus).toBe(204);
});

test("an observed batch 401 revokes offline access even when the inbox is unreachable", async ({
  page,
  context,
}) => {
  await signIn(page);
  await page.route("**/api/v1/capture-batches", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({
        code: "AUTHENTICATION_REQUIRED",
        message: "Sign in to continue",
      }),
    }),
  );
  await page.route("**/api/v1/captures", (route) => route.abort("internetdisconnected"));

  await page.getByLabel("Capture text").fill("Retain after an observed batch rejection");
  await page.getByRole("button", { name: "Save capture" }).click();
  await expect(page.getByRole("heading", { name: "Sign in to Catchbox" })).toBeVisible();

  const clientItemId = await localCaptureIdByText(
    page,
    "Retain after an observed batch rejection",
  );
  expect(clientItemId).toBeTruthy();
  expect(await localSyncStatus(page, clientItemId!)).toBe("pending");
  expect(await localAuthorizedAccountId(page)).toBeUndefined();

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Sign in to Catchbox" })).toBeVisible();
  await expect(page.getByText("Retain after an observed batch rejection")).toHaveCount(0);
});

test("the offline authorization marker isolates cached captures deterministically by owner", async ({
  page,
  context,
}) => {
  await signIn(page);
  const authorizedAccountId = await localAuthorizedAccountId(page);
  expect(authorizedAccountId).toBeTruthy();
  const otherAccountId = "00000000-0000-4000-8000-000000000002";
  const otherBatchId = "00000000-0000-4000-8000-000000000003";
  const otherItemId = "00000000-0000-4000-8000-000000000004";
  const capturedAt = "2026-07-18T08:15:30.000Z";

  await page.evaluate(
    ({ otherAccountId, otherBatchId, otherItemId, capturedAt }) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("catchbox-local-v1");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const transaction = open.result.transaction(
            ["accounts", "batches", "items"],
            "readwrite",
          );
          transaction.objectStore("accounts").put({
            id: otherAccountId,
            username: "another-owner",
          });
          transaction.objectStore("batches").put({
            clientBatchId: otherBatchId,
            accountId: otherAccountId,
            capturedAt,
            syncStatus: "pending",
            request: {
              clientBatchId: otherBatchId,
              capturedAt,
              source: { platform: "web", app: "catchbox-pwa" },
              items: [
                {
                  clientItemId: otherItemId,
                  type: "text",
                  text: "Another owner's private pending capture",
                },
              ],
            },
          });
          transaction.objectStore("items").put({
            clientItemId: otherItemId,
            clientBatchId: otherBatchId,
            accountId: otherAccountId,
            type: "text",
            text: "Another owner's private pending capture",
            capturedAt,
            syncStatus: "pending",
          });
          transaction.oncomplete = () => {
            open.result.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    { otherAccountId, otherBatchId, otherItemId, capturedAt },
  );

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Signed in as operator")).toBeVisible();
  await expect(page.getByText("Another owner's private pending capture")).toHaveCount(0);
  expect(await localAuthorizedAccountId(page)).toBe(authorizedAccountId);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect.poll(() => localSyncStatus(page, otherItemId)).toBe("pending");
});
