import { defineConfig } from "@playwright/test";

// Serial, single-worker GUI measurements of the packaged diagnostic artifact.
export default defineConfig({
  testDir: "tests/measure",
  workers: 1,
  timeout: 240_000,
  reporter: "list",
});
