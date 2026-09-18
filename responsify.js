import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Database from "better-sqlite3";
import { z } from "zod";
import path from "path";
import os from "os";
import fs from "fs";

// 1. Storage setup (macOS / Linux support)
const storageDir = process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Application Support", "responsify")
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "responsify");

fs.mkdirSync(storageDir, { recursive: true });
const db = new Database(path.join(storageDir, "swap.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS swap_pages (
    ref_id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 2. Define the MCP Server and Tools
const server = new McpServer({
  name: "Responsify",
  version: "1.0.0",
});

server.tool(
  "stash_context",
  "Evict raw code or verbose thinking out of the active context and save it to disk.",
  {
    ref_id: z.string().describe("Unique pointer key, e.g. 'gtk_patch_v1'"),
    content: z.string().describe("Verbatim code, diff, or context to store"),
  },
  async ({ ref_id, content }) => {
    const stmt = db.prepare("INSERT OR REPLACE INTO swap_pages (ref_id, content) VALUES (?, ?)");
    stmt.run(ref_id, content);
    return {
      content: [{ type: "text", text: `Stored ${content.length} characters under [REF_ID: ${ref_id}]. Safe to drop from active context.` }],
    };
  }
);

server.tool(
  "page_in",
  "Fetch verbatim content back into transient memory for immediate inspection.",
  {
    ref_id: z.string().describe("Pointer key to retrieve"),
  },
  async ({ ref_id }) => {
    const row = db.prepare("SELECT content FROM swap_pages WHERE ref_id = ?").get(ref_id);
    if (!row) {
      return {
        content: [{ type: "text", text: `Error: [REF_ID: ${ref_id}] not found in swap storage.` }],
      };
    }
    return {
      content: [{ type: "text", text: `<paged_memory ref="${ref_id}">\n${row.content}\n</paged_memory>` }],
    };
  }
);

// 3. Connect via Standard Input/Output
const transport = new StdioServerTransport();
await server.connect(transport);
