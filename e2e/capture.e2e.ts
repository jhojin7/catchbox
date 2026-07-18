import { expect, test } from "@playwright/test";

test("a signed-in operator captures text and reviews reverse-chronological inbox", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Username").fill("operator");
  await page.getByLabel("Password").fill("a-strong-test-passphrase");
  await page.getByRole("button", { name: "Sign in" }).click();

  const text = page.getByLabel("Capture text");
  const save = page.getByRole("button", { name: "Save capture" });
  await expect(page.getByRole("heading", { name: "Quick capture" })).toBeVisible();
  await expect(
    page.getByText("Requires a live connection. Offline saving and retry are not available yet."),
  ).toBeVisible();
  await expect(save).toBeDisabled();
  await text.fill("   ");
  await expect(save).toBeDisabled();

  await text.fill("First browser capture");
  await save.click();
  await expect(page.getByRole("status")).toHaveText("Capture saved");
  await expect(page.getByText("First browser capture")).toBeVisible();
  await expect(text).toHaveValue("");

  await text.fill("Second browser capture");
  await save.click();
  await expect(page.getByRole("status")).toHaveText("Capture saved");
  await expect(page.locator(".capture-item")).toHaveText([
    /Second browser capture/,
    /First browser capture/,
  ]);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Capture inbox", exact: true })).toBeVisible();
  await expect(page.locator(".capture-item")).toHaveText([
    /Second browser capture/,
    /First browser capture/,
  ]);
});

test("a successful submission is shown without depending on a follow-up inbox request", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Username").fill("operator");
  await page.getByLabel("Password").fill("a-strong-test-passphrase");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".inbox")).toHaveAttribute("aria-busy", "false");

  await page.route("**/api/v1/captures", (route) => route.abort());
  await page.getByLabel("Capture text").fill("Visible from the submission response");
  await page.getByRole("button", { name: "Save capture" }).click();

  await expect(page.getByRole("status")).toHaveText("Capture saved");
  await expect(page.getByText("Visible from the submission response")).toBeVisible();
  await expect(page.getByRole("alert")).not.toBeVisible();
});
