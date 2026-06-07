import { extractBodyValue, toConfluenceBody, type BodyFormat, type BodyRepresentation } from "./content.js";
import type { ConfluenceToolConfig } from "./config.js";

export interface ConfluenceClientOptions {
  config: ConfluenceToolConfig;
}

export interface CreatePageInput {
  spaceId: string;
  title: string;
  body: string;
  format?: BodyFormat | BodyRepresentation;
  parentId?: string;
  status?: string;
  subtype?: string;
}

export interface SearchPagesInput {
  spaceId?: string;
  title?: string;
  status?: string;
  bodyFormat?: BodyRepresentation | "view";
  limit?: number;
}

export interface UpdatePageInput {
  pageId: string;
  title: string;
  body: string;
  format?: BodyFormat | BodyRepresentation;
  versionNumber?: number;
  autoVersion?: boolean;
  status?: string;
  message?: string;
  parentId?: string;
  spaceId?: string;
}

export class ConfluenceApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: unknown
  ) {
    super(message);
    this.name = "ConfluenceApiError";
  }
}

export class ConfluenceClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(options: ConfluenceClientOptions) {
    const { domain, email, apiToken } = options.config;
    this.baseUrl = `https://${domain}/wiki/api/v2`;
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  async createPage(input: CreatePageInput): Promise<unknown> {
    const payload: Record<string, unknown> = {
      spaceId: input.spaceId,
      status: input.status ?? "current",
      title: input.title,
      body: toConfluenceBody(input.body, input.format ?? "storage"),
    };

    if (input.parentId) payload.parentId = input.parentId;
    if (input.subtype) payload.subtype = input.subtype;

    return this.normalizePage(await this.request("/pages", {
      method: "POST",
      body: payload,
    }));
  }

  async getPage(pageId: string, bodyFormat: BodyRepresentation | "view" = "storage"): Promise<unknown> {
    return this.normalizePage(await this.request(`/pages/${encodeURIComponent(pageId)}`, {
      query: {
        "body-format": bodyFormat,
        "include-version": "true",
      },
    }));
  }

  async searchPages(input: SearchPagesInput = {}): Promise<unknown> {
    const query: Record<string, string> = {};
    if (input.spaceId) query["space-id"] = input.spaceId;
    if (input.title) query.title = input.title;
    if (input.status) query.status = input.status;
    if (input.bodyFormat) query["body-format"] = input.bodyFormat;
    if (input.limit) query.limit = String(input.limit);

    const data = await this.request<{ results?: unknown[]; _links?: unknown }>("/pages", { query });
    return {
      results: (data.results ?? []).map((page) => this.normalizePage(page)),
      _links: data._links,
    };
  }

  async updatePage(input: UpdatePageInput): Promise<unknown> {
    const currentPage = input.autoVersion || !input.versionNumber
      ? await this.getPage(input.pageId, "storage") as Record<string, unknown>
      : undefined;

    const versionNumber = input.versionNumber ?? nextVersionNumber(currentPage);
    const title = input.title ?? stringField(currentPage, "title");
    const status = input.status ?? stringField(currentPage, "status") ?? "current";

    if (!title) throw new Error("title is required");

    const payload: Record<string, unknown> = {
      id: input.pageId,
      status,
      title,
      body: toConfluenceBody(input.body, input.format ?? "storage"),
      version: {
        number: versionNumber,
        ...(input.message ? { message: input.message } : {}),
      },
    };

    if (input.parentId) payload.parentId = input.parentId;
    if (input.spaceId) payload.spaceId = input.spaceId;

    return this.normalizePage(await this.request(`/pages/${encodeURIComponent(input.pageId)}`, {
      method: "PUT",
      body: payload,
    }));
  }

  async deletePage(pageId: string, options: { purge?: boolean; draft?: boolean } = {}): Promise<unknown> {
    await this.request(`/pages/${encodeURIComponent(pageId)}`, {
      method: "DELETE",
      query: {
        ...(options.purge === undefined ? {} : { purge: String(options.purge) }),
        ...(options.draft === undefined ? {} : { draft: String(options.draft) }),
      },
    });
    return { deleted: true, pageId, purge: options.purge ?? false, draft: options.draft ?? false };
  }

  private async request<T = unknown>(path: string, options: {
    method?: string;
    query?: Record<string, string>;
    body?: unknown;
  } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const responseBody = await parseResponseBody(response);
    if (!response.ok) {
      throw new ConfluenceApiError(formatApiError(response.status, responseBody), response.status, responseBody);
    }

    return responseBody as T;
  }

  private normalizePage(raw: unknown): unknown {
    if (!raw || typeof raw !== "object") return raw;
    const page = raw as Record<string, unknown>;
    const version = objectField(page.version);
    const links = objectField(page._links);

    return {
      id: page.id,
      status: page.status,
      title: page.title,
      spaceId: page.spaceId,
      parentId: page.parentId,
      parentType: page.parentType,
      authorId: page.authorId,
      ownerId: page.ownerId,
      createdAt: page.createdAt,
      version: version.number ? {
        number: version.number,
        message: version.message,
        minorEdit: version.minorEdit,
        createdAt: version.createdAt,
        authorId: version.authorId,
      } : null,
      body: {
        storage: extractBodyValue(page, "storage"),
        atlas_doc_format: extractBodyValue(page, "atlas_doc_format"),
        view: extractBodyValue(page, "view"),
      },
      links,
    };
  }
}

function nextVersionNumber(page: Record<string, unknown> | undefined): number {
  const version = objectField(page?.version);
  const current = Number(version.number);
  if (!Number.isInteger(current) || current <= 0) {
    throw new Error("Could not infer current page version; pass --version-number explicitly");
  }
  return current + 1;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatApiError(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = record.message ?? record.detail ?? record.title;
    if (message) return `Confluence API ${status}: ${String(message)}`;
  }
  return `Confluence API ${status}: ${typeof body === "string" ? body : "request failed"}`;
}
