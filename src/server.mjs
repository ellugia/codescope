import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { createBridge, getToolDefinitions, loadConfig, toSafeError } from "./bridge.mjs";

const bridge = createBridge(await loadConfig());
await bridge.prepare();

const server = new Server(
  { name: "codescope", version: "0.1.0" },
  { capabilities: { tools: { listChanged: false } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolDefinitions(bridge.config) }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await bridge.call(request.params.name, request.params.arguments || {}, { meta: request.params?._meta || {} });
    return boundedResult(request.id, { content: [{ type: "text", text: visibleText(result) }], structuredContent: result });
  } catch (error) {
    const safe = toSafeError(error);
    if (safe.code === "tool_denied") throw new McpError(ErrorCode.InvalidParams, safe.message);
    const details = { error: safe.code, details: safe.details };
    return boundedResult(request.id, { isError: true, content: [{ type: "text", text: visibleText(details) }], structuredContent: details });
  }
});

function visibleText(value) {
  const notice = value?.security_notice || value?.details?.security_notice;
  const json = JSON.stringify(value);
  return typeof notice === "string" && notice ? `${notice}\n${json}` : json;
}

function boundedResult(id, result) {
  const maxBytes = bridge.config.limits.maxResponseBytes;
  const frameBytes = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id, result }), "utf8");
  if (frameBytes <= maxBytes) return result;
  const notice = result?.structuredContent?.security_notice;
  const details = { max_response_bytes: maxBytes, ...(typeof notice === "string" ? { security_notice: notice } : {}) };
  const text = typeof notice === "string" ? `${notice}\n${JSON.stringify({ error: "output_limit", details })}` : JSON.stringify({ error: "output_limit", details });
  const error = { isError: true, content: [{ type: "text", text }], structuredContent: { error: "output_limit", details } };
  return error;
}

const transport = new StdioServerTransport();
await server.connect(transport);

const close = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
