const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium, firefox, webkit } = require("@playwright/test");

const browserCache =
  process.env.PLAYWRIGHT_BROWSERS_PATH ||
  path.join(os.homedir(), "AppData", "Local", "ms-playwright");

function optionsWithFallback(browserType, cachedVersion, executable) {
  if (fs.existsSync(browserType.executablePath())) return {};
  const cachedPath = path.join(browserCache, cachedVersion, ...executable);
  return fs.existsSync(cachedPath) ? { executablePath: cachedPath } : {};
}

const targets = {
  chrome: { browserType: chromium, options: { channel: "chrome" } },
  edge: { browserType: chromium, options: { channel: "msedge" } },
  firefox: {
    browserType: firefox,
    options: optionsWithFallback(firefox, "firefox-1538", [
      "firefox",
      "firefox.exe",
    ]),
  },
  webkit: {
    browserType: webkit,
    options: optionsWithFallback(webkit, "webkit-2336", ["Playwright.exe"]),
  },
};

module.exports = { targets };
