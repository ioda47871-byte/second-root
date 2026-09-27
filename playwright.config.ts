import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);

// E2E runs against a production build (`npm run build` first). It never
// talks to real shops: the contact API is intercepted in the specs, and
// future Sales Agent specs must use example.com / fictional accounts only.
export default defineConfig({
  testDir: "tests/e2e",
  // One worker: sales specs share one local database and today's queue
  // (max 5 items), so parallel specs could push each other's rows out.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    // Lets sandboxes with a preinstalled Chromium of another revision run
    // the suite without `playwright install`.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : undefined,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run start -- --port ${port}`,
    // Demo links in admin messages point at this local server during tests.
    env: { SALES_DEMO_BASE_URL: `http://127.0.0.1:${port}` },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
