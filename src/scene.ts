export const SCENE_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxInputBytes: 5 * 1024 * 1024,
  maxElements: 5_000,
  maxOperations: 10_000,
  maxFiles: 100,
  maxFileBytes: 2 * 1024 * 1024,
  maxTextLength: 128_000,
  maxDepth: 32,
  maxNodes: 250_000,
  maxCoordinate: 10_000_000,
});

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue | undefined }
export type ElementType = "rectangle" | "diamond" | "ellipse" | "text" | "arrow" |
  "line" | "freedraw" | "image" | "frame" | "magicframe" | "embeddable" | "iframe";

export interface ElementBinding extends JsonObject {
  elementId: string;
  focus?: number;
  gap?: number;
  fixedPoint?: [number, number] | null;
}

export interface SceneLabel extends JsonObject {
  text: string;
  fontSize?: number;
  fontFamily?: number;
}

export interface SceneEndpoint extends JsonObject { id?: string }

/** Native elements and token-efficient skeletons; unknown fields remain JSON, not unchecked values. */
export interface SceneElement extends JsonObject {
  type: ElementType;
  id: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  angle?: number;
  text?: string;
  originalText?: string;
  fontSize?: number;
  fontFamily?: number;
  opacity?: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  roughness?: number;
  fillStyle?: "hachure" | "cross-hatch" | "solid" | "zigzag";
  strokeStyle?: "solid" | "dashed" | "dotted";
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  lineHeight?: number;
  index?: string | null;
  groupIds?: string[];
  scale?: [number, number];
  isDeleted?: boolean;
  label?: SceneLabel;
  containerId?: string | null;
  frameId?: string | null;
  fileId?: string | null;
  boundElements?: { id: string; type: "arrow" | "text" }[] | null;
  startBinding?: ElementBinding | null;
  endBinding?: ElementBinding | null;
  start?: SceneEndpoint;
  end?: SceneEndpoint;
  points?: [number, number][];
}

export interface BinaryFileData {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
  lastRetrieved?: number;
  version?: number;
}
export interface BinaryFiles { [fileId: string]: BinaryFileData }
export interface ViewportRect { x: number; y: number; width: number; height: number }
export interface PersistentAppState {
  viewBackgroundColor?: string;
  exportBackground?: boolean;
  exportWithDarkMode?: boolean;
  exportScale?: number;
  exportEmbedScene?: boolean;
  exportPadding?: number;
  gridModeEnabled?: boolean;
  gridSize?: number | null;
  gridStep?: number;
}
export interface SceneData {
  schemaVersion: 1;
  elements: SceneElement[];
  files: BinaryFiles;
  appState: PersistentAppState;
  viewport?: ViewportRect;
}
export interface LegacySceneRecovery {
  missingFileIds: string[];
  unavailableImages: SceneElement[];
}
export interface Checkpoint extends SceneData {
  revision: number;
  /** Read-only recovery metadata for legacy records whose original image bytes were never stored. */
  recovery?: LegacySceneRecovery;
}
export interface RestoreOperation { type: "restoreCheckpoint"; id: string }
export interface DeleteOperation { type: "delete"; ids: string[] }
export interface CameraOperation extends ViewportRect { type: "cameraUpdate" }
export type SceneOperation = SceneElement | RestoreOperation | DeleteOperation | CameraOperation;

export class SceneValidationError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, message: string, path = "scene") {
    super(`${path}: ${message}`);
    this.name = "SceneValidationError";
    this.code = code;
    this.path = path;
  }
}

export class MissingSceneFilesError extends SceneValidationError {
  readonly fileIds: string[];
  constructor(fileIds: string[]) {
    super("missing_image_files",
      `Image bytes are missing for ${fileIds.join(", ")}. Import the original scene with its files, or remove these images. Legacy element-only checkpoints cannot recover image bytes.`,
      "scene.files");
    this.name = "MissingSceneFilesError";
    this.fileIds = fileIds;
  }
}

const elementTypes = new Set<string>([
  "rectangle", "diamond", "ellipse", "text", "arrow", "line", "freedraw",
  "image", "frame", "magicframe", "embeddable", "iframe",
]);
const imageMimeTypes = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml",
  "image/avif", "image/bmp", "image/x-icon", "image/vnd.microsoft.icon", "image/jfif",
  "application/octet-stream",
]);
const encoder = new TextEncoder();

function fail(code: string, message: string, path: string): never {
  throw new SceneValidationError(code, message, path);
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

export function validateCheckpointId(value: string): void {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    fail("invalid_checkpoint_id", "Expected 1–64 letters, numbers, hyphens, or underscores.", "checkpointId");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail("invalid_object", "Expected a JSON object.", path);
  }
  return value;
}

function text(value: unknown, path: string, maxLength: number = SCENE_LIMITS.maxTextLength): string {
  if (typeof value !== "string" || value.length > maxLength) {
    fail("invalid_string", `Expected a string of at most ${maxLength} characters.`, path);
  }
  return value;
}

function id(value: unknown, path: string): string {
  const result = text(value, path, 128);
  if (!result || result.trim() !== result || /[\s,\u0000-\u001f]/u.test(result) ||
      ["__proto__", "prototype", "constructor"].includes(result)) {
    fail("invalid_id", "Expected a nonempty ID without whitespace, commas, or reserved object keys.", path);
  }
  return result;
}

function number(value: unknown, path: string, min: number = -SCENE_LIMITS.maxCoordinate, max: number = SCENE_LIMITS.maxCoordinate): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail("invalid_number", `Expected a finite number between ${min} and ${max}.`, path);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail("invalid_boolean", "Expected a boolean.", path);
  return value;
}

function jsonCopy(value: unknown, path: string): JsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, itemPath: string, depth: number): JsonValue {
    if (++nodes > SCENE_LIMITS.maxNodes || depth > SCENE_LIMITS.maxDepth) {
      fail("complexity_limit", "JSON structure is too large or deeply nested.", itemPath);
    }
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") return number(item, itemPath, -Number.MAX_VALUE, Number.MAX_VALUE);
    if (typeof item !== "object") fail("invalid_json_value", "Expected a serializable JSON value.", itemPath);
    if (ancestors.has(item)) fail("invalid_json_value", "Circular references are not supported.", itemPath);
    ancestors.add(item);
    let result: JsonValue;
    if (Array.isArray(item)) {
      result = Array.from(item, (entry, index) => visit(entry, `${itemPath}[${index}]`, depth + 1));
    } else {
      const source = record(item, itemPath);
      const target: JsonObject = {};
      for (const [key, entry] of Object.entries(source)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) {
          fail("invalid_json_key", "Reserved object keys are not supported.", `${itemPath}.${key}`);
        }
        if (entry !== undefined) target[key] = visit(entry, `${itemPath}.${key}`, depth + 1);
      }
      result = target;
    }
    ancestors.delete(item);
    return result;
  }
  return visit(value, path, 0);
}

function jsonObject(value: unknown, path: string): JsonObject {
  const copied = jsonCopy(value, path);
  if (copied === null || typeof copied !== "object" || Array.isArray(copied)) {
    fail("invalid_object", "Expected a JSON object.", path);
  }
  return copied;
}

function point(value: unknown, path: string): [number, number] {
  if (!Array.isArray(value) || value.length !== 2) fail("invalid_point", "Expected [x, y].", path);
  return [number(value[0], `${path}[0]`), number(value[1], `${path}[1]`)];
}

function binding(value: unknown, path: string): ElementBinding | null {
  if (value === null) return null;
  const source = jsonObject(value, path);
  const result: ElementBinding = { ...source, elementId: id(source.elementId, `${path}.elementId`) };
  if (source.focus !== undefined) result.focus = number(source.focus, `${path}.focus`);
  if (source.gap !== undefined) result.gap = number(source.gap, `${path}.gap`, 0);
  if (source.fixedPoint !== undefined) {
    result.fixedPoint = source.fixedPoint === null ? null : point(source.fixedPoint, `${path}.fixedPoint`);
  }
  return result;
}

function label(value: unknown, path: string): SceneLabel {
  const source = jsonObject(value, path);
  const result: SceneLabel = { ...source, text: text(source.text, `${path}.text`) };
  for (const key of ["fontSize", "fontFamily"] as const) {
    delete result[key];
    if (source[key] !== undefined) result[key] = number(source[key], `${path}.${key}`, Number.MIN_VALUE, 10_000);
  }
  return result;
}

function endpoint(value: unknown, path: string): SceneEndpoint {
  const source = jsonObject(value, path);
  const result: SceneEndpoint = { ...source };
  delete result.id;
  if (source.id !== undefined) result.id = id(source.id, `${path}.id`);
  if (source.type !== undefined && !["rectangle", "ellipse", "diamond", "text"].includes(String(source.type))) {
    fail("invalid_endpoint", "An inline endpoint must be a rectangle, ellipse, diamond, or text.", path);
  }
  if (source.type === "text") text(source.text, `${path}.text`);
  if (source.type === undefined && source.id === undefined) {
    fail("invalid_endpoint", "An endpoint needs an existing id or an inline shape type.", path);
  }
  for (const field of ["x", "y", "width", "height"] as const) {
    if (source[field] !== undefined) number(source[field], `${path}.${field}`);
  }
  return result;
}

function isElementType(value: string): value is ElementType {
  return elementTypes.has(value);
}

function element(value: unknown, path: string): SceneElement {
  const source = jsonObject(value, path);
  const type = text(source.type, `${path}.type`, 32);
  if (!isElementType(type)) fail("invalid_element_type", `Unsupported element type "${type}".`, `${path}.type`);
  const result: SceneElement = {
    ...source, type,
    id: id(source.id, `${path}.id`), x: number(source.x, `${path}.x`), y: number(source.y, `${path}.y`),
  };
  for (const key of ["width", "height", "strokeWidth", "roughness", "roundness", "fontSize", "fontFamily",
    "angle", "opacity", "text", "originalText", "label", "isDeleted", "containerId", "frameId", "fileId",
    "boundElements", "startBinding", "endBinding", "start", "end", "points"]) {
    delete result[key];
  }
  for (const key of ["width", "height", "strokeWidth", "roughness"] as const) {
    const signedExtent = (key === "width" || key === "height") && ["arrow", "line", "freedraw"].includes(type);
    if (source[key] !== undefined) result[key] = number(source[key], `${path}.${key}`, signedExtent ? -SCENE_LIMITS.maxCoordinate : 0);
  }
  for (const key of ["fontSize", "fontFamily"] as const) {
    if (source[key] !== undefined) result[key] = number(source[key], `${path}.${key}`, Number.MIN_VALUE, 10_000);
  }
  if (source.angle !== undefined) result.angle = number(source.angle, `${path}.angle`);
  if (source.opacity !== undefined) result.opacity = number(source.opacity, `${path}.opacity`, 0, 100);
  for (const key of ["strokeColor", "backgroundColor", "status"] as const) {
    if (source[key] !== undefined) result[key] = text(source[key], `${path}.${key}`, 256);
  }
  for (const key of ["index", "name"] as const) {
    if (source[key] !== undefined) result[key] = source[key] === null ? null : text(source[key], `${path}.${key}`, 256);
  }
  for (const key of ["seed", "version", "versionNonce", "updated"] as const) {
    if (source[key] !== undefined) result[key] = number(source[key], `${path}.${key}`, 0, Number.MAX_SAFE_INTEGER);
  }
  for (const key of ["locked", "autoResize", "simulatePressure", "elbowed"] as const) {
    if (source[key] !== undefined) result[key] = boolean(source[key], `${path}.${key}`);
  }
  if (source.link !== undefined) result.link = source.link === null ? null : text(source.link, `${path}.link`, 8_192);
  if (source.lineHeight !== undefined) result.lineHeight = number(source.lineHeight, `${path}.lineHeight`, Number.MIN_VALUE, 100);
  if (source.scale !== undefined) result.scale = point(source.scale, `${path}.scale`);
  if (source.lastCommittedPoint !== undefined) {
    result.lastCommittedPoint = source.lastCommittedPoint === null ? null : point(source.lastCommittedPoint, `${path}.lastCommittedPoint`);
  }
  if (source.crop !== undefined) {
    if (source.crop === null) result.crop = null;
    else {
      const crop = jsonObject(source.crop, `${path}.crop`);
      for (const key of ["x", "y", "width", "height", "naturalWidth", "naturalHeight"] as const) {
        number(crop[key], `${path}.crop.${key}`, 0);
      }
      result.crop = crop;
    }
  }
  if (source.fixedSegments !== undefined) {
    if (source.fixedSegments === null) result.fixedSegments = null;
    else {
      if (!Array.isArray(source.fixedSegments)) fail("invalid_segments", "Expected an array of fixed arrow segments.", `${path}.fixedSegments`);
      result.fixedSegments = source.fixedSegments.map((entry, index) => {
        const segmentPath = `${path}.fixedSegments[${index}]`;
        const segment = jsonObject(entry, segmentPath);
        return { ...segment, start: point(segment.start, `${segmentPath}.start`),
          end: point(segment.end, `${segmentPath}.end`), index: number(segment.index, `${segmentPath}.index`, 0) };
      });
    }
  }
  if (source.pressures !== undefined) {
    if (!Array.isArray(source.pressures)) fail("invalid_pressures", "Expected an array of pressure values.", `${path}.pressures`);
    result.pressures = source.pressures.map((entry, index) => number(entry, `${path}.pressures[${index}]`, 0, 1));
  }
  for (const [key, allowed] of [
    ["fillStyle", ["hachure", "cross-hatch", "solid", "zigzag"]],
    ["strokeStyle", ["solid", "dashed", "dotted"]],
    ["textAlign", ["left", "center", "right"]],
    ["verticalAlign", ["top", "middle", "bottom"]],
    ["startArrowhead", [null, "arrow", "bar", "dot", "circle", "circle_outline", "triangle", "triangle_outline", "diamond", "diamond_outline", "crowfoot_one", "crowfoot_many", "crowfoot_one_or_many"]],
    ["endArrowhead", [null, "arrow", "bar", "dot", "circle", "circle_outline", "triangle", "triangle_outline", "diamond", "diamond_outline", "crowfoot_one", "crowfoot_many", "crowfoot_one_or_many"]],
  ] as const) {
    const field = source[key];
    if (field !== undefined && !(allowed as readonly JsonValue[]).includes(field)) {
      fail("invalid_style", `Unsupported ${key} value.`, `${path}.${key}`);
    }
  }
  if (source.isDeleted !== undefined) result.isDeleted = boolean(source.isDeleted, `${path}.isDeleted`);
  for (const key of ["text", "originalText"] as const) {
    if (source[key] !== undefined) result[key] = text(source[key], `${path}.${key}`);
  }
  if (type === "text" && result.text === undefined) fail("missing_text", "Text elements require text.", path);
  if (source.roundness !== undefined) {
    if (source.roundness === null) result.roundness = null;
    else {
      const rounded = jsonObject(source.roundness, `${path}.roundness`);
      number(rounded.type, `${path}.roundness.type`, 1, 3);
      if (rounded.value !== undefined) number(rounded.value, `${path}.roundness.value`, 0);
      result.roundness = rounded;
    }
  }
  if (source.label !== undefined) result.label = label(source.label, `${path}.label`);
  for (const key of ["containerId", "frameId", "fileId"] as const) {
    if (source[key] !== undefined) result[key] = source[key] === null ? null : id(source[key], `${path}.${key}`);
  }
  for (const key of ["startBinding", "endBinding"] as const) {
    if (source[key] !== undefined) result[key] = binding(source[key], `${path}.${key}`);
  }
  for (const key of ["start", "end"] as const) {
    if (source[key] !== undefined) result[key] = endpoint(source[key], `${path}.${key}`);
  }
  if (source.boundElements !== undefined) {
    if (source.boundElements === null) result.boundElements = null;
    else {
      if (!Array.isArray(source.boundElements)) fail("invalid_bindings", "Expected an array or null.", `${path}.boundElements`);
      result.boundElements = source.boundElements.map((entry, index) => {
        const ref = record(entry, `${path}.boundElements[${index}]`);
        if (ref.type !== "text" && ref.type !== "arrow") fail("invalid_binding_type", "Expected text or arrow.", `${path}.boundElements[${index}].type`);
        return { id: id(ref.id, `${path}.boundElements[${index}].id`), type: ref.type };
      });
    }
  }
  if (source.points !== undefined) {
    if (!Array.isArray(source.points)) fail("invalid_points", "Expected an array of coordinate pairs.", `${path}.points`);
    result.points = source.points.map((entry, index) => point(entry, `${path}.points[${index}]`));
  }
  if (type === "freedraw" && !result.points?.length) {
    fail("missing_points", "Freehand elements require at least one [x, y] point.", `${path}.points`);
  }
  if (source.groupIds !== undefined) {
    if (!Array.isArray(source.groupIds)) fail("invalid_groups", "Expected an array of group IDs.", `${path}.groupIds`);
    result.groupIds = source.groupIds.map((entry, index) => id(entry, `${path}.groupIds[${index}]`));
  }
  if (source.children !== undefined) {
    if (!Array.isArray(source.children)) fail("invalid_children", "Expected an array of frame child IDs.", `${path}.children`);
    result.children = source.children.map((entry, index) => id(entry, `${path}.children[${index}]`));
  }
  return result;
}

function viewport(value: unknown, path: string): ViewportRect {
  const source = record(value, path);
  return {
    x: number(source.x, `${path}.x`), y: number(source.y, `${path}.y`),
    width: number(source.width, `${path}.width`, Number.MIN_VALUE),
    height: number(source.height, `${path}.height`, Number.MIN_VALUE),
  };
}

function isDrawingElement(value: SceneOperation): value is SceneElement {
  return value.type !== "restoreCheckpoint" && value.type !== "delete" && value.type !== "cameraUpdate";
}

function operations(value: unknown): SceneOperation[] {
  if (!Array.isArray(value)) fail("invalid_operations", "Expected an array of elements and operations.", "elements");
  if (value.length > SCENE_LIMITS.maxOperations) fail("operation_limit", "Too many operations.", "elements");
  const result: SceneOperation[] = value.map((entry, index) => {
    const path = `elements[${index}]`;
    const source = record(entry, path);
    switch (source.type) {
      case "restoreCheckpoint": {
        if (index !== 0) fail("invalid_restore_order", "A single restoreCheckpoint is allowed, and must be first.", path);
        const checkpointId = text(source.id, `${path}.id`, 64);
        validateCheckpointId(checkpointId);
        return { type: "restoreCheckpoint", id: checkpointId };
      }
      case "cameraUpdate": return { type: "cameraUpdate", ...viewport(source, path) };
      case "delete": {
        if (source.ids !== undefined && source.id !== undefined) fail("ambiguous_delete", "Use ids, not both ids and id.", path);
        const raw = source.ids ?? source.id;
        const ids = typeof raw === "string" ? raw.split(",").map(part => part.trim()) : raw;
        if (!Array.isArray(ids) || ids.length === 0) fail("invalid_delete", "Provide a nonempty ids array or comma-separated string.", path);
        const parsed = ids.map((entry, index) => id(entry, `${path}.ids[${index}]`));
        if (new Set(parsed).size !== parsed.length) fail("duplicate_delete_id", "Each delete target must be unique.", path);
        return { type: "delete", ids: parsed };
      }
      default: return element(source, path);
    }
  });
  const added = new Set<string>();
  for (const entry of result) {
    if (!isDrawingElement(entry)) continue;
    if (added.has(entry.id)) fail("duplicate_element_id", `Element ID "${entry.id}" is duplicated or reused. Use a new ID.`, "elements");
    added.add(entry.id);
  }
  return result;
}

export function parseElementsInput(json: string): SceneOperation[] {
  if (typeof json !== "string") fail("invalid_input", "Expected a JSON string.", "elements");
  if (utf8ByteLength(json) > SCENE_LIMITS.maxInputBytes) fail("input_size_limit", `Input exceeds ${SCENE_LIMITS.maxInputBytes} UTF-8 bytes.`, "elements");
  let decoded: unknown;
  try { decoded = JSON.parse(json); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    fail("invalid_json", "Invalid JSON; provide a complete array.", "elements");
  }
  return operations(decoded);
}

export function findRestoreCheckpoint(value: readonly SceneOperation[]): string | undefined {
  return operations(value).find((entry): entry is RestoreOperation => entry.type === "restoreCheckpoint")?.id;
}

function persistentAppState(value: unknown): PersistentAppState {
  const source = record(value, "scene.appState");
  const result: PersistentAppState = {};
  if (source.viewBackgroundColor !== undefined) result.viewBackgroundColor = text(source.viewBackgroundColor, "scene.appState.viewBackgroundColor", 256);
  for (const key of ["exportBackground", "exportWithDarkMode", "exportEmbedScene", "gridModeEnabled"] as const) {
    if (source[key] !== undefined) result[key] = boolean(source[key], `scene.appState.${key}`);
  }
  if (source.exportScale !== undefined) result.exportScale = number(source.exportScale, "scene.appState.exportScale", Number.MIN_VALUE, 10);
  if (source.exportPadding !== undefined) result.exportPadding = number(source.exportPadding, "scene.appState.exportPadding", 0, 1_000);
  if (source.gridSize !== undefined) result.gridSize = source.gridSize === null ? null : number(source.gridSize, "scene.appState.gridSize", Number.MIN_VALUE, 1_000);
  if (source.gridStep !== undefined) result.gridStep = number(source.gridStep, "scene.appState.gridStep", Number.MIN_VALUE, 1_000);
  return result;
}

function binaryFiles(value: unknown): BinaryFiles {
  const source = record(value, "scene.files");
  if (Object.keys(source).length > SCENE_LIMITS.maxFiles) fail("file_count_limit", "Too many image files.", "scene.files");
  const result: BinaryFiles = {};
  for (const [key, entry] of Object.entries(source)) {
    const path = `scene.files.${key}`;
    id(key, path);
    const file = record(entry, path);
    if (id(file.id, `${path}.id`) !== key) fail("file_id_mismatch", "File ID must equal its dictionary key.", path);
    const mimeType = text(file.mimeType, `${path}.mimeType`, 64).toLowerCase();
    if (!imageMimeTypes.has(mimeType)) fail("unsupported_image_type", "Unsupported image MIME type.", path);
    const dataURL = text(file.dataURL, `${path}.dataURL`, Math.ceil(SCENE_LIMITS.maxFileBytes / 3) * 4 + 128);
    const prefix = `data:${mimeType};base64,`;
    if (!dataURL.toLowerCase().startsWith(prefix)) fail("invalid_image_data", "Expected a base64 data URL matching the image MIME type.", path);
    const encoded = dataURL.slice(prefix.length);
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      fail("invalid_image_data", "Image data contains invalid base64.", path);
    }
    let padding = 0;
    if (encoded.endsWith("==")) padding = 2;
    else if (encoded.endsWith("=")) padding = 1;
    if (encoded.length / 4 * 3 - padding > SCENE_LIMITS.maxFileBytes) fail("image_size_limit", `Image exceeds ${SCENE_LIMITS.maxFileBytes} decoded bytes.`, path);
    const parsed: BinaryFileData = {
      id: key, mimeType, dataURL,
      created: number(file.created, `${path}.created`, 0, Number.MAX_SAFE_INTEGER),
    };
    for (const field of ["lastRetrieved", "version"] as const) {
      if (file[field] !== undefined) parsed[field] = number(file[field], `${path}.${field}`, 0, Number.MAX_SAFE_INTEGER);
    }
    result[key] = parsed;
  }
  return result;
}

function cleanBindings(elements: SceneElement[], removed: Set<string>): SceneElement[] {
  const filtered = elements.filter(entry => !entry.isDeleted &&
    !(entry.type === "text" && entry.containerId && removed.has(entry.containerId)));
  const byId = new Map(filtered.map(entry => [entry.id, entry]));
  for (const entry of filtered) {
    if (entry.containerId && !byId.has(entry.containerId)) entry.containerId = null;
    if (entry.frameId && !["frame", "magicframe"].includes(byId.get(entry.frameId)?.type ?? "")) entry.frameId = null;
    if (entry.boundElements) entry.boundElements = entry.boundElements.filter(ref => byId.get(ref.id)?.type === ref.type);
    if ((entry.type === "frame" || entry.type === "magicframe") && Array.isArray(entry.children)) {
      entry.children = entry.children.filter(child => typeof child === "string" && byId.has(child));
    }
    for (const key of ["startBinding", "endBinding"] as const) {
      if (entry[key] && !byId.has(entry[key].elementId)) entry[key] = null;
    }
    for (const key of ["start", "end"] as const) {
      if (entry[key]?.id && entry[key].type === undefined && !byId.has(entry[key].id)) delete entry[key];
    }
  }
  return filtered;
}

function unavailableImages(scene: SceneData): SceneElement[] {
  return scene.elements.filter(entry => entry.type === "image" &&
    (!entry.fileId || !Object.hasOwn(scene.files, entry.fileId)));
}

function missingFileIds(images: SceneElement[]): string[] {
  return [...new Set(images.map(entry => entry.fileId || `(image ${entry.id} has no fileId)`))];
}

function checkScene(scene: SceneData, allowMissingFiles = false): SceneData {
  if (scene.elements.length > SCENE_LIMITS.maxElements) fail("element_limit", "Too many elements after restoring the scene.", "scene.elements");
  if (utf8ByteLength(JSON.stringify(scene)) > SCENE_LIMITS.maxBytes) fail("scene_size_limit", `Scene exceeds ${SCENE_LIMITS.maxBytes} UTF-8 bytes after restoration.`, "scene");
  const missing = missingFileIds(unavailableImages(scene));
  if (missing.length && !allowMissingFiles) throw new MissingSceneFilesError(missing);
  return scene;
}

function decodeSceneData(value: unknown): SceneData {
  const source = record(value, "scene");
  if (source.schemaVersion !== undefined && source.schemaVersion !== 1) fail("unsupported_schema", "Only scene schemaVersion 1 is supported.", "scene.schemaVersion");
  if (source.schemaVersion === 1 && (source.files === undefined || source.appState === undefined)) {
    fail("incomplete_scene", "Versioned scenes require files and appState, even when empty.", "scene");
  }
  if (!Array.isArray(source.elements)) fail("invalid_elements", "Expected an elements array (an empty array is valid).", "scene.elements");
  const parsed = operations(source.elements);
  const elements: SceneElement[] = [];
  let camera = source.viewport === undefined ? undefined : viewport(source.viewport, "scene.viewport");
  for (const entry of parsed) {
    if (entry.type === "cameraUpdate" && source.schemaVersion === undefined) {
      if (source.viewport === undefined) camera = viewport(entry, "scene.elements.cameraUpdate");
    } else if (!isDrawingElement(entry)) {
      fail("noncanonical_scene", "Stored scenes must be self-contained; use the operation reducer and the separate viewport field.", "scene.elements");
    } else elements.push(entry);
  }
  const removed = new Set(elements.filter(entry => entry.isDeleted).map(entry => entry.id));
  return {
    schemaVersion: 1,
    elements: cleanBindings(elements, removed),
    files: binaryFiles(source.files === undefined ? {} : source.files),
    appState: persistentAppState(source.appState === undefined ? {} : source.appState),
    ...(camera ? { viewport: camera } : {}),
  };
}

export function parseSceneData(value: unknown): SceneData {
  return checkScene(decodeSceneData(value));
}

/** Recover useful legacy content without fabricating image bytes or silently losing the unavailable records. */
export function recoverLegacySceneData(value: unknown): { scene: SceneData; recovery?: LegacySceneRecovery } {
  const source = record(value, "scene");
  if (source.schemaVersion !== undefined) {
    fail("not_legacy_scene", "Image recovery is only available for legacy scenes without schemaVersion.", "scene");
  }
  const decoded = checkScene(decodeSceneData(source), true);
  const images = unavailableImages(decoded);
  if (!images.length) return { scene: decoded };
  const quarantined = new Set(images.map(entry => entry.id));
  const scene = parseSceneData({
    ...decoded,
    elements: decoded.elements.filter(entry => !quarantined.has(entry.id)),
  });
  return { scene, recovery: { missingFileIds: missingFileIds(images), unavailableImages: images } };
}

/** Ordered, pure reduction. IDs cannot be reused, including IDs removed earlier in this operation list. */
export function reduceSceneOperations(value: readonly SceneOperation[], base?: SceneData): SceneData {
  const parsed = operations(value);
  if (parsed[0]?.type === "restoreCheckpoint" && base === undefined) fail("missing_restore", `Load checkpoint "${parsed[0].id}" before reducing its operations.`, "elements[0]");
  const scene = base === undefined ? parseSceneData({ elements: [] }) : parseSceneData(base);
  const elements = new Map(scene.elements.map(entry => [entry.id, entry]));
  const used = new Set(elements.keys());
  const removed = new Set<string>();
  for (let index = 0; index < parsed.length; index++) {
    const entry = parsed[index];
    switch (entry.type) {
      case "restoreCheckpoint":
        continue;
      case "cameraUpdate":
        scene.viewport = viewport(entry, `elements[${index}]`);
        break;
      case "delete": {
        for (const target of entry.ids) {
          if (!elements.has(target) && !removed.has(target)) fail("unknown_delete_target", `Delete target "${target}" does not exist at this point in the scene.`, `elements[${index}]`);
        }
        const deleted = new Set(entry.ids);
        for (const item of elements.values()) {
          if (item.type === "text" && item.containerId && deleted.has(item.containerId)) deleted.add(item.id);
        }
        for (const target of deleted) {
          elements.delete(target);
          removed.add(target);
        }
        break;
      }
      default: {
        if (used.has(entry.id)) fail("duplicate_element_id", `Element ID "${entry.id}" already exists or was deleted. Use a new ID.`, `elements[${index}]`);
        used.add(entry.id);
        if (entry.isDeleted || (entry.type === "text" && entry.containerId && removed.has(entry.containerId))) removed.add(entry.id);
        else elements.set(entry.id, entry);
      }
    }
  }
  scene.elements = cleanBindings([...elements.values()], removed);
  return checkScene(scene);
}
