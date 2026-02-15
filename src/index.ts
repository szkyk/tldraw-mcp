#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { homedir } from "os";
import { join, resolve, relative, isAbsolute } from "path";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";

// Configuration
const TLDRAW_DIR = process.env.TLDRAW_DIR || join(homedir(), ".tldraw");

// tldraw file format constants
const TLDRAW_FILE_FORMAT_VERSION = 1;
const SCHEMA_VERSION = 2;
const MARKDOWN_TLDRAW_START_MARKER = "!!!_START_OF_TLDRAW_DATA__DO_NOT_CHANGE_THIS_PHRASE_!!!";
const MARKDOWN_TLDRAW_END_MARKER = "!!!_END_OF_TLDRAW_DATA__DO_NOT_CHANGE_THIS_PHRASE_!!!";

// Types
interface TldrawRecord {
  id: string;
  typeName: string;
  [key: string]: unknown;
}

interface TldrawSchema {
  schemaVersion: number;
  sequences: Record<string, number>;
}

interface TldrawFile {
  tldrawFileFormatVersion: number;
  schema: TldrawSchema;
  records: TldrawRecord[];
}

interface FileInfo {
  name: string;
  path: string;
  pageCount: number;
  shapeCount: number;
}

interface SearchMatch {
  file: string;
  pageId?: string;
  pageName?: string;
  shapeId?: string;
  shapeType?: string;
  matchedText: string;
  context: string;
}

type TldrawStorageFormat = "plain-json" | "wrapped-json" | "embedded-markdown";

interface ParsedTldrawContent {
  file: TldrawFile;
  storageFormat: TldrawStorageFormat;
  wrappedContainer?: Record<string, unknown>;
}

interface MarkdownTldrawBlock {
  jsonStart: number;
  jsonEnd: number;
  jsonText: string;
}

// Security: Prevent path traversal
function securePath(inputPath: string): string {
  const baseDir = resolve(TLDRAW_DIR);
  
  // If absolute path, use it directly but verify it's safe
  const targetPath = isAbsolute(inputPath) 
    ? resolve(inputPath)
    : resolve(baseDir, inputPath);
  
  // For absolute paths outside TLDRAW_DIR, allow them but log
  // For relative paths, ensure they don't escape TLDRAW_DIR
  if (!isAbsolute(inputPath)) {
    const relativePath = relative(baseDir, targetPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`Path traversal attempt blocked: ${inputPath}`);
    }
  }
  
  return targetPath;
}

// Ensure directory exists
async function ensureDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

// Validate tldraw file format
function validateTldrawFile(data: unknown): TldrawFile {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid tldraw file: not an object');
  }
  
  const file = data as Record<string, unknown>;
  
  if (typeof file.tldrawFileFormatVersion !== 'number') {
    throw new Error('Invalid tldraw file: missing tldrawFileFormatVersion');
  }
  
  if (!file.schema || typeof file.schema !== 'object') {
    throw new Error('Invalid tldraw file: missing schema');
  }
  
  if (!Array.isArray(file.records)) {
    throw new Error('Invalid tldraw file: records must be an array');
  }
  
  // Validate each record has id and typeName
  for (const record of file.records) {
    if (!record.id || !record.typeName) {
      throw new Error('Invalid tldraw file: record missing id or typeName');
    }
  }
  
  return file as unknown as TldrawFile;
}

function isReadableTldrawPath(path: string): boolean {
  return path.endsWith(".tldr") || path.endsWith(".md");
}

function parseJsonContent(content: string, pathLabel: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${pathLabel}: ${reason}`);
  }
}

function locateMarkdownTldrawBlock(markdown: string, pathLabel: string): MarkdownTldrawBlock {
  const startIndex = markdown.indexOf(MARKDOWN_TLDRAW_START_MARKER);
  if (startIndex === -1) {
    throw new Error(
      `No embedded tldraw block found in ${pathLabel} (missing ${MARKDOWN_TLDRAW_START_MARKER})`
    );
  }

  const duplicateStartIndex = markdown.indexOf(
    MARKDOWN_TLDRAW_START_MARKER,
    startIndex + MARKDOWN_TLDRAW_START_MARKER.length
  );
  if (duplicateStartIndex !== -1) {
    throw new Error(`Multiple embedded tldraw start markers found in ${pathLabel}`);
  }

  const endIndex = markdown.indexOf(
    MARKDOWN_TLDRAW_END_MARKER,
    startIndex + MARKDOWN_TLDRAW_START_MARKER.length
  );
  if (endIndex === -1) {
    throw new Error(
      `No embedded tldraw block found in ${pathLabel} (missing ${MARKDOWN_TLDRAW_END_MARKER})`
    );
  }

  const duplicateEndIndex = markdown.indexOf(
    MARKDOWN_TLDRAW_END_MARKER,
    endIndex + MARKDOWN_TLDRAW_END_MARKER.length
  );
  if (duplicateEndIndex !== -1) {
    throw new Error(`Multiple embedded tldraw end markers found in ${pathLabel}`);
  }

  const jsonStart = startIndex + MARKDOWN_TLDRAW_START_MARKER.length;
  const jsonEnd = endIndex;
  const jsonText = markdown.slice(jsonStart, jsonEnd).trim();

  if (!jsonText) {
    throw new Error(`Embedded tldraw block is empty in ${pathLabel}`);
  }

  return {
    jsonStart,
    jsonEnd,
    jsonText,
  };
}

function normalizeTldrawPayload(data: unknown): {
  file: TldrawFile;
  wrappedContainer?: Record<string, unknown>;
} {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid tldraw file: not an object");
  }

  const payload = data as Record<string, unknown>;

  if ("raw" in payload) {
    if (!payload.raw || typeof payload.raw !== "object") {
      throw new Error("Invalid wrapped tldraw file: raw must be an object");
    }
    return {
      file: validateTldrawFile(payload.raw),
      wrappedContainer: payload,
    };
  }

  return { file: validateTldrawFile(payload) };
}

async function parseTldrawContent(path: string): Promise<ParsedTldrawContent> {
  const filepath = securePath(path);

  if (!isReadableTldrawPath(filepath)) {
    throw new Error("File must have .tldr or .md extension");
  }

  if (!existsSync(filepath)) {
    throw new Error(`File not found: ${path}`);
  }

  const content = await readFile(filepath, "utf-8");

  if (filepath.endsWith(".md")) {
    const block = locateMarkdownTldrawBlock(content, path);
    const data = parseJsonContent(block.jsonText, path);
    const { file, wrappedContainer } = normalizeTldrawPayload(data);
    return {
      file,
      storageFormat: "embedded-markdown",
      wrappedContainer,
    };
  }

  const data = parseJsonContent(content, path);
  const { file, wrappedContainer } = normalizeTldrawPayload(data);
  return {
    file,
    storageFormat: wrappedContainer ? "wrapped-json" : "plain-json",
    wrappedContainer,
  };
}

async function getWrappedContainerForTldraw(filepath: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(filepath)) {
    return undefined;
  }

  try {
    const existingContent = await readFile(filepath, "utf-8");
    const existingData = parseJsonContent(existingContent, filepath);
    if (
      existingData &&
      typeof existingData === "object" &&
      "raw" in (existingData as Record<string, unknown>) &&
      typeof (existingData as Record<string, unknown>).raw === "object"
    ) {
      return existingData as Record<string, unknown>;
    }
  } catch {
    // Best effort: if existing content can't be parsed, fallback to plain write format.
  }

  return undefined;
}

// Create empty tldraw file
function createEmptyTldrawFile(name: string = "Untitled"): TldrawFile {
  const pageId = `page:${crypto.randomUUID().slice(0, 8)}`;
  
  return {
    tldrawFileFormatVersion: TLDRAW_FILE_FORMAT_VERSION,
    schema: {
      schemaVersion: SCHEMA_VERSION,
      sequences: {
        "com.tldraw.store": 4,
        "com.tldraw.asset": 1,
        "com.tldraw.camera": 1,
        "com.tldraw.document": 2,
        "com.tldraw.instance": 25,
        "com.tldraw.instance_page_state": 5,
        "com.tldraw.page": 1,
        "com.tldraw.pointer": 1,
        "com.tldraw.shape": 4,
        "com.tldraw.shape.geo": 10,
        "com.tldraw.shape.text": 3,
        "com.tldraw.shape.note": 9,
        "com.tldraw.shape.arrow": 6,
      }
    },
    records: [
      {
        id: "document:document",
        typeName: "document",
        gridSize: 10,
        name,
        meta: {}
      },
      {
        id: pageId,
        typeName: "page",
        name: "Page 1",
        index: "a1",
        meta: {}
      },
      {
        id: `instance_page_state:${pageId}`,
        typeName: "instance_page_state",
        pageId,
        selectedShapeIds: [],
        hintingShapeIds: [],
        erasingShapeIds: [],
        hoveredShapeId: null,
        editingShapeId: null,
        croppingShapeId: null,
        focusedGroupId: null,
        meta: {}
      },
      {
        id: `camera:${pageId}`,
        typeName: "camera",
        x: 0,
        y: 0,
        z: 1,
        meta: {}
      }
    ]
  };
}

// Extract text from richText structure
function extractText(richText: unknown): string {
  if (!richText || typeof richText !== 'object') return '';
  
  const rt = richText as Record<string, unknown>;
  if (!Array.isArray(rt.content)) return '';
  
  const texts: string[] = [];
  for (const block of rt.content) {
    if (block && typeof block === 'object' && Array.isArray((block as Record<string, unknown>).content)) {
      for (const inline of (block as Record<string, unknown>).content as unknown[]) {
        if (inline && typeof inline === 'object' && typeof (inline as Record<string, unknown>).text === 'string') {
          texts.push((inline as Record<string, unknown>).text as string);
        }
      }
    }
  }
  
  return texts.join(' ');
}

// Tool implementations
async function tldrawRead(path: string): Promise<TldrawFile> {
  const parsed = await parseTldrawContent(path);
  return parsed.file;
}

async function tldrawWrite(path: string, content: TldrawFile | string): Promise<string> {
  const filepath = securePath(path);
  
  if (!isReadableTldrawPath(filepath)) {
    throw new Error('File must have .tldr or .md extension');
  }

  const parsedInput = typeof content === "string"
    ? parseJsonContent(content, path)
    : content;
  const { file, wrappedContainer: inputWrappedContainer } = normalizeTldrawPayload(parsedInput);

  if (filepath.endsWith(".md")) {
    if (!existsSync(filepath)) {
      throw new Error(`File not found: ${path}`);
    }

    const markdownContent = await readFile(filepath, "utf-8");
    const block = locateMarkdownTldrawBlock(markdownContent, path);
    const existingData = parseJsonContent(block.jsonText, path);
    const { wrappedContainer: existingWrappedContainer } = normalizeTldrawPayload(existingData);

    const wrappedContainer = existingWrappedContainer || inputWrappedContainer;
    const outputContent = wrappedContainer
      ? { ...wrappedContainer, raw: file }
      : file;

    const updatedMarkdown = `${markdownContent.slice(0, block.jsonStart)}\n${JSON.stringify(outputContent, null, 2)}\n${markdownContent.slice(block.jsonEnd)}`;
    await writeFile(filepath, updatedMarkdown, "utf-8");
    return `Successfully wrote: ${path}`;
  }

  // Ensure parent directory exists for .tldr writes
  const dir = filepath.substring(0, filepath.lastIndexOf('/'));
  await ensureDir(dir);

  const existingWrappedContainer = await getWrappedContainerForTldraw(filepath);
  const wrappedContainer = existingWrappedContainer || inputWrappedContainer;
  const outputContent = wrappedContainer
    ? { ...wrappedContainer, raw: file }
    : file;

  await writeFile(filepath, JSON.stringify(outputContent, null, 2), 'utf-8');
  
  return `Successfully wrote: ${path}`;
}

async function tldrawList(recursive: boolean = false): Promise<FileInfo[]> {
  await ensureDir(TLDRAW_DIR);
  
  const results: FileInfo[] = [];
  
  async function scanDir(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      
      if (entry.isDirectory() && recursive) {
        await scanDir(fullPath);
      } else if (entry.isFile() && isReadableTldrawPath(entry.name)) {
        try {
          const parsed = await parseTldrawContent(fullPath);
          const file = parsed.file;
          
          const pages = file.records.filter(r => r.typeName === 'page');
          const shapes = file.records.filter(r => r.typeName === 'shape');
          
          results.push({
            name: entry.name.replace(/\.(tldr|md)$/i, ''),
            path: relative(TLDRAW_DIR, fullPath) || fullPath,
            pageCount: pages.length,
            shapeCount: shapes.length
          });
        } catch {
          // Skip invalid files
        }
      }
    }
  }
  
  await scanDir(TLDRAW_DIR);
  return results;
}

async function tldrawSearch(query: string, searchIn: 'text' | 'all' = 'all'): Promise<SearchMatch[]> {
  const files = await tldrawList(true);
  const results: SearchMatch[] = [];
  const searchLower = query.toLowerCase();
  
  for (const fileInfo of files) {
    try {
      const file = await tldrawRead(fileInfo.path);
      
      // Build page name map
      const pageNames = new Map<string, string>();
      for (const record of file.records) {
        if (record.typeName === 'page') {
          pageNames.set(record.id, (record.name as string) || 'Untitled');
        }
      }
      
      // Search shapes
      for (const record of file.records) {
        if (record.typeName === 'shape') {
          const props = record.props as Record<string, unknown> | undefined;
          let matchedText = '';
          
          // Search in text content
          if (props?.richText) {
            const text = extractText(props.richText);
            if (text.toLowerCase().includes(searchLower)) {
              matchedText = text;
            }
          }
          
          // Search in shape type and other props if searchIn is 'all'
          if (!matchedText && searchIn === 'all') {
            const shapeType = record.type as string;
            if (shapeType?.toLowerCase().includes(searchLower)) {
              matchedText = `Shape type: ${shapeType}`;
            }
            
            // Search in ID
            if (!matchedText && record.id.toLowerCase().includes(searchLower)) {
              matchedText = `Shape ID: ${record.id}`;
            }
          }
          
          if (matchedText) {
            const parentId = record.parentId as string;
            results.push({
              file: fileInfo.path,
              pageId: parentId?.startsWith('page:') ? parentId : undefined,
              pageName: parentId ? pageNames.get(parentId) : undefined,
              shapeId: record.id,
              shapeType: record.type as string,
              matchedText,
              context: matchedText.substring(0, 100)
            });
          }
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }
  
  return results;
}

async function tldrawGetShapes(path: string, pageId?: string): Promise<TldrawRecord[]> {
  const file = await tldrawRead(path);
  
  let shapes = file.records.filter(r => r.typeName === 'shape');
  
  if (pageId) {
    shapes = shapes.filter(r => r.parentId === pageId);
  }
  
  return shapes;
}

async function tldrawAddShape(
  path: string, 
  shape: Partial<TldrawRecord>,
  pageId?: string
): Promise<string> {
  const file = await tldrawRead(path);
  
  // Find target page
  let targetPageId = pageId;
  if (!targetPageId) {
    const firstPage = file.records.find(r => r.typeName === 'page');
    if (!firstPage) {
      throw new Error('No pages found in file');
    }
    targetPageId = firstPage.id;
  }
  
  // Generate shape ID
  const shapeId = shape.id || `shape:${crypto.randomUUID().slice(0, 8)}`;
  
  // Create shape record
  const newShape: TldrawRecord = {
    id: shapeId,
    typeName: 'shape',
    type: shape.type || 'geo',
    x: (shape.x as number) || 0,
    y: (shape.y as number) || 0,
    rotation: (shape.rotation as number) || 0,
    isLocked: false,
    opacity: 1,
    parentId: targetPageId,
    index: `a${file.records.filter(r => r.typeName === 'shape').length + 1}`,
    meta: {},
    props: shape.props || {
      w: 100,
      h: 100,
      geo: 'rectangle',
      color: 'black',
      labelColor: 'black',
      fill: 'none',
      dash: 'draw',
      size: 'm',
      font: 'draw',
      align: 'middle',
      verticalAlign: 'middle',
      growY: 0,
      url: '',
      scale: 1,
      richText: { type: 'doc', content: [] }
    }
  };
  
  file.records.push(newShape);
  
  await tldrawWrite(path, file);
  
  return shapeId;
}

async function tldrawUpdateShape(
  path: string,
  shapeId: string,
  updates: Record<string, unknown>
): Promise<string> {
  const file = await tldrawRead(path);
  
  const shapeIndex = file.records.findIndex(r => r.id === shapeId);
  if (shapeIndex === -1) {
    throw new Error(`Shape not found: ${shapeId}`);
  }
  
  // Deep merge updates
  const shape = file.records[shapeIndex];
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'props' && typeof value === 'object' && shape.props) {
      shape.props = { ...(shape.props as object), ...value };
    } else {
      (shape as Record<string, unknown>)[key] = value;
    }
  }
  
  await tldrawWrite(path, file);
  
  return `Updated shape: ${shapeId}`;
}

async function tldrawDeleteShape(path: string, shapeId: string): Promise<string> {
  const file = await tldrawRead(path);
  
  const initialLength = file.records.length;
  file.records = file.records.filter(r => r.id !== shapeId);
  
  if (file.records.length === initialLength) {
    throw new Error(`Shape not found: ${shapeId}`);
  }
  
  await tldrawWrite(path, file);
  
  return `Deleted shape: ${shapeId}`;
}

async function tldrawCreateFile(path: string, name?: string): Promise<string> {
  const filepath = securePath(path);
  
  if (existsSync(filepath)) {
    throw new Error(`File already exists: ${path}`);
  }
  
  const file = createEmptyTldrawFile(name || path.replace('.tldr', ''));
  await tldrawWrite(path, file);
  
  return `Created new tldraw file: ${path}`;
}

// Input validation schemas
const ReadSchema = z.object({
  path: z.string().describe("Path to .tldr file or markdown file with embedded tldraw data")
});

const WriteSchema = z.object({
  path: z.string().describe("Path to .tldr file or markdown file with embedded tldraw data"),
  content: z.union([z.string(), z.object({}).passthrough()]).describe("File content (JSON string or object)")
});

const ListSchema = z.object({
  recursive: z.boolean().optional().describe("Recursively list files in subdirectories")
});

const SearchSchema = z.object({
  query: z.string().describe("Search query"),
  searchIn: z.enum(['text', 'all']).optional().describe("Where to search: 'text' (shape text only) or 'all' (includes IDs, types)")
});

const GetShapesSchema = z.object({
  path: z.string().describe("Path to .tldr file or markdown file with embedded tldraw data"),
  pageId: z.string().optional().describe("Filter by page ID")
});

const AddShapeSchema = z.object({
  path: z.string().describe("Path to .tldr file or markdown file with embedded tldraw data"),
  pageId: z.string().optional().describe("Target page ID"),
  shape: z.object({
    type: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    props: z.object({}).passthrough().optional()
  }).describe("Shape definition")
});

const UpdateShapeSchema = z.object({
  path: z.string().describe("Path to .tldr file or markdown file with embedded tldraw data"),
  shapeId: z.string().describe("Shape ID to update"),
  updates: z.object({}).passthrough().describe("Properties to update")
});

const DeleteShapeSchema = z.object({
  path: z.string().describe("Path to .tldr file or markdown file with embedded tldraw data"),
  shapeId: z.string().describe("Shape ID to delete")
});

const CreateFileSchema = z.object({
  path: z.string().describe("Path for new .tldr file"),
  name: z.string().optional().describe("Document name")
});

// Create server
const server = new Server(
  {
    name: "@talhaorak/tldraw-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "tldraw_read",
        description: `Read a tldraw canvas file (.tldr) or a markdown file with embedded tldraw data. Returns parsed JSON with pages and shapes. Base directory: ${TLDRAW_DIR}`,
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to .tldr file or markdown file with embedded tldraw data (relative to TLDRAW_DIR or absolute)" }
          },
          required: ["path"]
        }
      },
      {
        name: "tldraw_write",
        description: "Write or update a tldraw canvas file (.tldr) or markdown-embedded tldraw block (.md). Validates format before saving.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to .tldr file or markdown file with embedded tldraw data" },
            content: { type: "object", description: "File content (tldraw format)" }
          },
          required: ["path", "content"]
        }
      },
      {
        name: "tldraw_create",
        description: "Create a new empty tldraw canvas file with default structure.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path for new .tldr file" },
            name: { type: "string", description: "Document name" }
          },
          required: ["path"]
        }
      },
      {
        name: "tldraw_list",
        description: `List supported tldraw files in ${TLDRAW_DIR} (.tldr and markdown with embedded tldraw). Returns file info with page/shape counts.`,
        inputSchema: {
          type: "object",
          properties: {
            recursive: { type: "boolean", description: "Include subdirectories" }
          }
        }
      },
      {
        name: "tldraw_search",
        description: "Search text content across all supported tldraw files (.tldr and markdown with embedded tldraw). Returns matching shapes with context.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            searchIn: { type: "string", enum: ["text", "all"], description: "Search scope" }
          },
          required: ["query"]
        }
      },
      {
        name: "tldraw_get_shapes",
        description: "Get all shapes from a tldraw file (.tldr or markdown with embedded tldraw), optionally filtered by page.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to .tldr file or markdown file with embedded tldraw data" },
            pageId: { type: "string", description: "Filter by page ID" }
          },
          required: ["path"]
        }
      },
      {
        name: "tldraw_add_shape",
        description: "Add a new shape to a tldraw file (.tldr or markdown with embedded tldraw). Returns the new shape ID.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to .tldr file or markdown file with embedded tldraw data" },
            pageId: { type: "string", description: "Target page ID" },
            shape: { 
              type: "object",
              description: "Shape definition with type, x, y, props",
              properties: {
                type: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
                props: { type: "object" }
              }
            }
          },
          required: ["path", "shape"]
        }
      },
      {
        name: "tldraw_update_shape",
        description: "Update properties of an existing shape in .tldr or markdown-embedded tldraw data.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to .tldr file or markdown file with embedded tldraw data" },
            shapeId: { type: "string", description: "Shape ID to update" },
            updates: { type: "object", description: "Properties to update" }
          },
          required: ["path", "shapeId", "updates"]
        }
      },
      {
        name: "tldraw_delete_shape",
        description: "Delete a shape from a tldraw file (.tldr or markdown with embedded tldraw data).",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Path to .tldr file or markdown file with embedded tldraw data" },
            shapeId: { type: "string", description: "Shape ID to delete" }
          },
          required: ["path", "shapeId"]
        }
      }
    ]
  };
});

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "tldraw_read": {
        const { path } = ReadSchema.parse(args);
        const content = await tldrawRead(path);
        return {
          content: [{ type: "text", text: JSON.stringify(content, null, 2) }]
        };
      }

      case "tldraw_write": {
        const { path, content } = WriteSchema.parse(args);
        const result = await tldrawWrite(path, content as unknown as TldrawFile | string);
        return {
          content: [{ type: "text", text: result }]
        };
      }

      case "tldraw_create": {
        const { path, name: docName } = CreateFileSchema.parse(args);
        const result = await tldrawCreateFile(path, docName);
        return {
          content: [{ type: "text", text: result }]
        };
      }

      case "tldraw_list": {
        const { recursive } = ListSchema.parse(args || {});
        const files = await tldrawList(recursive);
        if (files.length === 0) {
          return {
            content: [{ type: "text", text: `No supported tldraw files found in ${TLDRAW_DIR}` }]
          };
        }
        const formatted = files.map(f => 
          `- ${f.name} (${f.pageCount} pages, ${f.shapeCount} shapes) — ${f.path}`
        ).join('\n');
        return {
          content: [{ type: "text", text: `Found ${files.length} tldraw files:\n${formatted}` }]
        };
      }

      case "tldraw_search": {
        const { query, searchIn } = SearchSchema.parse(args);
        const results = await tldrawSearch(query, searchIn);
        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No matches found for: ${query}` }]
          };
        }
        const formatted = results.map(r =>
          `## ${r.file}${r.pageName ? ` / ${r.pageName}` : ''}\n` +
          `  Shape: ${r.shapeId} (${r.shapeType})\n` +
          `  Match: ${r.context}`
        ).join('\n\n');
        return {
          content: [{ type: "text", text: `Found ${results.length} matches:\n\n${formatted}` }]
        };
      }

      case "tldraw_get_shapes": {
        const { path, pageId } = GetShapesSchema.parse(args);
        const shapes = await tldrawGetShapes(path, pageId);
        return {
          content: [{ type: "text", text: JSON.stringify(shapes, null, 2) }]
        };
      }

      case "tldraw_add_shape": {
        const { path, pageId, shape } = AddShapeSchema.parse(args);
        const shapeId = await tldrawAddShape(path, shape, pageId);
        return {
          content: [{ type: "text", text: `Created shape: ${shapeId}` }]
        };
      }

      case "tldraw_update_shape": {
        const { path, shapeId, updates } = UpdateShapeSchema.parse(args);
        const result = await tldrawUpdateShape(path, shapeId, updates);
        return {
          content: [{ type: "text", text: result }]
        };
      }

      case "tldraw_delete_shape": {
        const { path, shapeId } = DeleteShapeSchema.parse(args);
        const result = await tldrawDeleteShape(path, shapeId);
        return {
          content: [{ type: "text", text: result }]
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true
    };
  }
});

// Start server
async function main() {
  await ensureDir(TLDRAW_DIR);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`tldraw-mcp server running on stdio (TLDRAW_DIR: ${TLDRAW_DIR})`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
