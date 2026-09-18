import { exec } from "node:child_process";
import { archivePreviousRun } from "./logger.js";

// Binaries or CLI patterns to monitor
const TARGET_AGENTS = ["hermes", "claude", "codex", "mistral"];
const POLL_INTERVAL_MS = 2000;

let isAgentRunning = false;
let activeAgentName = null;

function checkProcesses() {
  // macOS and Linux compatible process check
  exec("ps -eo pid,comm,args", (err, stdout) => {
    if (err || !stdout) return;

    const lines = stdout.split("\n");
    let detectedAgent = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const [pidStr, ...rest] = trimmed.split(/\s+/);
      const pid = parseInt(pidStr, 10);
      const cmd = rest.join(" ");

      // Ignore current Responsify process
      if (pid === process.pid) continue;

      for (const agent of TARGET_AGENTS) {
        // Match binary name at boundary or end of path (e.g., /bin/hermes or `node .../hermes`)
        const pattern = new RegExp(`(?:^|[\\/\\s])${agent}(?:\\.js)?(?:\\s|$)`, "i");
        if (pattern.test(cmd)) {
          detectedAgent = agent;
          break;
        }
      }

      if (detectedAgent) break;
    }

    // 1. Agent Started (Rising Edge)
    if (detectedAgent && !isAgentRunning) {
      isAgentRunning = true;
      activeAgentName = detectedAgent;
      console.log(`[Responsify] Detected agent launch: ${activeAgentName}`);
    }

    // 2. Agent Shutdown (Falling Edge)
    if (!detectedAgent && isAgentRunning) {
      console.log(`[Responsify] Agent '${activeAgentName}' exited. Archiving session and clearing DB...`);
      archivePreviousRun();
      isAgentRunning = false;
      activeAgentName = null;
    }
  });
}

export function startProcessWatcher() {
  // Initial check
  checkProcesses();
  // Persistent interval
  return setInterval(checkProcesses, POLL_INTERVAL_MS);
}
