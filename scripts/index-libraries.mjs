#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const libSourceDir = process.argv[2] 
  ? path.resolve(process.argv[2]) 
  : (fs.existsSync(path.resolve(root, "libraries")) ? path.resolve(root, "libraries") : path.resolve(root, ".."));
const dataDir = path.join(root, "data");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

const LIB_KEY_MAP = {
  "architecture-diagram-components.excalidrawlib": "architecture",
  "aws-architecture-icons.excalidrawlib": "aws",
  "basic-ux-wireframing-elements.excalidrawlib": "ux",
  "data-viz.excalidrawlib": "data-viz",
  "db-eng.excalidrawlib": "db-eng",
  "dev_ops.excalidrawlib": "devops",
  "forms.excalidrawlib": "forms",
  "google-icons.excalidrawlib": "google",
  "network-topology-icons.excalidrawlib": "network",
  "software-architecture.excalidrawlib": "software-arch",
  "stick-figures.excalidrawlib": "stick-figures",
  "storytelling.excalidrawlib": "storytelling",
  "system-design.excalidrawlib": "system-design",
  "systems-design-components.excalidrawlib": "system-design-components",
};

const files = fs.readdirSync(libSourceDir).filter((f) => f.endsWith(".excalidrawlib"));

const indexList = [];
const shapeStore = {};
const idCounters = new Map();

for (const f of files) {
  const libKey = LIB_KEY_MAP[f] || slugify(f.replace(".excalidrawlib", ""));
  const raw = JSON.parse(fs.readFileSync(path.join(libSourceDir, f), "utf8"));
  const items = raw.library || raw.libraryItems || [];

  console.log(`Processing ${f} (${items.length} items)...`);

  items.forEach((item, index) => {
    let rawElements = [];
    let name = "";

    if (Array.isArray(item)) {
      rawElements = item;
      const textElements = rawElements.filter((e) => e.type === "text" && e.text);
      if (textElements.length > 0) {
        name = textElements.map((t) => t.text.trim()).join(" ").replace(/\s+/g, " ");
        if (name.length > 50) name = name.substring(0, 50) + "...";
      } else {
        name = `${libKey}-shape-${index + 1}`;
      }
    } else if (item && typeof item === "object") {
      rawElements = item.elements || [];
      name = item.name || "";
      if (!name) {
        const textElements = rawElements.filter((e) => e.type === "text" && e.text);
        if (textElements.length > 0) {
          name = textElements.map((t) => t.text.trim()).join(" ").replace(/\s+/g, " ");
        } else {
          name = `${libKey}-shape-${index + 1}`;
        }
      }
    }

    if (!rawElements || rawElements.length === 0) return;

    // Filter out deleted elements
    const validElements = rawElements.filter((e) => !e.isDeleted);
    if (validElements.length === 0) return;

    // Compute bounding box
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const el of validElements) {
      const x = Number(el.x) || 0;
      const y = Number(el.y) || 0;
      const w = Number(el.width) || 0;
      const h = Number(el.height) || 0;

      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + w > maxX) maxX = x + w;
      if (y + h > maxY) maxY = y + h;
    }

    if (!isFinite(minX) || !isFinite(minY)) return;

    const width = Math.max(1, Math.round(maxX - minX));
    const height = Math.max(1, Math.round(maxY - minY));

    // Normalize coordinates so top-left is (0, 0)
    const normalizedElements = validElements.map((el) => {
      const clone = { ...el };
      clone.x = Math.round(((Number(el.x) || 0) - minX) * 100) / 100;
      clone.y = Math.round(((Number(el.y) || 0) - minY) * 100) / 100;
      return clone;
    });

    // Generate unique slug ID
    const baseSlug = `${libKey}/${slugify(name)}`;
    const count = (idCounters.get(baseSlug) || 0) + 1;
    idCounters.set(baseSlug, count);
    const shapeId = count === 1 ? baseSlug : `${baseSlug}-${count}`;

    // Extract text keywords
    const internalTexts = validElements
      .filter((e) => e.type === "text" && e.text)
      .map((e) => e.text)
      .join(" ");

    const keywords = Array.from(
      new Set(
        `${name} ${libKey} ${internalTexts}`
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .split(" ")
          .filter((k) => k.length >= 2),
      ),
    );

    indexList.push({
      shapeId,
      name,
      library: libKey,
      elementCount: normalizedElements.length,
      width,
      height,
      keywords,
    });

    shapeStore[shapeId] = {
      shapeId,
      name,
      library: libKey,
      width,
      height,
      elements: normalizedElements,
    };
  });
}

// Write outputs
fs.writeFileSync(path.join(dataDir, "library-index.json"), JSON.stringify(indexList, null, 2));
fs.writeFileSync(path.join(dataDir, "library-store.json"), JSON.stringify(shapeStore));

const indexStats = fs.statSync(path.join(dataDir, "library-index.json"));
const storeStats = fs.statSync(path.join(dataDir, "library-store.json"));

console.log(`\nIndexing complete!`);
console.log(`- Total shapes indexed: ${indexList.length}`);
console.log(`- library-index.json: ${(indexStats.size / 1024).toFixed(1)} KB`);
console.log(`- library-store.json: ${(storeStats.size / 1024 / 1024).toFixed(2)} MB`);
