import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { ExtensionFactory, ToolDefinition } from "../core/extensions/types.js";

const MAX_SINGLE_FILE_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_CASEDEV_API_BASE = "https://api.case.dev";

const vaultListSchema = Type.Object({});

const vaultSearchSchema = Type.Object({
	vaultId: Type.String({ description: "The vault ID to search" }),
	query: Type.String({ description: "The search query" }),
	topK: Type.Optional(Type.Number({ description: "Maximum number of chunks to return, 1 to 50" })),
	method: Type.Optional(
		Type.Union([Type.Literal("hybrid"), Type.Literal("fast"), Type.Literal("global"), Type.Literal("local")], {
			description: "Search method",
		}),
	),
});

const vaultDownloadSchema = Type.Object({
	vaultId: Type.String({ description: "The source vault ID" }),
	objectId: Type.String({ description: "The vault object ID" }),
	filename: Type.Optional(Type.String({ description: "Optional local filename" })),
});

const vaultUploadSchema = Type.Object({
	vaultId: Type.String({ description: "The destination vault ID" }),
	filePath: Type.String({ description: "Relative path to the workspace file to upload" }),
	filename: Type.Optional(Type.String({ description: "Optional destination filename" })),
	contentType: Type.Optional(Type.String({ description: "Optional MIME type" })),
	path: Type.Optional(Type.String({ description: "Optional matter folder path" })),
	storageOnly: Type.Optional(
		Type.Boolean({ description: "Store the file in the matter without ingesting or indexing it" }),
	),
	autoIndex: Type.Optional(Type.Boolean({ description: "Set false to skip ingestion/indexing for this upload" })),
});

const legalResearchSchema = Type.Object({
	query: Type.String({ description: "Primary legal research query" }),
	jurisdiction: Type.Optional(Type.String({ description: "Optional jurisdiction ID" })),
	numResults: Type.Optional(Type.Number({ description: "Number of results, 1 to 25" })),
});

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query" }),
	numResults: Type.Optional(Type.Number({ description: "Number of results, 1 to 100" })),
	includeText: Type.Optional(Type.Boolean({ description: "Whether to include extracted text" })),
});

const skillSearchSchema = Type.Object({
	query: Type.String({ description: "Skill search query" }),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results, 1 to 20" })),
});

const skillReadSchema = Type.Object({
	slug: Type.String({ description: "The skill slug to read" }),
});

export type VaultListToolInput = Static<typeof vaultListSchema>;
export type VaultSearchToolInput = Static<typeof vaultSearchSchema>;
export type VaultDownloadToolInput = Static<typeof vaultDownloadSchema>;
export type VaultUploadToolInput = Static<typeof vaultUploadSchema>;
export type LegalResearchToolInput = Static<typeof legalResearchSchema>;
export type WebSearchToolInput = Static<typeof webSearchSchema>;
export type SkillSearchToolInput = Static<typeof skillSearchSchema>;
export type SkillReadToolInput = Static<typeof skillReadSchema>;

export interface CaseDevToolsOptions {
	cwd?: string;
	baseUrl?: string;
	getApiKey?: () => Promise<string | undefined> | string | undefined;
}

type CaseDevToolDetails = undefined;
type JsonRecord = Record<string, unknown>;

interface CaseDevClient {
	cwd: string;
	request(
		endpoint: string,
		init?: RequestInit,
		options?: { json?: boolean; throwOnError?: boolean },
	): Promise<Response>;
	requestJson(endpoint: string, init?: RequestInit): Promise<unknown>;
	download(endpoint: string, init?: RequestInit): Promise<Response>;
}

function normalizeApiBaseUrl(baseUrl: string | undefined): string {
	const resolved =
		baseUrl ||
		process.env.CASEDEV_BASE_URL ||
		process.env.CASE_API_URL ||
		process.env.CASEDEV_API_BASE_URL ||
		DEFAULT_CASEDEV_API_BASE;
	return resolved.replace(/\/llm\/v1\/?$/, "").replace(/\/+$/, "");
}

async function resolveApiKey(options?: CaseDevToolsOptions): Promise<string> {
	const key =
		(await options?.getApiKey?.()) ||
		process.env.CASEDEV_API_KEY ||
		process.env.CASE_API_KEY ||
		process.env.CORE_ACCESS_TOKEN;
	if (!key) {
		throw new Error("case.dev auth is not configured. Run /login and add a case.dev API key.");
	}
	return key;
}

async function createClient(options?: CaseDevToolsOptions): Promise<CaseDevClient> {
	const baseUrl = normalizeApiBaseUrl(options?.baseUrl);
	const apiKey = await resolveApiKey(options);
	const cwd = options?.cwd ?? process.cwd();

	const withAuthHeaders = (init?: RequestInit, json = true): RequestInit => {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${apiKey}`);
		if (json && !headers.has("Content-Type")) {
			headers.set("Content-Type", "application/json");
		}
		return { ...init, headers };
	};

	const request = async (
		endpoint: string,
		init?: RequestInit,
		requestOptions?: { json?: boolean; throwOnError?: boolean },
	): Promise<Response> => {
		const response = await fetch(`${baseUrl}${endpoint}`, withAuthHeaders(init, requestOptions?.json ?? true));
		if ((requestOptions?.throwOnError ?? true) && !response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Case.dev request failed (${response.status}): ${body || response.statusText}`);
		}
		return response;
	};

	return {
		cwd,
		request,
		async requestJson(endpoint, init) {
			const response = await request(endpoint, init);
			return response.json();
		},
		async download(endpoint, init) {
			const response = await request(endpoint, init, { json: false, throwOnError: false });
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(`Download failed (${response.status}): ${body || response.statusText}`);
			}
			return response;
		},
	};
}

function textResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value) }],
		details: undefined,
	};
}

function renderCaseDevCall(name: string, args: unknown): Text {
	const suffix =
		args && typeof args === "object" && "query" in args ? ` ${(args as { query?: string }).query ?? ""}` : "";
	return new Text(`${name}${suffix}`, 0, 0);
}

function recordValue(value: unknown): JsonRecord {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeName(value: unknown, fallback: string): string {
	const name = String(value || fallback)
		.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
		.trim();
	return name.slice(0, 160) || fallback;
}

function resolveWorkspacePath(cwd: string, filePath: string): string {
	if (!filePath) {
		throw new Error("filePath is required");
	}
	if (path.isAbsolute(filePath)) {
		throw new Error("filePath must be relative to the workspace");
	}

	const root = path.resolve(cwd);
	const resolved = path.resolve(root, filePath);
	const relative = path.relative(root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error("filePath must stay inside the workspace");
	}
	return resolved;
}

function normalizeVaultSources(results: unknown): Array<Record<string, unknown>> {
	return (Array.isArray(results) ? results : [])
		.map((entry) => {
			const record = recordValue(entry);
			const metadata = recordValue(record.metadata);
			const objectId = stringValue(record.object_id) || stringValue(record.objectId) || stringValue(record.id);
			return {
				type: "vault",
				id: objectId ? `vault:${objectId}` : undefined,
				objectId,
				title:
					stringValue(record.object_name) ||
					stringValue(record.filename) ||
					stringValue(record.name) ||
					objectId ||
					"Matter document",
				snippet: stringValue(record.text) || stringValue(record.snippet) || stringValue(record.content) || "",
				pages: metadata.page ? String(metadata.page) : null,
			};
		})
		.filter((entry) => entry.objectId);
}

function normalizeLegalSources(results: unknown): Array<Record<string, unknown>> {
	return (Array.isArray(results) ? results : [])
		.map((entry) => {
			const record = recordValue(entry);
			const id = stringValue(record.url) || stringValue(record.id) || stringValue(record.title);
			return {
				type: "legal",
				id,
				title: stringValue(record.title) || stringValue(record.name) || "Legal source",
				snippet: stringValue(record.snippet) || stringValue(record.text) || "",
				url: stringValue(record.url) || null,
				publishedDate: stringValue(record.publishedDate) || stringValue(record.published_date) || null,
			};
		})
		.filter((entry) => entry.id);
}

function normalizeWebSources(results: unknown): Array<Record<string, unknown>> {
	return (Array.isArray(results) ? results : [])
		.map((entry) => {
			const record = recordValue(entry);
			const id = stringValue(record.url) || stringValue(record.id) || stringValue(record.title);
			return {
				type: "web",
				id,
				title: stringValue(record.title) || stringValue(record.name) || "Web source",
				snippet: stringValue(record.snippet) || stringValue(record.text) || stringValue(record.summary) || "",
				url: stringValue(record.url) || null,
				publishedDate: stringValue(record.publishedDate) || stringValue(record.published_date) || null,
			};
		})
		.filter((entry) => entry.id);
}

async function writeVaultDownload(
	client: CaseDevClient,
	args: VaultDownloadToolInput,
): Promise<Record<string, unknown>> {
	const object = recordValue(
		await client.requestJson(
			`/vault/${encodeURIComponent(args.vaultId)}/objects/${encodeURIComponent(args.objectId)}`,
		),
	);
	const filename = safeName(args.filename || object.filename || object.name, `${args.objectId}.bin`);
	const outputDir = path.join(client.cwd, "downloads");
	const outputPath = path.join(outputDir, filename);

	await mkdir(outputDir, { recursive: true });

	const response = await client.download(
		`/vault/${encodeURIComponent(args.vaultId)}/objects/${encodeURIComponent(args.objectId)}/download`,
	);
	const bytes = Buffer.from(await response.arrayBuffer());
	await writeFile(outputPath, bytes);

	return {
		vaultId: args.vaultId,
		objectId: args.objectId,
		filename,
		path: path.relative(client.cwd, outputPath),
		sizeBytes: bytes.byteLength,
	};
}

async function uploadWorkspaceFile(
	client: CaseDevClient,
	args: VaultUploadToolInput,
): Promise<Record<string, unknown>> {
	const resolvedPath = resolveWorkspacePath(client.cwd, args.filePath);
	const fileStat = await stat(resolvedPath);
	if (!fileStat.isFile()) {
		throw new Error("filePath must point to a file");
	}
	if (fileStat.size > MAX_SINGLE_FILE_UPLOAD_BYTES) {
		throw new Error("vault_upload currently supports single files up to 25 MB");
	}

	const filename = safeName(args.filename || path.basename(resolvedPath), "upload.bin");
	const contentType = args.contentType || "application/octet-stream";
	const shouldAutoIndex = !(args.storageOnly === true || args.autoIndex === false);
	const uploadInit = recordValue(
		await client.requestJson(`/vault/${encodeURIComponent(args.vaultId)}/upload`, {
			method: "POST",
			body: JSON.stringify({
				filename,
				contentType,
				sizeBytes: fileStat.size,
				...(shouldAutoIndex ? {} : { auto_index: false }),
				...(args.path ? { path: args.path, metadata: { path: args.path } } : {}),
			}),
		}),
	);

	const uploadUrl =
		stringValue(uploadInit.url) || stringValue(uploadInit.presignedUrl) || stringValue(uploadInit.uploadUrl);
	const objectId = stringValue(uploadInit.objectId) || stringValue(uploadInit.object_id) || stringValue(uploadInit.id);
	if (!uploadUrl || !objectId) {
		throw new Error("Upload initialization did not return an upload target");
	}

	const content = await readFile(resolvedPath);
	const uploadResponse = await fetch(String(uploadUrl), {
		method: "PUT",
		headers: { "Content-Type": contentType },
		body: content,
	});
	if (!uploadResponse.ok) {
		throw new Error(`Object storage upload failed (${uploadResponse.status})`);
	}

	const etag = uploadResponse.headers.get("etag") || uploadResponse.headers.get("ETag") || undefined;
	const confirmResponse = await client.request(
		`/vault/${encodeURIComponent(args.vaultId)}/upload/${encodeURIComponent(objectId)}/confirm`,
		{
			method: "POST",
			body: JSON.stringify({
				success: true,
				sizeBytes: fileStat.size,
				...(etag ? { etag } : {}),
			}),
		},
		{ throwOnError: false },
	);
	if (!confirmResponse.ok && confirmResponse.status !== 404 && confirmResponse.status !== 405) {
		throw new Error(`Upload confirmation failed (${confirmResponse.status})`);
	}

	if (!shouldAutoIndex) {
		return {
			vaultId: args.vaultId,
			objectId,
			filename,
			sizeBytes: fileStat.size,
			ingestionStatus: stringValue(uploadInit.ingestionStatus) || stringValue(uploadInit.status) || "uploaded",
			storageOnly: true,
		};
	}

	const ingest = recordValue(
		await client.requestJson(`/vault/${encodeURIComponent(args.vaultId)}/ingest/${encodeURIComponent(objectId)}`, {
			method: "POST",
			body: JSON.stringify({ filename, contentType, ...(args.path ? { path: args.path } : {}) }),
		}),
	);

	return {
		vaultId: args.vaultId,
		objectId,
		filename,
		sizeBytes: fileStat.size,
		ingestionStatus: stringValue(ingest.ingestionStatus) || stringValue(ingest.status) || "processing",
	};
}

export function createVaultListToolDefinition(
	options?: CaseDevToolsOptions,
): ToolDefinition<typeof vaultListSchema, CaseDevToolDetails> {
	return {
		name: "vault_list",
		label: "vault_list",
		description: "List the matter document vaults available to this worker.",
		promptSnippet: "List available case.dev vaults",
		parameters: vaultListSchema,
		async execute() {
			const client = await createClient(options);
			const data = recordValue(await client.requestJson("/vault"));
			return textResult({ vaults: data.vaults || data.data || data });
		},
		renderCall: (args) => renderCaseDevCall("vault_list", args),
	};
}

export function createVaultSearchToolDefinition(
	options?: CaseDevToolsOptions,
): ToolDefinition<typeof vaultSearchSchema, CaseDevToolDetails> {
	return {
		name: "vault_search",
		label: "vault_search",
		description: "Search matter documents in a vault. Use this before answering matter-document questions.",
		promptSnippet: "Search matter documents in a vault",
		parameters: vaultSearchSchema,
		async execute(_toolCallId, args) {
			const client = await createClient(options);
			const data = recordValue(
				await client.requestJson(`/vault/${encodeURIComponent(args.vaultId)}/search`, {
					method: "POST",
					body: JSON.stringify({
						query: args.query,
						topK: args.topK || 8,
						method: args.method || "hybrid",
					}),
				}),
			);
			const results = data.chunks || data.results || [];
			return textResult({
				vaultId: args.vaultId,
				query: args.query,
				results,
				sources: normalizeVaultSources(results),
			});
		},
		renderCall: (args) => renderCaseDevCall("vault_search", args),
	};
}

export function createLegalResearchToolDefinition(
	options?: CaseDevToolsOptions,
): ToolDefinition<typeof legalResearchSchema, CaseDevToolDetails> {
	return {
		name: "legal_research",
		label: "legal_research",
		description: "Research case law and legal authority. Start with this for legal research tasks.",
		promptSnippet: "Research case law and legal authority",
		parameters: legalResearchSchema,
		async execute(_toolCallId, args) {
			const client = await createClient(options);
			const data = recordValue(
				await client.requestJson("/legal/v1/research", {
					method: "POST",
					body: JSON.stringify({
						query: args.query,
						jurisdiction: args.jurisdiction,
						numResults: args.numResults || 10,
					}),
				}),
			);
			const candidates = data.candidates || data.results || [];
			return textResult({
				...data,
				sources: normalizeLegalSources(candidates),
			});
		},
		renderCall: (args) => renderCaseDevCall("legal_research", args),
	};
}

export function createWebSearchToolDefinition(
	options?: CaseDevToolsOptions,
): ToolDefinition<typeof webSearchSchema, CaseDevToolDetails> {
	return {
		name: "web_search",
		label: "web_search",
		description: "Search the web for supporting public information.",
		promptSnippet: "Search the web",
		parameters: webSearchSchema,
		async execute(_toolCallId, args) {
			const client = await createClient(options);
			const data = recordValue(
				await client.requestJson("/search/v1/search", {
					method: "POST",
					body: JSON.stringify({
						query: args.query,
						numResults: args.numResults || 10,
						includeText: args.includeText || false,
					}),
				}),
			);
			const results = data.results || data.data || [];
			return textResult({
				...data,
				sources: normalizeWebSources(results),
			});
		},
		renderCall: (args) => renderCaseDevCall("web_search", args),
	};
}

export function createSkillSearchToolDefinition(
	options?: CaseDevToolsOptions,
): ToolDefinition<typeof skillSearchSchema, CaseDevToolDetails> {
	return {
		name: "skill_search",
		label: "skill_search",
		description:
			"Search org custom and curated Case.dev skills using the authenticated runtime key. Use this for selected skills, custom skills, and legal workflow playbooks.",
		promptSnippet: "Search case.dev skills",
		parameters: skillSearchSchema,
		async execute(_toolCallId, args) {
			const client = await createClient(options);
			const params = new URLSearchParams({
				q: args.query,
				limit: String(Math.min(Math.max(args.limit || 10, 1), 20)),
			});
			const data = await client.requestJson(`/skills/resolve?${params.toString()}`);
			return textResult(data);
		},
		renderCall: (args) => renderCaseDevCall("skill_search", args),
	};
}

export function createSkillReadToolDefinition(
	options?: CaseDevToolsOptions,
): ToolDefinition<typeof skillReadSchema, CaseDevToolDetails> {
	return {
		name: "skill_read",
		label: "skill_read",
		description:
			"Read a Case.dev skill by slug using the authenticated runtime key. Custom skill root and companion file slugs are org-scoped and must be read through this tool.",
		promptSnippet: "Read a case.dev skill by slug",
		parameters: skillReadSchema,
		async execute(_toolCallId, args) {
			const client = await createClient(options);
			const skill = recordValue(await client.requestJson(`/skills/${encodeURIComponent(args.slug)}`));
			return textResult({
				slug: skill.slug,
				name: skill.name,
				summary: skill.summary,
				content: skill.content,
				tags: skill.tags,
				source: skill.source,
				metadata: skill.metadata,
				bundle: skill.bundle,
			});
		},
		renderCall: (args) => renderCaseDevCall("skill_read", args),
	};
}

export function createVaultDownloadToolDefinition(
	options?: CaseDevToolsOptions,
): ToolDefinition<typeof vaultDownloadSchema, CaseDevToolDetails> {
	return {
		name: "vault_download",
		label: "vault_download",
		description: "Download a matter document into the workspace without exposing signed URLs.",
		promptSnippet: "Download a matter document into the workspace",
		parameters: vaultDownloadSchema,
		async execute(_toolCallId, args) {
			const client = await createClient(options);
			return textResult(await writeVaultDownload(client, args));
		},
		renderCall: (args) => renderCaseDevCall("vault_download", args),
	};
}

export function createVaultUploadToolDefinition(
	options?: CaseDevToolsOptions,
): ToolDefinition<typeof vaultUploadSchema, CaseDevToolDetails> {
	return {
		name: "vault_upload",
		label: "vault_upload",
		description:
			"Upload a workspace file to a matter vault without exposing signed URLs. Single files up to 25 MB are supported. By default uploads are indexed for search; set storageOnly=true (or autoIndex=false) for generated deliverables that should land in the matter without ingestion.",
		promptSnippet: "Upload a workspace file to a matter vault",
		parameters: vaultUploadSchema,
		async execute(_toolCallId, args) {
			const client = await createClient(options);
			return textResult(await uploadWorkspaceFile(client, args));
		},
		renderCall: (args) => renderCaseDevCall("vault_upload", args),
	};
}

export interface CaseDevToolDefinitions {
	vault_list: ReturnType<typeof createVaultListToolDefinition>;
	vault_search: ReturnType<typeof createVaultSearchToolDefinition>;
	vault_download: ReturnType<typeof createVaultDownloadToolDefinition>;
	vault_upload: ReturnType<typeof createVaultUploadToolDefinition>;
	legal_research: ReturnType<typeof createLegalResearchToolDefinition>;
	web_search: ReturnType<typeof createWebSearchToolDefinition>;
	skill_search: ReturnType<typeof createSkillSearchToolDefinition>;
	skill_read: ReturnType<typeof createSkillReadToolDefinition>;
}

export type CaseDevToolName = keyof CaseDevToolDefinitions;

export function createCaseDevToolDefinitions(options?: CaseDevToolsOptions): CaseDevToolDefinitions {
	return {
		vault_list: createVaultListToolDefinition(options),
		vault_search: createVaultSearchToolDefinition(options),
		vault_download: createVaultDownloadToolDefinition(options),
		vault_upload: createVaultUploadToolDefinition(options),
		legal_research: createLegalResearchToolDefinition(options),
		web_search: createWebSearchToolDefinition(options),
		skill_search: createSkillSearchToolDefinition(options),
		skill_read: createSkillReadToolDefinition(options),
	};
}

export const caseDevToolNames = [
	"vault_list",
	"vault_search",
	"vault_download",
	"vault_upload",
	"legal_research",
	"web_search",
	"skill_search",
	"skill_read",
] as const satisfies readonly CaseDevToolName[];

export function createCaseDevToolsExtension(options?: CaseDevToolsOptions): ExtensionFactory {
	return (linc) => {
		for (const definition of Object.values(createCaseDevToolDefinitions(options))) {
			linc.registerTool(definition);
		}
	};
}

export default createCaseDevToolsExtension();
