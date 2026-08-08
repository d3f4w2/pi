import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { FileAuthStorageBackend } from "../../core/auth-storage.ts";
import { stripJsonComments } from "../../utils/json.ts";
import type { ApiModelDraft, ApiProviderDraft, ProviderApi } from "./types.ts";
import { isProviderApi } from "./types.ts";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseModel(value: unknown): ApiModelDraft | undefined {
	if (!isRecord(value)) return undefined;
	const id = readString(value.id);
	if (!id) return undefined;
	const input: ("text" | "image")[] = Array.isArray(value.input)
		? value.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
		: ["text"];
	return {
		id,
		name: readString(value.name) ?? id,
		reasoning: readBoolean(value.reasoning) ?? false,
		input: input.includes("text") ? input : ["text", ...input],
		thinkingLevelMap: isRecord(value.thinkingLevelMap)
			? Object.fromEntries(
					Object.entries(value.thinkingLevelMap).filter(
						([, mapped]) => typeof mapped === "string" || mapped === null,
					),
				)
			: undefined,
		contextWindow: readNumber(value.contextWindow) ?? 128_000,
		maxTokens: readNumber(value.maxTokens) ?? 16_384,
	};
}

function parseProvider(id: string, value: unknown): ApiProviderDraft | undefined {
	if (!isRecord(value)) return undefined;
	const api = readString(value.api);
	const baseUrl = readString(value.baseUrl);
	if (!isProviderApi(api) || !baseUrl) return undefined;
	const models = Array.isArray(value.models)
		? value.models.map(parseModel).filter((model) => model !== undefined)
		: [];
	return {
		id,
		name: readString(value.name) ?? id,
		baseUrl,
		api,
		models,
		hasStoredApiKey: false,
		sourceId: id,
	};
}

function parseModelsFile(content: string | undefined): JsonRecord {
	if (!content || content.trim().length === 0) return { providers: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(content));
	} catch (error) {
		throw new Error(`无法读取 models.json：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new Error("models.json 根节点必须是对象。");
	if (parsed.providers !== undefined && !isRecord(parsed.providers)) {
		throw new Error("models.json 的 providers 必须是对象。");
	}
	return parsed;
}

function serializeModel(model: ApiModelDraft): JsonRecord {
	return {
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
		input: model.input,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

export class ApiProviderStorage {
	private readonly storage: FileAuthStorageBackend;

	constructor(modelsPath: string = join(getAgentDir(), "models.json")) {
		this.storage = new FileAuthStorageBackend(modelsPath);
	}

	async listProviders(): Promise<ApiProviderDraft[]> {
		return this.storage.withLockAsync(async (content) => {
			const file = parseModelsFile(content);
			const providers = isRecord(file.providers) ? file.providers : {};
			return {
				result: Object.entries(providers)
					.map(([id, provider]) => parseProvider(id, provider))
					.filter((provider): provider is ApiProviderDraft => provider !== undefined)
					.sort((left, right) => left.name.localeCompare(right.name)),
			};
		});
	}

	async saveProvider(draft: ApiProviderDraft): Promise<void> {
		await this.storage.withLockAsync(async (content) => {
			const file = parseModelsFile(content);
			const providers = isRecord(file.providers) ? file.providers : {};
			const existingValue = providers[draft.id];
			const existing: JsonRecord = isRecord(existingValue) ? existingValue : {};
			if (draft.sourceId && draft.sourceId !== draft.id) delete providers[draft.sourceId];
			providers[draft.id] = {
				...existing,
				name: draft.name,
				baseUrl: draft.baseUrl,
				api: draft.api as ProviderApi,
				authHeader: true,
				models: draft.models.map(serializeModel),
			};
			file.providers = providers;
			return { result: undefined, next: `${JSON.stringify(file, null, 2)}\n` };
		});
	}
}
