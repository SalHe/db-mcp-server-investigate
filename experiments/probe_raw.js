// Raw JSON-RPC stdio probe (no SDK-side result validation)
// Usage: CMD=... ARGS='[...]' ENV='{...}' node probe_raw.js
// Optional: TOOL=name TOOLARGS='{...}'
import { spawn } from "node:child_process";

const cmd = process.env.CMD;
const args = JSON.parse(process.env.ARGS || "[]");
const extraEnv = JSON.parse(process.env.ENV || "{}");
const label = process.env.LABEL || cmd;

const child = spawn(cmd, args, { env: { ...process.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
let stderr = "";
const pending = new Map();

child.stderr.on("data", (d) => (stderr += d.toString()));
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

let nextId = 1;
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }
    }, Number(process.env.CALL_TIMEOUT || 30000));
  });
const notify = (method, params) =>
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

const out = { label, stderr: "" };
try {
  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: process.env.CLIENT_NAME || "raw-probe", version: "1.0.0" },
  });
  out.init = init.result;
  notify("notifications/initialized", {});
  const list = await send("tools/list", {});
  out.tools = (list.result?.tools || []).map((t) => ({
    name: t.name,
    description: (t.description || "").replace(/\s+/g, " ").slice(0, 300),
    params: Object.keys(t.inputSchema?.properties || {}),
    required: t.inputSchema?.required || [],
  }));
  if (process.env.TOOL) {
    const toolArgs = JSON.parse(process.env.TOOLARGS || "{}");
    out.call = { tool: process.env.TOOL, args: toolArgs };
    try {
      out.call.response = await send("tools/call", { name: process.env.TOOL, arguments: toolArgs });
    } catch (e) {
      out.call.error = String(e);
    }
  }
} catch (e) {
  out.fatal = String(e);
}
out.stderr = stderr.slice(-3000);
console.log(JSON.stringify(out, null, 2));
child.kill("SIGTERM");
setTimeout(() => process.exit(0), 300);
