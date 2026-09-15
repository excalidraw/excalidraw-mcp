/**
 * Dev entry point — renders ExcalidrawAppCore with a mock MCP App.
 *
 * Usage: pnpm dev:ui → opens browser with the widget + sample diagram.
 * Click fullscreen button to test the Excalidraw editor.
 *
 * Future: add a control panel to stream elements, test checkpoints, etc.
 */
import { createRoot } from "react-dom/client";
import { useMemo } from "react";
import { ExcalidrawAppCore } from "./mcp-app";
import { createMockApp, type MockAppControls } from "./dev-mock";
import "./global.css";

// ── Sample elements (skeleton format with labels, same as LLM output) ────

// @prettier-ignore
// @oxc-ignore
const SAMPLE_ELEMENTS = [
  {
    type: "rectangle",
    id: "client",
    x: 60,
    y: 120,
    width: 180,
    height: 80,
    roundness: { type: 3 },
    backgroundColor: "#a5d8ff",
    fillStyle: "solid",
    strokeColor: "#1e1e1e",
    label: { text: "Client App", fontSize: 20 },
  },
  {
    type: "rectangle",
    id: "server",
    x: 400,
    y: 120,
    width: 180,
    height: 80,
    roundness: { type: 3 },
    backgroundColor: "#b2f2bb",
    fillStyle: "solid",
    strokeColor: "#1e1e1e",
    label: { text: "MCP Server", fontSize: 20 },
  },
  {
    type: "rectangle",
    id: "db",
    x: 400,
    y: 320,
    width: 180,
    height: 80,
    roundness: { type: 3 },
    backgroundColor: "#d0bfff",
    fillStyle: "solid",
    strokeColor: "#1e1e1e",
    label: { text: "Database", fontSize: 20 },
  },
  {
    type: "arrow",
    id: "a1",
    x: 240,
    y: 160,
    width: 160,
    height: 0,
    points: [
      [0, 0],
      [160, 0],
    ],
    strokeColor: "#1e1e1e",
    strokeWidth: 2,
    endArrowhead: "arrow",
    label: { text: "request", fontSize: 14 },
  },
  {
    type: "arrow",
    id: "a2",
    x: 490,
    y: 200,
    width: 0,
    height: 120,
    points: [
      [0, 0],
      [0, 120],
    ],
    strokeColor: "#1e1e1e",
    strokeWidth: 2,
    endArrowhead: "arrow",
    label: { text: "query", fontSize: 14 },
  },
];

// ── Dev control panel ────────────────────────────────────────────────────

function DevControls({ mock }: { mock: MockAppControls }) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        right: 12,
        zIndex: 10000,
        display: "flex",
        flexWrap: "wrap",
        maxWidth: "calc(100% - 24px)",
        gap: 6,
        padding: "8px 10px",
        background: "rgba(0,0,0,0.75)",
        borderRadius: 8,
        fontFamily: "system-ui",
        fontSize: 12,
        color: "#fff",
      }}
    >
      <button
        onClick={() => { mock.sendToolInput(SAMPLE_ELEMENTS); mock.sendToolResult(); }}
        style={btnStyle}
      >
        Load (instant)
      </button>
      <button
        onClick={() => mock.streamElements(SAMPLE_ELEMENTS, 300)}
        style={btnStyle}
      >
        Stream
      </button>
      <button onClick={() => mock.sendToolResult("dev-cp-1")} style={btnStyle}>
        Send Result
      </button>
      <button onClick={() => mock.sendCancelled()} style={btnStyle}>Cancel stream</button>
      <button onClick={() => mock.sendInvalidInput("[null]")} style={btnStyle}>Invalid final input</button>
      <button onClick={() => { mock.sendToolInput([]); mock.sendToolResult(); }} style={btnStyle}>Empty scene</button>
      <button onClick={() => {
        mock.sendSceneInput({
          schemaVersion: 1,
          elements: [{ id: "sample-image", type: "image", version: 1, x: 0, y: 0, width: 240, height: 160, fileId: "sample-image-file", scale: [1, 1], status: "saved" }],
          files: {
            "sample-image-file": {
              id: "sample-image-file", mimeType: "image/svg+xml", created: 1,
              dataURL: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" rx="16" fill="#a5d8ff"/><circle cx="120" cy="80" r="40" fill="#1971c2"/></svg>')}`,
            },
          },
          appState: { viewBackgroundColor: "#ffffff" },
        });
        mock.sendToolResult();
      }} style={btnStyle}>Load image scene</button>
      <button onClick={() => mock.failNextSave("error")} style={btnStyle}>Fail next save</button>
      <button onClick={() => mock.failNextSave("conflict")} style={btnStyle}>Conflict next save</button>
      <button onClick={() => mock.setHostContext({ availableDisplayModes: ["inline"] })} style={btnStyle}>Disable fullscreen</button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.15)",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 5,
  padding: "4px 10px",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  minHeight: 44,
};

// ── App ──────────────────────────────────────────────────────────────────

function DevApp() {
  const mock = useMemo(() => {
    const created = createMockApp();
    // Deliberately deliver before child mount to exercise startup buffering.
    created.sendToolInput(SAMPLE_ELEMENTS);
    created.sendToolResult("dev-checkpoint");
    return created;
  }, []);

  return (
    <>
      <ExcalidrawAppCore app={mock.app} events={mock.events} />
      <DevControls mock={mock} />
    </>
  );
}

createRoot(document.body).render(<DevApp />);
