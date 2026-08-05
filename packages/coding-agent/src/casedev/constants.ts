import { homedir } from "node:os";
import { join } from "node:path";

export const CASEDEV_PROVIDER_ID = "casedev";
export const CASEDEV_PROVIDER_NAME = "case.dev";
export const CASEDEV_API_BASE = process.env.CASEDEV_API_BASE_URL || "https://api.case.dev";
/**
 * Callers configure CASEDEV_API_BASE_URL either as an API root
 * (`https://api.case.dev`) or as an already-qualified OpenAI-compatible base
 * (`http://app:8787/llm/v1`, which is what the Bastion appliance injects into
 * agent sandboxes). Only append the LLM path when it is not already there, so
 * both shapes resolve to a single `/llm/v1` segment instead of 404ing on
 * `/llm/v1/llm/v1/chat/completions`.
 */
const CASEDEV_LLM_PATH = "/llm/v1";
const casedevApiRoot = CASEDEV_API_BASE.replace(/\/+$/, "");
export const CASEDEV_LLM_BASE = casedevApiRoot.endsWith(CASEDEV_LLM_PATH)
	? casedevApiRoot
	: `${casedevApiRoot}${CASEDEV_LLM_PATH}`;
export const CASEDEV_DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4.5";
export const CASEDEV_CLI_CONFIG_PATH = join(homedir(), ".config", "case", "config.json");
