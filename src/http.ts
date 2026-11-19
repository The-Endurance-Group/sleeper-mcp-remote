import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { SleeperMCPServer } from "./index.js";

// Remote (Streamable HTTP) entrypoint so Claude web can use this as a custom connector.
// The URL path contains a secret token (MCP_PATH_TOKEN): connect at /mcp/<token>.
const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.MCP_PATH_TOKEN;
if (!TOKEN) {
  console.error("MCP_PATH_TOKEN is required");
  process.exit(1);
}
const MCP_PATH = `/mcp/${TOKEN}`;

const sessions = new Map<string, StreamableHTTPServerTransport>();

async function readBody(req: import("node:http").IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

createServer(async (req, res) => {
  const url = (req.url || "").split("?")[0];
  if (url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (url !== MCP_PATH) {
    res.writeHead(404).end();
    return;
  }
  try {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let body: any;
    if (req.method === "POST") body = await readBody(req);

    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (req.method === "POST" && !sid && isInitializeRequest(body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport!);
          },
        });
        transport.onclose = () => {
          if (transport!.sessionId) sessions.delete(transport!.sessionId);
        };
        await new SleeperMCPServer().connect(transport);
      } else {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session" },
            id: null,
          }),
        );
        return;
      }
    }
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500).end();
  }
}).listen(PORT, () => console.error(`Sleeper MCP (HTTP) listening on :${PORT}`));
