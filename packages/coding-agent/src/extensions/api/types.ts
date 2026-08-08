import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ThinkingLevelMap } from "@earendil-works/pi-ai";

export const PROVIDER_API_OPTIONS = [
	"openai-responses",
	"openai-completions",
	"anthropic-messages",
] as const satisfies readonly Api[];

export type ProviderApi = (typeof PROVIDER_API_OPTIONS)[number];

export interface ApiModelDraft {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	thinkingLevelMap?: ThinkingLevelMap;
	contextWindow: number;
	maxTokens: number;
}

export interface ApiProviderDraft {
	id: string;
	name: string;
	baseUrl: string;
	api: ProviderApi;
	models: ApiModelDraft[];
	apiKey?: string;
	hasStoredApiKey: boolean;
	sourceId?: string;
}

export interface ApiActivation {
	modelId: string;
	thinkingLevel: ThinkingLevel;
}

export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const MAX_THINKING_LEVELS: readonly Exclude<ThinkingLevel, "off">[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export function isProviderApi(value: string | undefined): value is ProviderApi {
	return PROVIDER_API_OPTIONS.includes(value as ProviderApi);
}

export function suggestOpenAIBaseUrl(api: ProviderApi, baseUrl: string): string | undefined {
	if (api !== "openai-responses" && api !== "openai-completions") return undefined;
	try {
		const parsed = new URL(baseUrl);
		if (parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
		parsed.pathname = "/v1";
		return parsed.toString();
	} catch {
		return undefined;
	}
}

export function createThinkingLevelMap(maxLevel: Exclude<ThinkingLevel, "off">): ThinkingLevelMap {
	const map: ThinkingLevelMap = {};
	const maxIndex = MAX_THINKING_LEVELS.indexOf(maxLevel);
	for (const level of MAX_THINKING_LEVELS.slice(maxIndex + 1)) {
		map[level] = null;
	}
	if (maxIndex >= MAX_THINKING_LEVELS.indexOf("xhigh")) map.xhigh = "xhigh";
	if (maxLevel === "max") map.max = "max";
	return map;
}

export function getMaximumThinkingLevel(model: ApiModelDraft): Exclude<ThinkingLevel, "off"> | undefined {
	if (!model.reasoning) return undefined;
	for (const level of [...MAX_THINKING_LEVELS].reverse()) {
		if (model.thinkingLevelMap?.[level] !== null) return level;
	}
	return "high";
}

export function getSupportedThinkingLevels(model: ApiModelDraft): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	const maximum = getMaximumThinkingLevel(model) ?? "high";
	const maximumIndex = MAX_THINKING_LEVELS.indexOf(maximum);
	return ["off", ...MAX_THINKING_LEVELS.slice(0, maximumIndex + 1)];
}

export function createNewProviderDraft(): ApiProviderDraft {
	return {
		id: "",
		name: "",
		baseUrl: "",
		api: "openai-responses",
		models: [],
		hasStoredApiKey: false,
	};
}
