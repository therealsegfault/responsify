// src/tray.js
import SysTray from "systray2";
import open from "open";

const ICON_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAClJREFUOE9jZKAQMFKon2HUAAYGxv9kYnLNGA2DRg4YDR4GNMwAo3EAAHgkCQv831WFAAAAAElFTkSuQmCC";

export function initTray(port) {
  const systray = new SysTray.default({
    menu: {
      icon: ICON_BASE64,
      title: "Rfy",
      tooltip: "Responsify Swap Manager",
      items: [
        { title: "Open Dashboard", tooltip: "Open Web UI", checked: false, enabled: true },
        { title: "Quit Responsify", tooltip: "Stop server", checked: false, enabled: true },
      ],
    },
    debug: false,
  });

  // Catch child process errors without terminating Node
  systray.onError((err) => {
    console.error(`[Responsify] Tray error (proxy remains running): ${err.message}`);
  });

  systray.onClick((action) => {
    if (action.item.title === "Open Dashboard") {
      open(`http://localhost:${port}/dash`);
    } else if (action.item.title === "Quit Responsify") {
      systray.kill();
      process.exit(0);
    }
  });

  return systray;
}
