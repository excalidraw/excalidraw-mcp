import packageInfo from "../package.json" with { type: "json" };

export const APP_INFO = { name: "Excalidraw", version: packageInfo.version };
export const RESOURCE_URI = "ui://excalidraw/mcp-app.html";
export const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
