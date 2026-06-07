import { readFileSync } from "node:fs";
import { getConfig } from "./config.js";
import { ConfluenceClient } from "./confluenceClient.js";
import { serveHttp, serveStdio, type TransportName } from "./server.js";

export async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const config = getConfig();
  const confluence = new ConfluenceClient({ config });

  if (command === "serve") {
    await runServe(confluence, rest, config.defaultPort);
    return;
  }

  if (command === "page") {
    await runPageCommand(confluence, rest);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function runServe(confluence: ConfluenceClient, args: string[], defaultPort: number): Promise<void> {
  const flags = parseFlags(args);
  const transport = (flags.transport ?? "stdio") as TransportName;

  if (transport === "stdio") {
    await serveStdio(confluence);
    return;
  }

  if (transport === "http") {
    await serveHttp(confluence, flags.port ? positiveInt(flags.port, "port") : defaultPort);
    return;
  }

  throw new Error("--transport must be stdio or http");
}

async function runPageCommand(confluence: ConfluenceClient, args: string[]): Promise<void> {
  const [action, pageId, ...rest] = args;
  const flags = parseFlags(action === "create" || action === "search" ? args.slice(1) : rest);

  switch (action) {
    case "create": {
      const spaceId = requireFlag(flags, "space-id");
      const title = requireFlag(flags, "title");
      const body = requireBody(flags);
      printJson(await confluence.createPage({
        spaceId,
        title,
        body,
        format: parseFormat(flags.format),
        parentId: flags["parent-id"],
        status: flags.status,
        subtype: flags.subtype,
      }));
      return;
    }

    case "get": {
      requireArg(pageId, "page ID");
      printJson(await confluence.getPage(pageId, parseReadFormat(flags["body-format"])));
      return;
    }

    case "search": {
      printJson(await confluence.searchPages({
        spaceId: flags["space-id"],
        title: flags.title,
        status: flags.status,
        bodyFormat: flags["body-format"] ? parseReadFormat(flags["body-format"]) : undefined,
        limit: flags.limit ? positiveInt(flags.limit, "limit") : undefined,
      }));
      return;
    }

    case "update": {
      requireArg(pageId, "page ID");
      const title = requireFlag(flags, "title");
      const body = requireBody(flags);
      printJson(await confluence.updatePage({
        pageId,
        title,
        body,
        format: parseFormat(flags.format),
        versionNumber: flags["version-number"] ? positiveInt(flags["version-number"], "version-number") : undefined,
        autoVersion: flags["auto-version"] === "true",
        status: flags.status,
        message: flags.message,
        parentId: flags["parent-id"],
        spaceId: flags["space-id"],
      }));
      return;
    }

    case "delete": {
      requireArg(pageId, "page ID");
      if (flags.confirm !== "true") {
        throw new Error("Refusing to delete without --confirm");
      }
      printJson(await confluence.deletePage(pageId, {
        purge: flags.purge === undefined ? undefined : parseBoolean(flags.purge, "purge"),
        draft: flags.draft === undefined ? undefined : parseBoolean(flags.draft, "draft"),
      }));
      return;
    }

    default:
      throw new Error(`Unknown page command: ${action ?? ""}`);
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      flags[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags[withoutPrefix] = "true";
      continue;
    }

    flags[withoutPrefix] = next;
    i += 1;
  }
  return flags;
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value || value === "true") throw new Error(`--${name} is required`);
  return value;
}

function requireArg(value: string | undefined, name: string): asserts value is string {
  if (!value) throw new Error(`${name} is required`);
}

function requireBody(flags: Record<string, string>): string {
  if (flags["body-file"]) return readFileSync(flags["body-file"], "utf8");
  return requireFlag(flags, "body");
}

function positiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false`);
}

function parseFormat(value: string | undefined): "storage" | "markdown" | "atlas_doc_format" | undefined {
  if (!value) return undefined;
  if (value === "storage" || value === "markdown" || value === "atlas_doc_format") return value;
  throw new Error("--format must be storage, markdown, or atlas_doc_format");
}

function parseReadFormat(value: string | undefined): "storage" | "atlas_doc_format" | "view" {
  if (!value) return "storage";
  if (value === "storage" || value === "atlas_doc_format" || value === "view") return value;
  throw new Error("--body-format must be storage, atlas_doc_format, or view");
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage(): void {
  process.stdout.write(`confluence-tool-mcp

Usage:
  confluence-tool-mcp serve --transport stdio
  confluence-tool-mcp serve --transport http --port 8004
  confluence-tool-mcp page get 123456 [--body-format storage]
  confluence-tool-mcp page search [--space-id 98765] [--title "Runbook"] [--limit 25]
  confluence-tool-mcp page create --space-id 98765 --title "Title" --body "Storage HTML" [--format storage]
  confluence-tool-mcp page create --space-id 98765 --title "Title" --body-file ./page.md --format markdown
  confluence-tool-mcp page update 123456 --title "Title" --body-file ./page.md --format markdown --auto-version
  confluence-tool-mcp page update 123456 --title "Title" --body "Storage HTML" --version-number 12
  confluence-tool-mcp page delete 123456 --confirm [--purge true] [--draft true]
`);
}
