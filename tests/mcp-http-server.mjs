// Remote MCP test server (Streamable HTTP) exposing a read tool and a write tool.
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
const port = Number(process.env.MCP_PORT || 18200);
function build() {
  const s = new McpServer({ name: "kt-kb", version: "1.0.0" });
  s.tool("search_kb", "Search the approved KT knowledge base.", { query: z.string() }, async ({ query }) => ({ content: [{ type: "text", text: `Runbook ${query}: restart from checkpoint STEP020; never rerun from the top.` }] }));
  s.tool("create_ticket", "Create a Jira ticket.", { title: z.string() }, async ({ title }) => ({ content: [{ type: "text", text: "Created KT-1: " + title }] }));
  return s;
}
http.createServer(async (req, res) => {
  if (req.headers.authorization !== "Bearer mcp-test-token") { res.writeHead(401).end("unauthorized"); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
  const server = build(); const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport); await transport.handleRequest(req, res, body);
}).listen(port, () => console.log("mcp on", port));
