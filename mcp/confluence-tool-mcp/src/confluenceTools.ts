import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConfluenceClient } from "./confluenceClient.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const BodyFormatSchema = z.enum(["storage", "markdown", "atlas_doc_format"]);
const BodyFormatReadSchema = z.enum(["storage", "atlas_doc_format", "view"]);

export function createConfluenceMcpServer(confluence: ConfluenceClient): McpServer {
  const server = new McpServer({ name: "confluence-tool-mcp", version: "0.1.0" });
  registerConfluenceTools(server, confluence);
  return server;
}

export function registerConfluenceTools(server: McpServer, confluence: ConfluenceClient): void {
  server.registerTool(
    "confluence_create_page",
    {
      description: "Create a Confluence page.",
      inputSchema: {
        spaceId: z.string().describe("Confluence space ID"),
        title: z.string().describe("Page title"),
        body: z.string().describe("Page body"),
        format: BodyFormatSchema.optional().describe("Body input format. Defaults to storage."),
        parentId: z.string().optional().describe("Optional parent page ID"),
        status: z.string().optional().describe("Page status. Defaults to current."),
        subtype: z.string().optional().describe("Optional Confluence page subtype"),
      },
    },
    async (input) => {
      try { return ok(await confluence.createPage(input)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "confluence_get_page",
    {
      description: "Fetch a Confluence page by ID.",
      inputSchema: {
        pageId: z.string().describe("Confluence page ID"),
        bodyFormat: BodyFormatReadSchema.optional().describe("Body representation to request. Defaults to storage."),
      },
    },
    async ({ pageId, bodyFormat }) => {
      try { return ok(await confluence.getPage(pageId, bodyFormat)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "confluence_search_pages",
    {
      description: "Search/list Confluence pages.",
      inputSchema: {
        spaceId: z.string().optional().describe("Filter by space ID"),
        title: z.string().optional().describe("Filter by exact page title"),
        status: z.string().optional().describe("Filter by page status"),
        bodyFormat: BodyFormatReadSchema.optional().describe("Body representation to request"),
        limit: z.number().int().positive().optional().describe("Maximum results to return"),
      },
    },
    async (input) => {
      try { return ok(await confluence.searchPages(input)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "confluence_update_page",
    {
      description: "Update a Confluence page. Use autoVersion to fetch and increment the current version.",
      inputSchema: {
        pageId: z.string().describe("Confluence page ID"),
        title: z.string().describe("Page title"),
        body: z.string().describe("Page body"),
        format: BodyFormatSchema.optional().describe("Body input format. Defaults to storage."),
        versionNumber: z.number().int().positive().optional().describe("Next page version number"),
        autoVersion: z.boolean().optional().describe("Fetch current page and use current version + 1"),
        status: z.string().optional().describe("Page status. Defaults to current page status or current."),
        message: z.string().optional().describe("Version message"),
        parentId: z.string().optional().describe("Optional parent page ID"),
        spaceId: z.string().optional().describe("Optional space ID"),
      },
    },
    async (input) => {
      try { return ok(await confluence.updatePage(input)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "confluence_delete_page",
    {
      description: "Delete a Confluence page. Non-draft pages move to trash by default.",
      inputSchema: {
        pageId: z.string().describe("Confluence page ID"),
        purge: z.boolean().optional().describe("Permanently delete a trashed page"),
        draft: z.boolean().optional().describe("Delete a draft page"),
      },
    },
    async ({ pageId, purge, draft }) => {
      try { return ok(await confluence.deletePage(pageId, { purge, draft })); } catch (e) { return err(e); }
    }
  );
}
