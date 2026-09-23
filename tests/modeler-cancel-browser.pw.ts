import { expect, test } from "@playwright/test";

const baseUrl = process.env.MODELER_TEST_URL ?? "http://localhost:3000";
const channel = (process.env.MODELER_BROWSER_CHANNEL ?? "chrome") as "chrome" | "msedge";

test.use({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, channel });

test("canceling a render keeps the editable scene available", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(baseUrl + "/modeler", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Ready to sculpt, pose, and render.")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "EMPTY SCENE build from shapes" }).click();
  await page.getByRole("button", { name: "sphere", exact: false }).click();
  await page.getByLabel("Format").selectOption("webm");
  await page.getByRole("button", { name: "Render clip" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".modeler-status.is-error")).toContainText(/cancel/i, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await expect(page.locator(".modeler-list-button").filter({ hasText: "Sphere" })).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Still PNG" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
});
