import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";

const baseUrl = process.env.MODELER_TEST_URL ?? "http://localhost:3000";
const channel = (process.env.MODELER_BROWSER_CHANNEL ?? "chrome") as "chrome" | "msedge";
test.use({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, channel });

for (const [format, extension, codec] of [
  ["webm", "webm", "vp9"],
  ["mp4", "mp4", "h264"],
] as const) {
  test("renders a " + format.toUpperCase() + " clip from the same scene", async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    await page.goto(baseUrl + "/modeler", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Ready to sculpt, pose, and render.")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "EMPTY SCENE build from shapes" }).click();
    await page.getByRole("button", { name: "sphere", exact: false }).click();
    await page.getByLabel("Canvas resolution").selectOption("1280x720");
    await page.getByLabel("Duration").fill("1");
    await page.getByLabel("Format").selectOption(format);
    let stillPath: string | undefined;
    if (format === "webm") {
      const stillDownload = page.waitForEvent("download");
      await page.getByRole("button", { name: "Still PNG" }).click();
      stillPath = testInfo.outputPath("modeler-sphere-preview.png");
      await (await stillDownload).saveAs(stillPath);
    }
    const download = page.waitForEvent("download", { timeout: 160_000 });
    await page.getByRole("button", { name: "Render clip" }).click();
    const saved = await Promise.race([
      download,
      page.locator(".modeler-status.is-error").waitFor({ timeout: 160_000 }).then(async () => {
        throw new Error(await page.locator(".modeler-status.is-error").innerText());
      }),
    ]);
    expect(saved.suggestedFilename()).toMatch(new RegExp("\\." + extension + "$"));
    const path = testInfo.outputPath("modeler-sphere." + extension);
    await saved.saveAs(path);
    const info = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", path,
    ], { encoding: "utf8" })) as {
      streams: Array<{ codec_name?: string; width?: number; height?: number; r_frame_rate?: string; nb_read_frames?: string; tags?: { alpha_mode?: string } }>;
      format: { duration?: string };
    };
    const video = info.streams.find((stream) => stream.width);
    expect(video?.codec_name).toBe(codec);
    expect(video?.width).toBe(1280);
    expect(video?.height).toBe(720);
    expect(video?.r_frame_rate).toBe("60/1");
    expect(video?.nb_read_frames).toBe("60");
    if (format === "webm") expect(video?.tags?.alpha_mode).toBe("1");
    expect(Number(info.format.duration)).toBeCloseTo(1, 1);
    if (stillPath) {
      const frameArgs = ["-v", "error", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"];
      const still = execFileSync("ffmpeg", ["-v", "error", "-i", stillPath, ...frameArgs.slice(2)], { maxBuffer: 8 * 1024 * 1024 });
      const firstFrame = execFileSync("ffmpeg", ["-v", "error", "-c:v", "libvpx-vp9", "-i", path, ...frameArgs.slice(2)], { maxBuffer: 8 * 1024 * 1024 });
      expect(firstFrame.length).toBe(still.length);
      let alphaDifference = 0;
      let colorDifference = 0;
      let samples = 0;
      let visibleSamples = 0;
      for (let offset = 0; offset < still.length; offset += 64) {
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
    }
  });
}
