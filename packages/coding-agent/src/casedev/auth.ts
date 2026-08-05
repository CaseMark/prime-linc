import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CASEDEV_CLI_CONFIG_PATH, CASEDEV_PROVIDER_ID } from "./constants.js";

export function readCasedevCliKey(): string | undefined {
	try {
		if (!existsSync(CASEDEV_CLI_CONFIG_PATH)) {
			return undefined;
		}
		const config = JSON.parse(readFileSync(CASEDEV_CLI_CONFIG_PATH, "utf-8")) as { apiKey?: unknown };
		return typeof config.apiKey === "string" && config.apiKey.length > 0 ? config.apiKey : undefined;
	} catch {
		return undefined;
	}
}

/** Best-effort mirror of sk_case_* keys into the casedev CLI config. */
export function mirrorCasedevCliKey(apiKey: string): void {
	if (!apiKey.startsWith("sk_case_")) {
		return;
	}
	try {
		const dir = dirname(CASEDEV_CLI_CONFIG_PATH);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		let config: Record<string, unknown> = {};
		if (existsSync(CASEDEV_CLI_CONFIG_PATH)) {
			config = JSON.parse(readFileSync(CASEDEV_CLI_CONFIG_PATH, "utf-8")) as Record<string, unknown>;
		}
		config.apiKey = apiKey;
		writeFileSync(CASEDEV_CLI_CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
		chmodSync(CASEDEV_CLI_CONFIG_PATH, 0o600);
	} catch {
		// Non-fatal — agent auth.json is the primary store.
	}
}

export function resolveCasedevEnvApiKey(): string | undefined {
	return process.env.CASEDEV_API_KEY || process.env.CASE_API_KEY || readCasedevCliKey();
}

export function applyCasedevEnvFromCliConfig(): void {
	if (process.env.CASEDEV_API_KEY || process.env.CASE_API_KEY) {
		return;
	}
	const cliKey = readCasedevCliKey();
	if (cliKey) {
		process.env.CASE_API_KEY = cliKey;
	}
}

export { CASEDEV_PROVIDER_ID };
