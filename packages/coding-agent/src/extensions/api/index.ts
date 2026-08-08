import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig } from "../../core/extensions/types.ts";
import { ApiProviderStorage } from "./storage.ts";
import {
	type ApiActivation,
	type ApiModelDraft,
	type ApiProviderDraft,
	createNewProviderDraft,
	createThinkingLevelMap,
	getMaximumThinkingLevel,
	getSupportedThinkingLevels,
	MAX_THINKING_LEVELS,
	PROVIDER_API_OPTIONS,
	type ProviderApi,
} from "./types.ts";
import { type ApiDashboardResult, showApiDashboard } from "./ui.ts";

const API_LABELS: Record<ProviderApi, string> = {
	"openai-responses": "OpenAI Responses",
	"openai-completions": "OpenAI Chat Completions",
	"anthropic-messages": "Anthropic Messages",
};

function isValidProviderId(value: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(value);
}

function formatModel(model: ApiModelDraft): string {
	const capabilities = [
		model.input.includes("image") ? "图片" : undefined,
		model.reasoning ? `思考至 ${getMaximumThinkingLevel(model)}` : undefined,
	]
		.filter((value) => value !== undefined)
		.join("，");
	return capabilities ? `${model.name}（${capabilities}）` : model.name;
}

function toProviderConfig(draft: ApiProviderDraft): ProviderConfig {
	return {
		name: draft.name,
		baseUrl: draft.baseUrl,
		api: draft.api,
		authHeader: true,
		models: draft.models.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			thinkingLevelMap: model.thinkingLevelMap,
			input: model.input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		})),
	};
}

async function inputValue(
	ctx: ExtensionCommandContext,
	title: string,
	prefill: string,
	options: { mask?: boolean; allowEmpty?: boolean } = {},
): Promise<string | undefined> {
	const value = await ctx.ui.input(title, undefined, { prefill, mask: options.mask });
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!options.allowEmpty && trimmed.length === 0) {
		ctx.ui.notify("此项不能为空。", "warning");
		return inputValue(ctx, title, prefill, options);
	}
	return trimmed;
}

async function selectApi(ctx: ExtensionCommandContext, current: ProviderApi): Promise<ProviderApi | undefined> {
	const choices = PROVIDER_API_OPTIONS.map((api) => `${API_LABELS[api]}${api === current ? "（当前）" : ""}`);
	const value = await ctx.ui.select("选择 API 协议", choices);
	if (value === undefined) return undefined;
	return PROVIDER_API_OPTIONS[choices.indexOf(value)];
}

async function editProviderDetails(ctx: ExtensionCommandContext, draft: ApiProviderDraft): Promise<boolean> {
	while (true) {
		const providerId = await inputValue(ctx, "供应商标识（仅字母、数字、点、下划线、短横线）", draft.id);
		if (providerId === undefined) return false;
		if (!isValidProviderId(providerId)) {
			ctx.ui.notify("供应商标识格式无效。", "warning");
			continue;
		}
		draft.id = providerId;
		break;
	}

	const name = await inputValue(ctx, "供应商名称", draft.name || draft.id);
	if (name === undefined) return false;
	draft.name = name;

	const api = await selectApi(ctx, draft.api);
	if (api === undefined) return false;
	draft.api = api;

	while (true) {
		const baseUrl = await inputValue(ctx, "Base URL", draft.baseUrl);
		if (baseUrl === undefined) return false;
		try {
			const parsed = new URL(baseUrl);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
			draft.baseUrl = baseUrl.replace(/\/+$/u, "");
			break;
		} catch {
			ctx.ui.notify("Base URL 必须是 http 或 https 地址。", "warning");
		}
	}

	const keyTitle = draft.hasStoredApiKey || draft.apiKey ? "API Key（留空保留当前 Key）" : "API Key";
	const apiKey = await inputValue(ctx, keyTitle, "", { mask: true, allowEmpty: true });
	if (apiKey === undefined) return false;
	if (apiKey.length > 0) draft.apiKey = apiKey;
	return true;
}

async function editModel(ctx: ExtensionCommandContext, initial?: ApiModelDraft): Promise<ApiModelDraft | undefined> {
	const draft: ApiModelDraft = initial
		? structuredClone(initial)
		: {
				id: "",
				name: "",
				reasoning: false,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 16_384,
			};
	const id = await inputValue(ctx, "模型 ID", draft.id);
	if (id === undefined) return undefined;
	draft.id = id;
	const name = await inputValue(ctx, "模型显示名称", draft.name || draft.id);
	if (name === undefined) return undefined;
	draft.name = name;

	const image = await ctx.ui.select("是否支持图片输入", [
		`否${draft.input.includes("image") ? "" : "（当前）"}`,
		`是${draft.input.includes("image") ? "（当前）" : ""}`,
	]);
	if (image === undefined) return undefined;
	draft.input = image.startsWith("是") ? ["text", "image"] : ["text"];

	const reasoning = await ctx.ui.select("是否支持思考", [
		`否${draft.reasoning ? "" : "（当前）"}`,
		`是${draft.reasoning ? "（当前）" : ""}`,
	]);
	if (reasoning === undefined) return undefined;
	draft.reasoning = reasoning.startsWith("是");
	if (draft.reasoning) {
		const currentMaximum = getMaximumThinkingLevel(draft) ?? "high";
		const levels = MAX_THINKING_LEVELS.map((level) => `${level}${level === currentMaximum ? "（当前）" : ""}`);
		const maximum = await ctx.ui.select("最大思考等级", levels);
		if (maximum === undefined) return undefined;
		draft.thinkingLevelMap = createThinkingLevelMap(maximum.replace("（当前）", "") as Exclude<ThinkingLevel, "off">);
	} else {
		draft.thinkingLevelMap = undefined;
	}

	while (true) {
		const contextWindow = await inputValue(ctx, "上下文窗口（token）", String(draft.contextWindow));
		if (contextWindow === undefined) return undefined;
		const parsed = Number(contextWindow);
		if (Number.isInteger(parsed) && parsed > 0) {
			draft.contextWindow = parsed;
			break;
		}
		ctx.ui.notify("上下文窗口必须是正整数。", "warning");
	}
	while (true) {
		const maxTokens = await inputValue(ctx, "最大输出 token", String(draft.maxTokens));
		if (maxTokens === undefined) return undefined;
		const parsed = Number(maxTokens);
		if (Number.isInteger(parsed) && parsed > 0) {
			draft.maxTokens = parsed;
			break;
		}
		ctx.ui.notify("最大输出 token 必须是正整数。", "warning");
	}
	return draft;
}

async function editModels(ctx: ExtensionCommandContext, draft: ApiProviderDraft): Promise<boolean> {
	while (true) {
		const choices = [...draft.models.map(formatModel), "新增模型", "返回"];
		const selected = await ctx.ui.select("配置模型（可连续添加多个）", choices);
		if (selected === undefined || selected === "返回") return draft.models.length > 0;
		if (selected === "新增模型") {
			const model = await editModel(ctx);
			if (model) draft.models.push(model);
			continue;
		}
		const index = draft.models.findIndex((model) => formatModel(model) === selected);
		const current = draft.models[index];
		if (!current) continue;
		const action = await ctx.ui.select("模型操作", ["编辑", "删除", "返回"]);
		if (action === "编辑") {
			const model = await editModel(ctx, current);
			if (model) draft.models[index] = model;
		} else if (action === "删除") {
			draft.models.splice(index, 1);
		}
	}
}

async function selectActivation(
	ctx: ExtensionCommandContext,
	draft: ApiProviderDraft,
): Promise<ApiActivation | undefined> {
	const modelNames = draft.models.map(formatModel);
	const selected = await ctx.ui.select("保存后切换到模型", modelNames);
	if (selected === undefined) return undefined;
	const model = draft.models[modelNames.indexOf(selected)];
	if (!model) return undefined;
	const levels = getSupportedThinkingLevels(model);
	const currentLevel =
		ctx.thinkingLevel && levels.includes(ctx.thinkingLevel) ? ctx.thinkingLevel : (levels[0] ?? "off");
	const options = levels.map((level) => `${level}${level === currentLevel ? "（当前）" : ""}`);
	const level = await ctx.ui.select("思考等级", options);
	if (level === undefined) return undefined;
	return { modelId: model.id, thinkingLevel: level.replace("（当前）", "") as ThinkingLevel };
}

async function editProvider(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	initial: ApiProviderDraft,
): Promise<ApiActivation | undefined> {
	const draft = structuredClone(initial);
	while (true) {
		const action = await ctx.ui.select("API 配置", ["修改供应商信息", "编辑模型", "保存并切换", "取消"]);
		if (action === undefined || action === "取消") return undefined;
		if (action === "修改供应商信息") {
			if (!(await editProviderDetails(ctx, draft))) return undefined;
			continue;
		}
		if (action === "编辑模型") {
			if (!(await editModels(ctx, draft))) {
				ctx.ui.notify("至少需要配置一个模型。", "warning");
			}
			continue;
		}
		if (draft.models.length === 0) {
			ctx.ui.notify("至少需要配置一个模型。", "warning");
			continue;
		}
		if (!draft.hasStoredApiKey && !draft.apiKey) {
			ctx.ui.notify("请先输入 API Key。", "warning");
			continue;
		}
		const activation = await selectActivation(ctx, draft);
		if (!activation) continue;
		await ctx.waitForIdle();
		const storage = new ApiProviderStorage();
		await storage.saveProvider(draft);

		const sourceId = draft.sourceId;
		const storedApiKey =
			!draft.apiKey && sourceId && sourceId !== draft.id && draft.hasStoredApiKey
				? await ctx.modelRegistry.getApiKeyForProvider(sourceId)
				: undefined;
		if (sourceId && sourceId !== draft.id) {
			ctx.modelRegistry.unregisterProvider(sourceId);
			await ctx.modelRegistry.deleteApiKey(sourceId);
		}
		if (draft.apiKey) await ctx.modelRegistry.setApiKey(draft.id, draft.apiKey);
		else if (storedApiKey) await ctx.modelRegistry.setApiKey(draft.id, storedApiKey);

		pi.registerProvider(draft.id, toProviderConfig(draft));
		await ctx.modelRegistry.refresh();
		const model = ctx.modelRegistry.find(draft.id, activation.modelId);
		if (!model) {
			ctx.ui.notify("配置已保存，但模型尚未加载；请检查 models.json 格式。", "warning");
			return activation;
		}
		if (!(await pi.setModel(model))) {
			ctx.ui.notify("配置已保存，但未能切换模型；请检查 API Key。", "warning");
			return activation;
		}
		pi.setThinkingLevel(activation.thinkingLevel);
		return activation;
	}
}

async function chooseDashboard(
	ctx: ExtensionCommandContext,
	providers: readonly ApiProviderDraft[],
): Promise<ApiDashboardResult> {
	if (ctx.mode !== "tui") {
		const choices = ["新增供应商", ...providers.map((provider) => provider.name), "关闭"];
		const selected = await ctx.ui.select("API 供应商管理", choices);
		if (selected === "新增供应商") return { type: "new" };
		if (selected === "关闭" || selected === undefined) return { type: "close" };
		const provider = providers.find((entry) => entry.name === selected);
		return provider ? { type: "edit", providerId: provider.id } : { type: "close" };
	}
	return ctx.ui.custom((tui, theme, keybindings, done) => showApiDashboard(tui, theme, keybindings, providers, done));
}

export default function apiExtension(pi: ExtensionAPI): void {
	pi.registerCommand("api", {
		description: "管理第三方 API 供应商并立即切换模型",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/api 需要交互式 UI。", "warning");
				return;
			}
			const storage = new ApiProviderStorage();
			while (true) {
				let providers: ApiProviderDraft[];
				try {
					providers = await storage.listProviders();
					for (const provider of providers) {
						provider.hasStoredApiKey = ctx.modelRegistry.getProviderAuthStatus(provider.id).source === "stored";
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return;
				}
				const selection = await chooseDashboard(ctx, providers);
				if (selection.type === "close") return;
				const initial =
					selection.type === "new"
						? createNewProviderDraft()
						: providers.find((provider) => provider.id === selection.providerId);
				if (!initial) continue;
				await editProvider(pi, ctx, initial);
			}
		},
	});
}
