import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../core/model-registry.js";
import { CASEDEV_DEFAULT_MODEL_ID, CASEDEV_PROVIDER_ID } from "./constants.js";

type ProviderLoginResult =
	| { status: "success"; providerId: string; kind?: "provider" | "service" }
	| { status: "cancelled" | "failed" };

export interface CasedevPostLoginModelAction {
	openModelPicker: boolean;
	fallbackModel?: Model<Api>;
}

export function resolveCasedevPostLoginModelAction(
	authResult: ProviderLoginResult,
	currentModel: Model<Api> | undefined,
	modelRegistry: Pick<ModelRegistry, "find" | "getAll">,
): CasedevPostLoginModelAction {
	if (
		authResult.status !== "success" ||
		authResult.kind === "service" ||
		authResult.providerId !== CASEDEV_PROVIDER_ID
	) {
		return { openModelPicker: false };
	}

	const preferred =
		modelRegistry.find(CASEDEV_PROVIDER_ID, CASEDEV_DEFAULT_MODEL_ID) ??
		modelRegistry.getAll().find((model) => model.provider === CASEDEV_PROVIDER_ID);

	return {
		openModelPicker: true,
		fallbackModel: currentModel ? undefined : preferred,
	};
}
