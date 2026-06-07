# confluence-tool-mcp

CLI and MCP server for Confluence Cloud page operations.

## Setup

Create a `.env` file in this directory or export the variables:

```env
ATLASSIAN_DOMAIN=yourcompany.atlassian.net
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_API_TOKEN=your-api-token
CONFLUENCE_TOOL_MCP_PORT=8004
```

`CONFLUENCE_DOMAIN`, `CONFLUENCE_EMAIL`, `CONFLUENCE_API_TOKEN`, and the Jira helper aliases are also supported.

## Commands

Run as an MCP server:

```bash
pnpm --dir mcp/confluence-tool-mcp run dev -- serve --transport stdio
pnpm --dir mcp/confluence-tool-mcp run dev -- serve --transport http --port 8004
```

Use direct Confluence commands:

```bash
pnpm --dir mcp/confluence-tool-mcp run dev -- page get 123456 --body-format storage
pnpm --dir mcp/confluence-tool-mcp run dev -- page search --space-id 98765 --title "Runbook"
pnpm --dir mcp/confluence-tool-mcp run dev -- page create --space-id 98765 --title "Runbook" --body-file ./runbook.md --format markdown
pnpm --dir mcp/confluence-tool-mcp run dev -- page update 123456 --title "Runbook" --body-file ./runbook.md --format markdown --auto-version
pnpm --dir mcp/confluence-tool-mcp run dev -- page delete 123456 --confirm
```

Build:

```bash
pnpm --dir mcp/confluence-tool-mcp run build
```

## MCP Tools

- `confluence_create_page`
- `confluence_get_page`
- `confluence_search_pages`
- `confluence_update_page`
- `confluence_delete_page`
