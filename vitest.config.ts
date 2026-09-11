import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests mutate process.env.SKILLENV_HOME; serialize files to avoid races.
    fileParallelism: false,
    env: {
      SKILLENV_DISABLE_COLOR: "1",
    },
  },
});
