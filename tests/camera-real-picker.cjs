const assert = require("node:assert/strict");
const { openCameraBrowser } = require("./camera-browser-helpers.cjs");

async function main() {
  const { browser, page } = await openCameraBrowser("chrome", {
    mockFolderPicker: false,
    headless: false,
  });
  try {
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "720p", exact: true }).click();
    assert.match(
      (await page.locator(".camera-topbar-center").textContent()) || "",
      /1280\s*×\s*720/,
    );
    await page.getByRole("button", { name: /start camera/i }).first().click();
    await page.locator(".camera-state-dot.is-ready").waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: /choose folder/i }).click();
    console.log("PICKER_OPEN");
    await page.waitForFunction(
      () => {
        const folder = document.querySelector(".camera-folder-status")?.textContent || "";
        return folder && !folder.includes("NO FOLDER SELECTED");
      },
      undefined,
      { timeout: 300000 },
    );
    const folder = await page.locator(".camera-folder-status").textContent();
    console.log(JSON.stringify({ folder }));
    await page.getByRole("button", { name: /^record$/i }).click();
    await page.getByRole("button", { name: /stop & save/i }).waitFor();
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: /stop & save/i }).click();
    await page.locator(".camera-state-dot.is-ready").waitFor({ timeout: 30000 });
    assert.equal(await page.locator(".camera-state-dot.is-ready").count(), 1);
    console.log("PICKER_RECORDING_OK");
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
