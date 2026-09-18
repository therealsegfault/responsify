import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";

const pad = (n) => String(n).padStart(2, "0");

export function archivePreviousRun() {
  try {
    // Check if tables exist before querying
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='stats'").get();
    if (!tableCheck) return null;

    const stats = db.prepare("SELECT * FROM stats WHERE id = 1").get();
    const pages = db.prepare("SELECT * FROM swap_pages ORDER BY created_at ASC").all();

    // Skip creating empty files if the previous run had zero activity
    if ((!stats || (stats.requests_processed === 0 && stats.tokens_intercepted === 0)) && pages.length === 0) {
      return null;
    }

    const now = new Date();
    const mm = pad(now.getMonth() + 1);
    const dd = pad(now.getDate());
    const yyyy = now.getFullYear();
    const logFileName = `rfy-${mm}-${dd}-${yyyy}.log`;
    const logFilePath = path.resolve(process.cwd(), logFileName);

    const timestamp = `${yyyy}-${mm}-${dd} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    let logText = "";
    logText += "================================================================================\n";
    logText += `RESPONSIFY SESSION ARCHIVE - ${timestamp}\n`;
    logText += "================================================================================\n";
    logText += `Requests Processed : ${stats?.requests_processed?.toLocaleString() || 0}\n`;
    logText += `Tokens Intercepted : ${stats?.tokens_intercepted?.toLocaleString() || 0}\n`;
    logText += `Tokens Evicted     : ${stats?.tokens_evicted?.toLocaleString() || 0}\n`;
    logText += `Pages Swapped      : ${pages.length}\n`;
    logText += "--------------------------------------------------------------------------------\n\n";

    if (pages.length > 0) {
      logText += "SWAP PAGE MANIFEST:\n";
      for (const p of pages) {
        logText += `[${p.created_at}] REF: ${p.ref_id} | TYPE: ${p.type} | SIZE: ${p.size.toLocaleString()} chars\n`;
        const lines = (p.content || "").trim().split("\n");
        const snippet = lines.slice(0, 5).join("\n");
        logText += `    Preview:\n    | ${snippet.replace(/\n/g, "\n    | ")}\n`;
        if (lines.length > 5) {
          logText += `    | ... (${lines.length - 5} more lines)\n`;
        }
        logText += "\n";
      }
    } else {
      logText += "No pages were evicted during this session.\n\n";
    }

    logText += "================================================================================\n\n";

    fs.appendFileSync(logFilePath, logText, "utf8");

    // Reset database state for the next run
    db.exec("DELETE FROM swap_pages;");
    db.prepare("UPDATE stats SET tokens_intercepted = 0, tokens_evicted = 0, requests_processed = 0 WHERE id = 1").run();
    db.exec("VACUUM;");

    return logFileName;
  } catch (err) {
    console.error("[Responsify] Warning: Failed to archive previous run:", err.message);
    return null;
  }
}
