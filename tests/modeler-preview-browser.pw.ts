import { expect, test } from "@playwright/test";

const baseUrl = process.env.MODELER_TEST_URL ?? "http://localhost:3000";
const channel = (process.env.MODELER_BROWSER_CHANNEL ?? "chrome") as "chrome" | "msedge";

test.use({ viewport: { width: 1500, height: 900 }, channel });

test("preview framing follows portrait and square output presets", async ({ page }) => {
  await page.goto(baseUrl + "/modeler", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Ready to sculpt, pose, and render.")).toBeVisible({ timeout: 20_000 });
  for (const [resolution, ratio] of [
    ["1080x1920", 9 / 16],
    ["1080x1080", 1],
    ["1920x1080", 16 / 9],
  ] as const) {
    await page.getByLabel("Canvas resolution").selectOption(resolution);
    const canvas = page.locator(".modeler-canvas");
    await expect.poll(async () => canvas.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return box.width / box.height;
    })).toBeCloseTo(ratio, 2);
    await expect.poll(async () => canvas.evaluate((node) => {
      const value = node as HTMLCanvasElement;
      return value.width / value.height;
    })).toBeCloseTo(ratio, 2);
  }
});
