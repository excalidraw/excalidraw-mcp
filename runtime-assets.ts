import type { Plugin } from "vite";
import packageInfo from "./package.json" with { type: "json" };

const dependencies = packageInfo.dependencies;
const version = (name: keyof typeof dependencies) => {
  const value = dependencies[name];
  if (!/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Pin ${name} to an exact version before generating browser assets.`);
  }
  return value;
};
const react = version("react");
const reactDom = version("react-dom");
const excalidraw = version("@excalidraw/excalidraw");
const reactDeps = `deps=react@${react},react-dom@${reactDom}`;

export const excalidrawAssetPath = `https://esm.sh/@excalidraw/excalidraw@${excalidraw}/dist/prod/`;
export const runtimeImports = {
  react: `https://esm.sh/react@${react}`,
  "react-dom": `https://esm.sh/react-dom@${reactDom}?deps=react@${react}`,
  "react-dom/client": `https://esm.sh/react-dom@${reactDom}/client?deps=react@${react}`,
  "react/jsx-runtime": `https://esm.sh/react@${react}/jsx-runtime`,
  "@excalidraw/excalidraw": `https://esm.sh/@excalidraw/excalidraw@${excalidraw}?${reactDeps}`,
  morphdom: `https://esm.sh/morphdom@${version("morphdom")}`,
};

export function rewriteRuntimeAssetUrls(code: string): string {
  return code.replace(/https:\/\/esm\.sh\/@excalidraw\/excalidraw@[\d.]+\/dist\/prod\//g, excalidrawAssetPath);
}

export function runtimeAssetsPlugin(): Plugin {
  return {
    name: "excalidraw-runtime-assets",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        {
          tag: "script", attrs: { type: "importmap" },
          children: JSON.stringify({ imports: runtimeImports }),
          injectTo: "head-prepend",
        },
        {
          tag: "script",
          children: `window.EXCALIDRAW_ASSET_PATH = ${JSON.stringify(excalidrawAssetPath)};`,
          injectTo: "head-prepend",
        },
      ],
    },
    transform(code, id) {
      if (/(?:^|[/\\])src[/\\]global\.css(?:\?.*)?$/.test(id)) {
        return rewriteRuntimeAssetUrls(code);
      }
    },
  };
}
