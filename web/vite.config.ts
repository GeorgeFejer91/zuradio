import { resolve } from "node:path";
import { defineConfig } from "vite";

const pagesBuild = process.env.ZURADIO_PAGES_BUILD === "1";

export default defineConfig({
  base: "./",
  build: {
    outDir: pagesBuild ? "dist-pages" : "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: pagesBuild
        ? {
            index: resolve(import.meta.dirname, "index.html"),
            companion: resolve(import.meta.dirname, "companion/index.html"),
          }
        : {
            index: resolve(import.meta.dirname, "index.html"),
            host: resolve(import.meta.dirname, "host/index.html"),
            companion: resolve(import.meta.dirname, "companion/index.html"),
          },
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts"],
  },
});
