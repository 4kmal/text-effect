import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const baseUrl = process.env.MODELER_TEST_URL ?? "http://localhost:3000";
const channel = (process.env.MODELER_BROWSER_CHANNEL ?? "chrome") as "chrome" | "msedge";
test.use({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, channel });

test("renders a transparent MOV from the scene through the local helper", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const network: string[] = [];
  page.on("requestfailed", (request) => network.push("FAILED " + request.url() + " " + request.failure()?.errorText));
  page.on("response", (response) => {
    if (response.url().includes("34871")) network.push("RESPONSE " + response.url() + " " + response.status());
  });
  page.on("console", (message) => { if (message.type() === "error") network.push("CONSOLE " + message.text()); });
  await page.goto(baseUrl + "/modeler", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Ready to sculpt, pose, and render.")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "EMPTY SCENE build from shapes" }).click();
  await page.getByRole("button", { name: "sphere", exact: false }).click();
  await page.getByLabel("Canvas resolution").selectOption("1280x720");
  await page.getByLabel("Duration").fill("1");
  await page.getByLabel("Format").selectOption("prores4444");
  const download = page.waitForEvent("download", { timeout: 160_000 });
  await page.getByRole("button", { name: "Render clip" }).click();
  const saved = await Promise.race([
    download,
    page.locator(".modeler-status.is-error").waitFor({ timeout: 160_000 }).then(async () => {
      throw new Error((await page.locator(".modeler-status.is-error").innerText()) + "\n" + network.join("\n"));
    }),
  ]);
  expect(saved.suggestedFilename()).toMatch(/\.mov$/);
  const path = testInfo.outputPath("modeler-sphere.mov");
  await saved.saveAs(path);
  const info = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-show_streams", "-show_format", "-of", "json", path,
  ], { encoding: "utf8" })) as {
    streams: Array<{ codec_name?: string; pix_fmt?: string; width?: number; height?: number; avg_frame_rate?: string }>;
    format: { duration?: string };
  };
  const video = info.streams.find((stream) => stream.width);
  expect(video?.codec_name).toBe("prores");
  expect(video?.pix_fmt).toMatch(/^yuva444p(10|12|16)le$/);
  expect(video?.width).toBe(1280);
  expect(video?.height).toBe(720);
  expect(video?.avg_frame_rate).toBe("60/1");
  expect(Number(info.format.duration)).toBeCloseTo(1, 1);
});
