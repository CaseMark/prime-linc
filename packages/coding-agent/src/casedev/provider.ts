import { loginCasedev } from "@earendil-works/pi-ai/oauth";
import type { ExtensionFactory, ProviderConfig, ProviderModelConfig } from "../core/extensions/types.js";
import { mirrorCasedevCliKey, resolveCasedevEnvApiKey } from "./auth.js";
import { CASEDEV_DEFAULT_MODEL_ID, CASEDEV_LLM_BASE, CASEDEV_PROVIDER_ID, CASEDEV_PROVIDER_NAME } from "./constants.js";

function fallbackModels(baseUrl: string): ProviderModelConfig[] {
	return [
		{
			id: CASEDEV_DEFAULT_MODEL_ID,
			name: "Claude Sonnet 4.5",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 16384,
			baseUrl,
		},
		{
			id: "openai/gpt-5.4",
			name: "GPT-5.4",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 16384,
			baseUrl,
		},
		{
			id: "google/gemini-3.1-pro-preview",
			name: "Gemini 3.1 Pro",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 16384,
			baseUrl,
		},
	];
}

async function fetchCasedevModels(apiKey: string, baseUrl: string): Promise<ProviderModelConfig[]> {
	const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
		headers: { Authorization: `Bearer ${apiKey}` },
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch case.dev models: ${response.status} ${response.statusText}`);
	}
	const body = (await response.json()) as { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
	const models = Array.isArray(body) ? body : (body.data ?? []);
	const mapped: ProviderModelConfig[] = [];
	for (const entry of models) {
		const id = typeof entry.id === "string" ? entry.id : undefined;
		if (!id) continue;
		mapped.push({
			id,
			name: typeof entry.name === "string" ? entry.name : id,
			api: "openai-completions",
			baseUrl,
			reasoning:
				typeof entry.reasoning === "boolean"
					? entry.reasoning
					: id.includes("o1") || id.includes("o3") || id.includes("o4") || id.includes("opus"),
			input: Array.isArray(entry.input)
				? (entry.input.filter((v): v is "text" | "image" => v === "text" || v === "image") as ("text" | "image")[])
				: ["text"],
			cost:
				entry.cost && typeof entry.cost === "object"
					? (entry.cost as ProviderModelConfig["cost"])
					: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow:
				typeof entry.context_window === "number"
					? entry.context_window
					: typeof entry.contextWindow === "number"
						? entry.contextWindow
						: 128000,
			maxTokens:
				typeof entry.max_tokens === "number"
					? entry.max_tokens
					: typeof entry.maxTokens === "number"
						? entry.maxTokens
						: 16384,
		});
	}
	return mapped.length > 0 ? mapped : fallbackModels(baseUrl);
}

export async function buildCasedevProviderConfig(
	getApiKey?: () => Promise<string | undefined>,
): Promise<ProviderConfig> {
	const baseUrl = CASEDEV_LLM_BASE;
	const apiKey = (await getApiKey?.()) || resolveCasedevEnvApiKey();
	let models = fallbackModels(baseUrl);
	if (apiKey) {
		try {
			models = await fetchCasedevModels(apiKey, baseUrl);
		} catch {
			// Keep fallback models when the catalog is unreachable.
		}
	}

	return {
		name: CASEDEV_PROVIDER_NAME,
		baseUrl,
		api: "openai-completions",
		apiKey: "CASEDEV_API_KEY",
		authHeader: true,
		models,
		oauth: {
			name: CASEDEV_PROVIDER_NAME,
			login: async (callbacks) => {
				const credentials = await loginCasedev(callbacks);
				mirrorCasedevCliKey(credentials.access);
				return credentials;
			},
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => credentials.access,
		},
	};
}

export function createCasedevExtension(options?: {
	cwd?: string;
	getApiKey?: () => Promise<string | undefined> | string | undefined;
}): ExtensionFactory {
	return async (pi) => {
		const getApiKey = async () => {
			const value = await options?.getApiKey?.();
			return value || resolveCasedevEnvApiKey();
		};
		const config = await buildCasedevProviderConfig(getApiKey);
		pi.registerProvider(CASEDEV_PROVIDER_ID, config);
	};
}
