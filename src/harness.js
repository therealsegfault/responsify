import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "crypto";
import { db, updateStats } from "./db.js";

const HERMES_DIR = path.join(os.homedir(), ".hermes");
const BULK_TOOLS = new Set([
  "read_file",
  "write_file",
  "patch",
  "terminal",
  "code_execution",
  "execute_code",
  "browser_cdp",
  "fetch_web_page",
  "skill_view"
]);

function saveSwap(type, content, meta = "") {
  const refId = `ref_${type.slice(0, 4)}_${crypto.randomBytes(3).toString("hex")}`;
  db.prepare("INSERT OR REPLACE INTO swap_pages (ref_id, type, size, content) VALUES (?, ?, ?, ?)")
    .run(refId, `${type}${meta ? ":" + meta : ""}`, content.length, content);
  return refId;
}

// 1. System Prompt: Dissect Hermes Skills
function pruneSkills(systemMsg) {
  if (typeof systemMsg.content !== "string") return 0;
  let evicted = 0;

  const skillTagRegex = /<skill\s+name=["']([^"']+)["']>([\s\S]*?)<\/skill>/gi;
  systemMsg.content = systemMsg.content.replace(skillTagRegex, (fullMatch, skillName, skillBody) => {
    if (skillBody.length < 800) return fullMatch;

    const refId = saveSwap("skill", skillBody, skillName);
    evicted += skillBody.length - 120;
    return `<skill name="${skillName}">\n[API & Docs Swapped to NVMe: ${refId} (${skillBody.length} chars)]\n</skill>`;
  });

  return evicted;
}

// 2. Semantic History Pruner
export function pruneHarnessPayload(messages) {
  let initialChars = 0;
  let evictedChars = 0;

  // Build tool call lookup map
  const toolCallGraph = new Map();
  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.function) {
          toolCallGraph.set(tc.id, tc.function);
        }
      }
    }
  }

  // Find index of the most recent assistant message
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIdx = i;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // A. System Prompt Skills
    if (msg.role === "system") {
      initialChars += msg.content?.length || 0;
      evictedChars += pruneSkills(msg);
      continue;
    }

    // B. Historical Assistant Turns
    if (msg.role === "assistant") {
      const isLatestAssistant = i === lastAssistantIdx;

      if (typeof msg.content === "string") {
        initialChars += msg.content.length;
        // Strip reasoning traces only from older turns
        if (!isLatestAssistant && /<think>[\s\S]*?<\/think>/i.test(msg.content)) {
          msg.content = msg.content.replace(/<think>[\s\S]*?<\/think>/gi, (match) => {
            evictedChars += match.length;
            return "";
          });
        }
      }

      // Evict large code bodies sent inside write_file/patch tool calls
      if (!isLatestAssistant && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.name === "write_file" || tc.function?.name === "patch") {
            try {
              const args = JSON.parse(tc.function.arguments);
              const key = args.content ? "content" : (args.patch ? "patch" : null);
              if (key && args[key].length > 800) {
                const refId = saveSwap("tool_args", args[key], tc.function.name);
                evictedChars += args[key].length;
                args[key] = `[Body Swapped to NVMe: ${refId}]`;
                tc.function.arguments = JSON.stringify(args);
              }
            } catch {}
          }
        }
      }
      continue;
    }

    // C. Tool Outputs: Never evict results the model hasn't read yet
    if (msg.role === "tool" && typeof msg.content === "string") {
      initialChars += msg.content.length;

      // Brand-new data waiting for the active model turn must stay intact
      const isPendingResult = i > lastAssistantIdx;
      if (isPendingResult) {
        continue;
      }

      const caller = toolCallGraph.get(msg.tool_call_id);
      const toolName = caller?.name || "unknown";

      if ((BULK_TOOLS.has(toolName) && msg.content.length > 800) || msg.content.length > 3000) {
        const refId = saveSwap("tool_out", msg.content, toolName);
        evictedChars += msg.content.length - 200;

        const lines = msg.content.split("\n");
        const preview = lines.length > 6
          ? `${lines.slice(0, 3).join("\n")}\n\n... [Previous tool output (${lines.length} lines) swapped to ${refId}] ...\n\n${lines.slice(-2).join("\n")}`
          : msg.content.slice(0, 200) + `\n... [Swapped: ${refId}]`;

        msg.content = preview;
      }
    }
  }

  updateStats(Math.round(initialChars / 4), Math.round(evictedChars / 4));
  return messages;
}

// 3. Harness Disk Sync: ~/.hermes/sessions
export function syncHermesDisk() {
  const sessionsDir = path.join(HERMES_DIR, "sessions");
  if (!fs.existsSync(sessionsDir)) return;

  try {
    const files = fs.readdirSync(sessionsDir)
      .filter(f => f.endsWith(".json"))
      .map(f => ({ name: f, time: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    if (files.length === 0) return;

    const activeSessionPath = path.join(sessionsDir, files[0].name);
    const sessionAgeMs = Date.now() - files[0].time;

    // Only patch sessions active within the last 15 minutes
    if (sessionAgeMs > 15 * 60 * 1000) return;

    const sessionRaw = fs.readFileSync(activeSessionPath, "utf8");
    const sessionData = JSON.parse(sessionRaw);

    if (Array.isArray(sessionData.messages)) {
      sessionData.messages = pruneHarnessPayload(sessionData.messages);
      fs.writeFileSync(activeSessionPath, JSON.stringify(sessionData, null, 2), "utf8");
    }
  } catch {}
}
