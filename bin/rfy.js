#!/usr/bin/env node

import { startServer } from "../src/server.js";

const PORT = 7777;

// Ignore tray architecture mismatch on Apple Silicon
process.on("uncaughtException", (err) => {
  if (err.syscall === "spawn" || err.code === "Unknown system error -86") {
    return;
  }
  console.error("[Responsify] Uncaught exception:", err);
  process.exit(1);
});

startServer(PORT);

console.log("Welcome To Responsify v1.0.0 📢");
console.log("Activating… [OK]");
console.log("You may now use your terminal agent as you normally would, and Responsify will save you tokens in the background! 🪙");

try {
  const { initTray } = await import("../src/tray.js");
  initTray(PORT);
} catch {}
