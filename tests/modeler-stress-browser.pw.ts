import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const baseUrl = process.env.MODELER_TEST_URL ?? "http://localhost:3000";
const channel = (process.env.MODELER_BROWSER_CHANNEL ?? "chrome") as "chrome" | "msedge";

test.use({ viewport: { width: 1500, height: 900 }, acceptDownloads: true, channel });
test.skip(process.env.MODELER_STRESS !== "1", "Set MODELER_STRESS=1 for the 1800-frame render.");

test("renders the 1080p, 60 fps, 30-second Vitruvian spin", async ({ page }, testInfo) => {
  test.setTimeout(1_800_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl + "/modeler", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Ready to sculpt, pose, and render.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "VITRUVIAN pose + 360 spin" }).click();
  await page.getByLabel("Canvas resolution").selectOption("1920x1080");
  await page.getByLabel("Duration").fill("30");
  await page.getByLabel("Format").selectOption("webm");
  const stillDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Still PNG" }).click();
  const stillPath = testInfo.outputPath("vitruvian-preview.png");
  await (await stillDownload).saveAs(stillPath);
  const download = page.waitForEvent("download", { timeout: 1_700_000 });
  await page.getByRole("button", { name: "Render clip" }).click();
  const saved = await Promise.race([
    download,
    page.locator(".modeler-status.is-error").waitFor({ timeout: 1_700_000 }).then(async () => {
      throw new Error(await page.locator(".modeler-status.is-error").innerText());
    }),
  ]);
  const path = testInfo.outputPath("vitruvian-spin-1080p.webm");
  await saved.saveAs(path);
  const info = JSON.parse(execFileSync("ffprobe", [
    "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path,
  ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 })) as {
    streams: Array<{ codec_name?: string; width?: number; height?: number; r_frame_rate?: string; nb_read_frames?: string; tags?: { alpha_mode?: string } }>;
    format: { duration?: string };
  };
  const video = info.streams.find((stream) => stream.width);
  expect(video?.codec_name).toBe("vp9");
  expect(video?.width).toBe(1920);
  expect(video?.height).toBe(1080);
  expect(video?.r_frame_rate).toBe("60/1");
  expect(video?.nb_read_frames).toBe("1800");
  expect(video?.tags?.alpha_mode).toBe("1");
  expect(Number(info.format.duration)).toBeCloseTo(30, 1);
  const frameArgs = ["-v", "error", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"];
  const still = execFileSync("ffmpeg", ["-v", "error", "-i", stillPath, ...frameArgs.slice(2)], { maxBuffer: 12 * 1024 * 1024 });
  const firstFrame = execFileSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", path, ...frameArgs.slice(2)], { maxBuffer: 12 * 1024 * 1024 });
  expect(firstFrame.length).toBe(still.length);
  let alphaDifference = 0;
  let colorDifference = 0;
  let visibleSamples = 0;
  let samples = 0;
  for (let offset = 0; offset < still.length; offset += 128) {
    alphaDifference += Math.abs(still[offset + 3]! - firstFrame[offset + 3]!);
    samples += 1;
    if (still[offset + 3]! > 128) {
      colorDifference += Math.abs(still[offset]! - firstFrame[offset]!)
        + Math.abs(still[offset + 1]! - firstFrame[offset + 1]!)
        + Math.abs(still[offset + 2]! - firstFrame[offset + 2]!);
      visibleSamples += 1;
    }
  }
  expect(alphaDifference / samples).toBeLessThan(6);
  expect(colorDifference / (visibleSamples * 3)).toBeLessThan(35);
  expect(errors).toEqual([]);
});
