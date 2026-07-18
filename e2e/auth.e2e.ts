import { expect, test } from "@playwright/test";

test("an operator signs in before seeing the protected application shell", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Sign in to Catchbox" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Capture inbox", exact: true })).not.toBeVisible();

  await page.getByLabel("Username").fill("operator");
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Username or password is incorrect");

  await page.getByLabel("Password").fill("a-strong-test-passphrase");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Capture inbox", exact: true })).toBeVisible();
  await expect(page.getByText("Signed in as operator")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Capture inbox", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in to Catchbox" })).not.toBeVisible();
});

test("the installable shell declares icons and caches its built assets", async ({ page, context }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in to Catchbox" })).toBeVisible();

  const pwa = await page.evaluate(async () => {
    const manifest = await fetch("/manifest.webmanifest").then((response) => response.json());
    const iconSizes = await Promise.all(
      manifest.icons.map(async (icon: { src: string }) => {
        const bitmap = await createImageBitmap(await fetch(icon.src).then((response) => response.blob()));
        return `${bitmap.width}x${bitmap.height}`;
      }),
    );
    const registration = await navigator.serviceWorker.ready;
    const cache = await caches.open("catchbox-shell-v1");
    const cachedPaths = (await cache.keys()).map((request) => new URL(request.url).pathname);
    return { manifest, iconSizes, scope: registration.scope, cachedPaths };
  });

  expect(pwa.manifest).toMatchObject({
    name: "Catchbox",
    start_url: "/",
    display: "standalone",
  });
  expect(pwa.iconSizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(pwa.scope).toBe(`${new URL(page.url()).origin}/`);
  expect(pwa.cachedPaths).toEqual(
    expect.arrayContaining(["/", "/manifest.webmanifest", "/icons/catchbox-192.png", "/icons/catchbox-512.png"]),
  );
  expect(pwa.cachedPaths.some((path) => /^\/assets\/.*\.js$/.test(path))).toBe(true);
  expect(pwa.cachedPaths.some((path) => /^\/assets\/.*\.css$/.test(path))).toBe(true);

  await page.reload();
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Sign in to Catchbox" })).toBeVisible();
  await context.setOffline(false);
});
