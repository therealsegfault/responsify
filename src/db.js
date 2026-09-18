import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

const storageDir = process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Application Support", "responsify")
  : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "responsify");

fs.mkdirSync(storageDir, { recursive: true });

export const db = new Database(path.join(storageDir, "swap.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS swap_pages (
    ref_id TEXT PRIMARY KEY,
    type TEXT,
    size INTEGER,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    tokens_intercepted INTEGER DEFAULT 0,
    tokens_evicted INTEGER DEFAULT 0,
    requests_processed INTEGER DEFAULT 0
  );

  INSERT OR IGNORE INTO stats (id, tokens_intercepted, tokens_evicted, requests_processed)
  VALUES (1, 0, 0, 0);
`);

export function updateStats(intercepted, evicted) {
  db.prepare(`
    UPDATE stats 
    SET tokens_intercepted = tokens_intercepted + ?,
        tokens_evicted = tokens_evicted + ?,
        requests_processed = requests_processed + 1
    WHERE id = 1
  `).run(intercepted, evicted);
}
