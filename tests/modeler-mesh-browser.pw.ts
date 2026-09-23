import { expect, test } from "@playwright/test";

const baseUrl = process.env.MODELER_TEST_URL ?? "http://localhost:3000";
const channel = (process.env.MODELER_BROWSER_CHANNEL ?? "chrome") as "chrome" | "msedge";
test.use({ viewport: { width: 1500, height: 900 }, channel });

test("selects and edits a mesh, sculpts it, then reloads the local draft", async ({ page }) => {
  await page.goto(baseUrl + "/modeler", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Ready to sculpt, pose, and render.")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "EMPTY SCENE build from shapes" }).click();
  await page.getByRole("button", { name: "sphere", exact: false }).click();
  await page.getByRole("button", { name: "Mesh", exact: true }).click();
  const canvas = page.locator(".modeler-canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width * 0.5;
  const y = bounds!.y + bounds!.height * 0.62;
  await page.mouse.click(x, y);
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.keyboard.down("Shift");
  await page.mouse.click(x + 18, y - 8);
  await page.keyboard.up("Shift");
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Extrude" }).click();
  await expect(page.locator("div.modeler-status")).toContainText("Extrude applied.");

  await page.getByRole("button", { name: "Sculpt", exact: true }).click();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 18, y - 12, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator("div.modeler-status")).toContainText("Sculpt stroke saved.");
  await page.getByRole("button", { name: "Undo" }).click();
  await page.getByRole("button", { name: "Redo" }).click();
  await page.waitForTimeout(1200);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText("Ready to sculpt, pose, and render.")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".modeler-list-button").filter({ hasText: "Sphere" })).toBeVisible();
  await expect(page.locator(".modeler-status.is-error")).toHaveCount(0);
});
