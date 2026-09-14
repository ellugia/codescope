import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs/promises";

const mode = process.env.OPTIONAL_STUB_MODE || "safe";
const project = process.env.OPTIONAL_STUB_PROJECT || "CodeScope-fixture";
const root = process.env.OPTIONAL_STUB_ROOT || process.cwd();
const pidFile = process.env.OPTIONAL_STUB_PID_FILE;

if (pidFile) await fs.writeFile(pidFile, String(process.pid), "utf8");

const server = new Server(
  { name: "codescope-optional-backend-stub", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  if (mode === "hang") await new Promise(() => {});
  const result = responseFor(name, args);
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
});

const transport = new StdioServerTransport();
await server.connect(transport);

function responseFor(name, args) {
  if (name === "list_projects") {
    return { projects: [{ name: project, root_path: root }], has_more: false };
  }
  if (name === "index_status") {
    return {
      project,
      root_path: root,
      status: "ready",
      nodes: 1,
      edges: 0,
      git: { branch: "main", head_sha: "a".repeat(40) },
    };
  }
  if (name === "check_index_coverage") {
    return {
      signal: "metadata_changed",
      metadata: { generation: "synthetic", generation_matches: false },
      paths: [{ path: "src/graph_fixture.py", status: "covered", freshness: "metadata_changed", recommended_action: "read_source" }],
    };
  }
  if (name === "search_graph") {
    if (mode === "secret-search") {
      return {
        cols: ["qn", "label", "file", "lines", "rank"],
        rows: [[`${project}.src.graph_fixture.secret`, "client_secret=synthetic-output-secret", "src/graph_fixture.py", "1-2", 1]],
        has_more: false,
      };
    }
    return {
      cols: ["qn", "label", "file", "lines", "rank"],
      rows: [
        [`${project}.src.graph_fixture.safe`, "safe", "src/graph_fixture.py", "1-2", 1],
        ["OtherProject.src.graph_fixture.foreign", "foreign-project", "src/graph_fixture.py", "3-4", 2],
        [`${project}.src.other.foreign`, "foreign-path", "src/other.py", "5-6", 3],
      ],
      has_more: false,
    };
  }
  if (name === "get_code_snippet") {
    if (mode === "foreign-snippet-path") {
      return { qualified_name: args.qualified_name, name: "foreign-path", file_path: `${root}/outside.py`, source: "safe source" };
    }
    if (mode === "foreign-snippet-project") {
      return { qualified_name: "OtherProject.src.graph_fixture.foreign", name: "foreign-project", file_path: `${root}/src/graph_fixture.py`, source: "safe source" };
    }
    return { qualified_name: args.qualified_name, name: "safe", file_path: `${root}/src/graph_fixture.py`, source: "safe source" };
  }
  if (name === "trace_path") return { direction: "both", mode: "calls", callees: { groups: [] }, callers: { groups: [] } };
  throw new Error(`unexpected tool ${name}`);
}
