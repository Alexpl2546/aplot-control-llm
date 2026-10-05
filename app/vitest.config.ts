import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config.ts";

export default mergeConfig(viteConfig, defineConfig({
  test: { include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"] },
}));
