// MCP stdio probe: initialize -> tools/list -> optionally tools/call
// Usage:
//   CMD=npx ARGS='["-y","pkg"]' ENV='{"K":"V"}' node probe.js
//   CMD=... TOOL=query TOOLARGS='{"sql":"select 1"}' node probe.js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cmd = process.env.CMD;
const args = JSON.parse(process.env.ARGS || "[]");
const extraEnv = JSON.parse(process.env.ENV || "{}");
const label = process.env.LABEL || cmd;

const transport = new StdioClientTransport({
  command: cmd,
  args,
  env: { ...process.env, ...extraEnv },
  stderr: "pipe",
});

let stderr = "";
transport.stderr?.on("data", (d) => { stderr += d.toString(); });

const client = new Client({ name: "probe", version: "1.0.0" }, { capabilities: {} });

const timeout = (ms, p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout " + ms)), ms))]);

try {
  await timeout(30000, client.connect(transport));
  const list = await timeout(15000, client.listTools());
  const out = {
    label,
    serverInfo: client.getServerVersion(),
    instructions: client.getInstructions() || null,
    tools: list.tools.map((t) => ({
      name: t.name,
      description: (t.description || "").replace(/\s+/g, " ").slice(0, 500),
      params: Object.keys(t.inputSchema?.properties || {}),
      required: t.inputSchema?.required || [],
      annotations: t.annotations || null,
    })),
  };
  if (process.env.TOOL) {
    const toolArgs = JSON.parse(process.env.TOOLARGS || "{}");
    try {
      const res = await timeout(Number(process.env.CALL_TIMEOUT || 30000), client.callTool({ name: process.env.TOOL, arguments: toolArgs }));
      out.call = { tool: process.env.TOOL, args: toolArgs, result: res };
    } catch (e) {
      out.call = { tool: process.env.TOOL, args: toolArgs, error: String(e) };
    }
  }
  console.log(JSON.stringify(out, null, 2));
  await client.close();
  process.exit(0);
} catch (e) {
  console.log(JSON.stringify({ label, fatal: String(e), stderr: stderr.slice(-4000) }, null, 2));
  try { await client.close(); } catch {}
  process.exit(1);
}
