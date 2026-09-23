const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("@playwright/test");

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
  });
  await page.route("**/unpkg.com/react-grab/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const outputDir = path.join(os.tmpdir(), "textfx-presets");
  fs.mkdirSync(outputDir, { recursive: true });
  try {
    await page.goto("http://localhost:3000/editor", {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Text treatments" }).waitFor();
    const canvas = page.locator("canvas").first();
    const cards = page.locator(".fx-preset-card");
    assert.equal(await cards.count(), 6);
    for (let index = 0; index < 6; index += 1) {
      const name = (
        await cards.nth(index).locator("strong").textContent()
      ).trim();
      await cards.nth(index).click();
      await page.waitForTimeout(100);
      const first = await canvas.evaluate((element) => element.toDataURL());
      const ruler = await page.locator(".fx-ruler").boundingBox();
      await page.mouse.click(
        ruler.x + ruler.width * 0.25,
        ruler.y + ruler.height / 2,
      );
      await page.waitForTimeout(100);
      const later = await canvas.evaluate((element) => element.toDataURL());
      assert.notEqual(later, first, `${name} did not animate`);
      const file = path.join(
        outputDir,
        `${index + 1}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.png`,
      );
      fs.writeFileSync(file, Buffer.from(later.split(",")[1], "base64"));
      console.log(`${name}: animated frame saved to ${file}`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
