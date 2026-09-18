import express from "express";
import { db } from "./db.js";
import { pruneHarnessPayload, syncHermesDisk } from "./harness.js";

const app = express();
app.use(express.json({ limit: "100mb" }));

const UPSTREAM = "http://localhost:20128";
const MAX_THINKING_TOKENS = 600;

// 1. Completions Proxy Gateway
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const payload = req.body;

    if (Array.isArray(payload.messages)) {
      payload.messages = pruneHarnessPayload(payload.messages);
    }

    const headers = { "Content-Type": "application/json" };
    if (req.headers.authorization) {
      headers["Authorization"] = req.headers.authorization;
    }

    const upstreamRes = await fetch(`${UPSTREAM}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!upstreamRes.body) {
      return res.status(upstreamRes.status).send("Upstream error");
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // SSE Stream Circuit Breaker
    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    let thinkingTokens = 0;
    let insideThinking = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      let chunk = decoder.decode(value, { stream: true });

      if (chunk.includes("<think>")) insideThinking = true;
      if (chunk.includes("</think>")) insideThinking = false;

      if (insideThinking) {
        thinkingTokens += 1;
        if (thinkingTokens > MAX_THINKING_TOKENS) {
          chunk = chunk + "\n</think>\n";
          insideThinking = false;
        }
      }

      res.write(chunk);
    }
    res.end();

    // Sync pruned state to Hermes on disk
    setImmediate(syncHermesDisk);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upstream models pass-through
app.get("/v1/models", async (req, res) => {
  try {
    const r = await fetch(`${UPSTREAM}/v1/models`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2. Management API Endpoints
app.get("/api/state", (req, res) => {
  const stats = db.prepare("SELECT * FROM stats WHERE id = 1").get();
  const pages = db.prepare("SELECT ref_id, type, size, created_at FROM swap_pages ORDER BY created_at DESC LIMIT 100").all();
  res.json({ stats, pages, endpoint: UPSTREAM });
});

app.get("/api/page/:ref_id", (req, res) => {
  const row = db.prepare("SELECT * FROM swap_pages WHERE ref_id = ?").get(req.params.ref_id);
  if (!row) return res.status(404).json({ error: "Page not found" });
  res.json(row);
});

app.post("/api/purge", (req, res) => {
  db.exec("DELETE FROM swap_pages;");
  res.json({ ok: true });
});

// 3. Interactive Web Console (/dash)
app.get("/dash", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Responsify Console</title>
  <style>
    :root { --bg: #0d1117; --panel: #161b22; --border: #30363d; --text: #c9d1d9; --accent: #58a6ff; --green: #3fb950; --red: #f85149; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", monospace; background: var(--bg); color: var(--text); padding: 24px; margin: 0; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .val { font-size: 28px; font-weight: bold; color: var(--accent); margin-top: 6px; }
    .controls { display: flex; gap: 12px; margin-bottom: 16px; align-items: center; }
    input[type="text"] { background: var(--panel); border: 1px solid var(--border); color: var(--text); padding: 8px 12px; border-radius: 6px; flex: 1; outline: none; }
    button { background: var(--panel); border: 1px solid var(--border); color: var(--text); padding: 8px 14px; border-radius: 6px; cursor: pointer; font-weight: 500; }
    button:hover { border-color: var(--accent); color: var(--accent); }
    .btn-danger:hover { border-color: var(--red); color: var(--red); }
    .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--green); margin-right: 6px; box-shadow: 0 0 8px var(--green); }
    table { width: 100%; border-collapse: collapse; background: var(--panel); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
    th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #21262d; font-size: 13px; }
    th { background: #21262d; color: #8b949e; }
    tr:hover td { background: #1c2128; cursor: pointer; }
    .tag { background: #1f6feb22; color: var(--accent); padding: 2px 6px; border-radius: 4px; font-size: 11px; }
    #modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); backdrop-filter: blur(4px); justify-content: center; align-items: center; }
    #modal-box { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; width: 75%; max-height: 80vh; display: flex; flex-direction: column; overflow: hidden; }
    #modal-header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; }
    #modal-body { padding: 16px; overflow-y: auto; font-family: monospace; font-size: 12px; white-space: pre-wrap; background: #0b0e14; color: #7ee787; }
  </style>
</head>
<body>
  <div class="header">
    <h2>Responsify Live Console</h2>
    <div style="font-size: 13px;"><span class="pulse"></span>Proxy Active (:7777 &rarr; :20128)</div>
  </div>

  <div class="grid">
    <div class="card"><div>Intercepted Tokens</div><div class="val" id="st-intercepted">0</div></div>
    <div class="card"><div>Tokens Evicted to NVMe</div><div class="val" id="st-evicted" style="color:var(--green)">0</div></div>
    <div class="card"><div>Requests Processed</div><div class="val" id="st-reqs">0</div></div>
  </div>

  <div class="controls">
    <input type="text" id="search" placeholder="Filter pages by ref_id or type..." oninput="renderTable()">
    <button onclick="fetchState()">Refresh</button>
    <button class="btn-danger" onclick="purgeSwap()">Purge Swap</button>
  </div>

  <table>
    <thead><tr><th>Ref ID</th><th>Type</th><th>Size</th><th>Created</th><th>Action</th></tr></thead>
    <tbody id="page-rows"></tbody>
  </table>

  <div id="modal" onclick="closeModal(event)">
    <div id="modal-box" onclick="event.stopPropagation()">
      <div id="modal-header">
        <strong id="modal-title">Inspector</strong>
        <div>
          <button onclick="copyModalContent()">Copy Content</button>
          <button onclick="closeModal()">Close</button>
        </div>
      </div>
      <pre id="modal-body"></pre>
    </div>
  </div>

  <script>
    let pagesData = [];

    async function fetchState() {
      const res = await fetch('/api/state');
      const data = await res.json();
      document.getElementById('st-intercepted').innerText = data.stats.tokens_intercepted.toLocaleString();
      document.getElementById('st-evicted').innerText = data.stats.tokens_evicted.toLocaleString();
      document.getElementById('st-reqs').innerText = data.stats.requests_processed.toLocaleString();
      pagesData = data.pages;
      renderTable();
    }

    function renderTable() {
      const q = document.getElementById('search').value.toLowerCase();
      const filtered = pagesData.filter(p => p.ref_id.toLowerCase().includes(q) || (p.type || '').toLowerCase().includes(q));
      const tbody = document.getElementById('page-rows');
      tbody.innerHTML = filtered.map(p => \`
        <tr onclick="inspectPage('\${p.ref_id}')">
          <td><code>\${p.ref_id}</code></td>
          <td><span class="tag">\${p.type || 'raw'}</span></td>
          <td>\${p.size.toLocaleString()} chars</td>
          <td>\${p.created_at}</td>
          <td><button onclick="event.stopPropagation(); inspectPage('\${p.ref_id}')">Inspect</button></td>
        </tr>
      \`).join('') || '<tr><td colspan="5" style="text-align:center;color:#8b949e;">No active swap pages found.</td></tr>';
    }

    async function inspectPage(ref_id) {
      const res = await fetch(\`/api/page/\${ref_id}\`);
      const data = await res.json();
      document.getElementById('modal-title').innerText = \`[\${data.ref_id}] (\${data.size} chars)\`;
      document.getElementById('modal-body').innerText = data.content;
      document.getElementById('modal').style.display = 'flex';
    }

    function closeModal() { document.getElementById('modal').style.display = 'none'; }

    function copyModalContent() {
      navigator.clipboard.writeText(document.getElementById('modal-body').innerText);
      alert('Copied to clipboard!');
    }

    async function purgeSwap() {
      if (!confirm('Flush all disk swap pages?')) return;
      await fetch('/api/purge', { method: 'POST' });
      fetchState();
    }

    fetchState();
    setInterval(fetchState, 2000);
  </script>
</body>
</html>`);
});

// 4. Server Entry Point
export function startServer(port = 7777) {
  return app.listen(port);
}
