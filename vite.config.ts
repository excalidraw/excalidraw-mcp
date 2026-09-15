import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { runtimeAssetsPlugin, runtimeImports } from "./runtime-assets";

const isDevelopment = process.env.NODE_ENV === "development";

export default defineConfig({
  plugins: [runtimeAssetsPlugin(), react(), viteSingleFile()],
  build: {
    sourcemap: isDevelopment ? "inline" : undefined,
    cssMinify: !isDevelopment,
    minify: !isDevelopment,

    rollupOptions: {
      input: path.resolve(__dirname, "src/mcp-app.html"),
      external: Object.keys(runtimeImports),
      output: {
        paths: runtimeImports,
      },
    },
    outDir: "dist",
    emptyOutDir: false,
  },
});
