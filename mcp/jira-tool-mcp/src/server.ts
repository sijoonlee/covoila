import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JiraClient } from "./jiraClient.js";
import { createJiraMcpServer } from "./jiraTools.js";

export type TransportName = "stdio" | "http";

export async function serveStdio(jira: JiraClient): Promise<void> {
  const server = createJiraMcpServer(jira);
  await server.connect(new StdioServerTransport());
}

export async function serveHttp(jira: JiraClient, port: number): Promise<void> {
  const httpServer = createServer(async (req, res) => {
    try {
      await handleHttpRequest(jira, req, res);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
      }
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
        id: null,
      }));
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, "127.0.0.1", resolve);
  });

  process.stderr.write(`jira-tool-mcp listening on http://127.0.0.1:${port}/mcp\n`);
}

async function handleHttpRequest(jira: JiraClient, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "jira-tool-mcp" }));
    return;
  }

  if (url.pathname !== "/mcp") {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }));
    return;
  }

  const body = await readJsonBody(req);
  const mcpServer = createJiraMcpServer(jira);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => {
    void transport.close();
    void mcpServer.close();
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  return JSON.parse(text);
}
