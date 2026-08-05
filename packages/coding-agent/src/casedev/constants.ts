import { homedir } from "node:os";
import { join } from "node:path";

export const CASEDEV_PROVIDER_ID = "casedev";
export const CASEDEV_PROVIDER_NAME = "case.dev";
export const CASEDEV_API_BASE = process.env.CASEDEV_API_BASE_URL || "https://api.case.dev";
export const CASEDEV_LLM_BASE = `${CASEDEV_API_BASE.replace(/\/+$/, "")}/llm/v1`;
export const CASEDEV_DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4.5";
export const CASEDEV_CLI_CONFIG_PATH = join(homedir(), ".config", "case", "config.json");
