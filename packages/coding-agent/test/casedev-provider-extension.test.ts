import { afterEach, describe, expect, it, vi } from "vitest";
import { CASEDEV_PROVIDER_ID } from "../src/casedev/constants.js";
import { createCasedevExtension } from "../src/casedev/provider.js";

const savedEnv = {
	CASEDEV_API_KEY: process.env.CASEDEV_API_KEY,
	CASE_API_KEY: process.env.CASE_API_KEY,
	CORE_ACCESS_TOKEN: process.env.CORE_ACCESS_TOKEN,
};

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("createCasedevExtension", () => {
	it("registers the provider without adding fixed Case.dev tools", async () => {
		delete process.env.CASEDEV_API_KEY;
		delete process.env.CASE_API_KEY;
		delete process.env.CORE_ACCESS_TOKEN;

		const registerProvider = vi.fn();
		const registerTool = vi.fn();
		const extension = createCasedevExtension({ getApiKey: () => undefined });

		await extension({ registerProvider, registerTool } as never);

		expect(registerProvider).toHaveBeenCalledTimes(1);
		expect(registerProvider).toHaveBeenCalledWith(CASEDEV_PROVIDER_ID, expect.objectContaining({ name: "case.dev" }));
		expect(registerTool).not.toHaveBeenCalled();
	});
});
