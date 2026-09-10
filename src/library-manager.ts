import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface LibraryIndexItem {
  shapeId: string;
  name: string;
  library: string;
  elementCount: number;
  width: number;
  height: number;
  keywords: string[];
}

export interface LibraryShapeData {
  shapeId: string;
  name: string;
  library: string;
  width: number;
  height: number;
  elements: any[];
}

export class LibraryManager {
  private indexCache: LibraryIndexItem[] | null = null;
  private storeCache: Record<string, LibraryShapeData> | null = null;
  private dataDir: string;

  constructor() {
    const candidateDirs = [
      path.join(import.meta.dirname, "..", "data"),
      path.join(import.meta.dirname, "data"),
      path.join(process.cwd(), "data"),
      path.join(process.cwd(), "dist", "data"),
    ];

    this.dataDir = candidateDirs.find((d) => fs.existsSync(path.join(d, "library-index.json"))) || candidateDirs[0];
  }

  private loadIndex(): LibraryIndexItem[] {
    if (this.indexCache) return this.indexCache;
    const indexPath = path.join(this.dataDir, "library-index.json");
    if (fs.existsSync(indexPath)) {
      try {
        this.indexCache = JSON.parse(fs.readFileSync(indexPath, "utf8"));
      } catch (err) {
        console.error("Failed to load library-index.json:", err);
        this.indexCache = [];
      }
    } else {
      this.indexCache = [];
    }
    return this.indexCache || [];
  }

  private loadStore(): Record<string, LibraryShapeData> {
    if (this.storeCache) return this.storeCache;
    const storePath = path.join(this.dataDir, "library-store.json");
    if (fs.existsSync(storePath)) {
      try {
        this.storeCache = JSON.parse(fs.readFileSync(storePath, "utf8"));
      } catch (err) {
        console.error("Failed to load library-store.json:", err);
        this.storeCache = {};
      }
    } else {
      this.storeCache = {};
    }
    return this.storeCache || {};
  }

  public listLibraries(): { library: string; count: number }[] {
    const index = this.loadIndex();
    const counts = new Map<string, number>();
    for (const item of index) {
      counts.set(item.library, (counts.get(item.library) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([library, count]) => ({ library, count }));
  }

  private static SYNONYMS: Record<string, string[]> = {
    database: ["db", "sql", "storage", "rds", "store", "table", "relational"],
    db: ["database", "sql", "storage", "rds", "store"],
    queue: ["mq", "message", "kafka", "sqs", "pubsub", "stream"],
    cache: ["redis", "memcached", "memory"],
    lb: ["load", "balancer", "ingress", "proxy", "gateway"],
    "load balancer": ["lb", "balancer", "ingress", "proxy"],
    server: ["service", "instance", "node", "compute", "vm", "host"],
    k8s: ["kubernetes", "pod", "cluster", "container"],
    kubernetes: ["k8s", "pod", "cluster", "container"],
    auth: ["iam", "login", "jwt", "security", "permission"],
    user: ["client", "actor", "person", "stick"],
  };

  public search(query: string, libraryFilter?: string, limit = 10): (LibraryIndexItem & { score: number })[] {
    const index = this.loadIndex();
    const rawTokens = (query || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    // Expand tokens with synonyms
    const queryTokens = new Set<string>();
    for (const t of rawTokens) {
      queryTokens.add(t);
      const syns = LibraryManager.SYNONYMS[t] || [];
      for (const s of syns) queryTokens.add(s);
    }

    const targetLib = libraryFilter ? libraryFilter.toLowerCase().trim() : null;
    const scored = [];

    for (const item of index) {
      if (targetLib && item.library.toLowerCase() !== targetLib) continue;

      let score = 0;
      const itemNameLower = item.name.toLowerCase();

      if (queryTokens.size === 0) {
        score = 1;
      } else {
        for (const token of queryTokens) {
          if (itemNameLower === token) {
            score += 100;
          } else if (itemNameLower.startsWith(token)) {
            score += 60;
          } else if (itemNameLower.includes(token)) {
            score += 40;
          } else if (item.keywords.includes(token)) {
            score += 20;
          } else if (item.keywords.some((k) => k.includes(token))) {
            score += 10;
          }
        }
      }

      if (score > 0) {
        scored.push({ ...item, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, Math.min(limit, 50)));
  }

  public stampShape(
    shapeId: string,
    x: number,
    y: number,
    options?: {
      label?: string;
      theme?: "dark" | "light";
    },
  ): {
    success: boolean;
    shapeId: string;
    width: number;
    height: number;
    elements: any[];
    error?: string;
  } {
    const store = this.loadStore();
    const shape = store[shapeId];

    if (!shape) {
      return {
        success: false,
        shapeId,
        width: 0,
        height: 0,
        elements: [],
        error: `Shape '${shapeId}' not found. Use search_library tool to find available shape IDs.`,
      };
    }

    const groupId = `grp_${crypto.randomUUID().slice(0, 8)}`;
    const idPrefix = `shp_${crypto.randomUUID().slice(0, 6)}`;
    const theme = options?.theme || "dark";

    const idMap = new Map<string, string>();
    shape.elements.forEach((el, i) => {
      if (el.id) idMap.set(el.id, `${idPrefix}_${i}`);
    });

    const transformedElements = shape.elements.map((el, i) => {
      const newId = idMap.get(el.id) || `${idPrefix}_${i}`;
      const clone = { ...el, id: newId };

      clone.x = Math.round(((Number(el.x) || 0) + x) * 100) / 100;
      clone.y = Math.round(((Number(el.y) || 0) + y) * 100) / 100;

      clone.groupIds = Array.isArray(el.groupIds) ? [...el.groupIds, groupId] : [groupId];

      if (clone.boundElementIds && Array.isArray(clone.boundElementIds)) {
        clone.boundElementIds = clone.boundElementIds
          .map((bid: string) => idMap.get(bid) || bid)
          .filter(Boolean);
      }

      // Theme adjustments for dark mode
      if (theme === "dark") {
        if (clone.backgroundColor === "#fff" || clone.backgroundColor === "#ffffff") {
          clone.backgroundColor = "transparent";
        }
        const darkStrokes = new Set(["#000", "#000000", "#1e1e1e", "#212529", "#2b2b2b", "#333", "#333333"]);
        if (darkStrokes.has(clone.strokeColor?.toLowerCase())) {
          clone.strokeColor = "#f8f9fa";
        }
        if (clone.type === "text" && (!clone.strokeColor || darkStrokes.has(clone.strokeColor?.toLowerCase()))) {
          clone.strokeColor = "#f8f9fa";
        }
      }

      return clone;
    });

    // If a label is provided, append centered text underneath the shape
    if (options?.label) {
      const labelText = options.label.trim();
      const fontSize = 15;
      const estimatedWidth = labelText.length * 8;
      const labelX = Math.round(x + (shape.width - estimatedWidth) / 2);
      const labelY = Math.round(y + shape.height + 8);

      const labelElement = {
        type: "text",
        id: `${idPrefix}_lbl`,
        x: labelX,
        y: labelY,
        width: estimatedWidth,
        height: 24,
        text: labelText,
        fontSize,
        fontFamily: 1, // Excalifont
        textAlign: "center",
        verticalAlign: "middle",
        strokeColor: "#f8f9fa",
        backgroundColor: "transparent",
        roughness: 0,
        opacity: 100,
        groupIds: [groupId],
      };

      transformedElements.push(labelElement);
    }

    return {
      success: true,
      shapeId,
      width: shape.width,
      height: shape.height,
      elements: transformedElements,
    };
  }
}

export const defaultLibraryManager = new LibraryManager();
