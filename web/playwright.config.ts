import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/report" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        launchOptions: {
          // Tauri/Wry enables media autoplay for the packaged desktop WebView.
          args: ["--autoplay-policy=no-user-gesture-required"],
        },
      },
    },
    {
      name: "firefox-compat",
      testMatch: /zz-browser-compat\.spec\.ts/,
      use: { browserName: "firefox" },
    },
    {
      name: "webkit-compat",
      testMatch: /zz-browser-compat\.spec\.ts/,
      use: { browserName: "webkit" },
    },
  ],
  outputDir: "test-results/artifacts",
});
