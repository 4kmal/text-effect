const assert = require("node:assert/strict");
const { openCameraBrowser } = require("./camera-browser-helpers.cjs");

const browserName = process.argv[2] || "chrome";

async function main() {
  const { browser, page } = await openCameraBrowser(browserName, {
    failEffectedWrite: true,
  });
  try {
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "720p", exact: true }).click();
    await page
      .getByRole("button", { name: /start camera/i })
      .first()
      .click();
    await page
      .locator(".camera-state-dot.is-ready")
      .waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: /choose folder/i }).click();
    await page.waitForFunction(
      () => !document.querySelector("button.camera-record-button")?.disabled,
    );
    await page.getByRole("button", { name: /^record$/i }).click();
    await page.locator(".camera-state-dot.is-recording").waitFor();
    await page
      .locator(".camera-state-dot.is-ready")
      .waitFor({ timeout: 30000 });
    const alert = (await page.locator(".camera-alert-bar").textContent()) || "";
    assert.match(alert, /simulated effected file write failure/i);
    const latestTake = page.getByRole("region", { name: "Latest camera take" });
    await latestTake.waitFor();
    await latestTake.getByText(/partial/i).waitFor();
    await latestTake.getByText(/no playable data/i).waitFor();
    const files = await page.evaluate(async () => {
      const directory = await navigator.storage.getDirectory();
      const output = [];
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === "file") {
          output.push({ name, size: (await handle.getFile()).size });
        }
      }
      return output;
    });
    assert.equal(files.length, 2);
    assert.ok(
      files.some((file) => file.name.includes("clean") && file.size > 0),
    );
    console.log(JSON.stringify({ browserName, alert, files }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
