import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../../core/extensions/types.ts";
import { ContextLifecycleService } from "./service.ts";
import {
	CONTEXT_REWIND_REPORT_TYPE,
	type ContextCheckpoint,
	type ContextLifecycleHost,
	type ContextRewindPreview,
	type ContextRuntimeSnapshot,
} from "./types.ts";

const ContextLifecycleParams = Type.Object(
	{
		action: Type.Union(
			[Type.Literal("create"), Type.Literal("list"), Type.Literal("preview"), Type.Literal("savings")],
			{
				description: "Create a checkpoint or inspect context-lifecycle state. Rewind and restore require /context.",
			},
		),
		checkpoint: Type.Optional(Type.String({ maxLength: 100 })),
		name: Type.Optional(Type.String({ maxLength: 80 })),
	},
	{ additionalProperties: false },
);

interface ContextLifecycleToolDetails {
	action: "create" | "list" | "preview" | "savings";
	checkpointId?: string;
	metrics?: ContextRewindPreview["metrics"];
}

function runtimeSnapshot(pi: ExtensionAPI, ctx: ExtensionContext): ContextRuntimeSnapshot {
	return {
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
		activeTools: pi.getActiveTools(),
		mode: ctx.mode,
		projectTrusted: ctx.isProjectTrusted(),
		approval: ctx.getToolApprovalSettings?.(),
	};
}

function leafId(ctx: ExtensionContext): string {
	const id = ctx.sessionManager.getLeafId();
	if (!id) throw new Error("Context lifecycle entry did not become the active session leaf");
	return id;
}

function createHost(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	commandContext?: ExtensionCommandContext,
): ContextLifecycleHost {
	return {
		cwd: ctx.cwd,
		sessionManager: ctx.sessionManager,
		getRuntimeSnapshot: () => runtimeSnapshot(pi, ctx),
		appendEntry: (customType, data) => {
			const previousLeafId = ctx.sessionManager.getLeafId();
			pi.appendEntry(customType, data);
			const entryId = leafId(ctx);
			const entry = ctx.sessionManager.getEntry(entryId);
			if (entryId === previousLeafId || entry?.type !== "custom" || entry.customType !== customType) {
				throw new Error(`Context lifecycle marker was not persisted: ${customType}`);
			}
			return entryId;
		},
		appendReport: (content, details) => {
			const previousLeafId = ctx.sessionManager.getLeafId();
			pi.sendMessage({
				customType: CONTEXT_REWIND_REPORT_TYPE,
				content,
				display: true,
				details,
			});
			const entryId = leafId(ctx);
			const entry = ctx.sessionManager.getEntry(entryId);
			if (
				entryId === previousLeafId ||
				entry?.type !== "custom_message" ||
				entry.customType !== CONTEXT_REWIND_REPORT_TYPE
			) {
				throw new Error("Context rewind report was not persisted synchronously");
			}
			return entryId;
		},
		navigateTree: async (targetId) => {
			if (!commandContext) throw new Error("Context mutation requires an explicit /context command");
			return commandContext.navigateTree(targetId, { summarize: false });
		},
	};
}

function checkpointLabel(checkpoint: ContextCheckpoint): string {
	const name = checkpoint.data.name ? `${checkpoint.data.name} — ` : "";
	return `${name}${checkpoint.data.id.slice(0, 8)} · ${checkpoint.data.estimatedInputTokens.toLocaleString()} tokens`;
}

function formatCheckpointList(checkpoints: readonly ContextCheckpoint[]): string {
	if (checkpoints.length === 0) return "当前会话没有 checkpoint。";
	return [
		`Checkpoints (${checkpoints.length}/20)`,
		...checkpoints.map(
			(checkpoint) =>
				`- ${checkpointLabel(checkpoint)} · ${checkpoint.data.activeMessageCount} messages · branch ${checkpoint.data.gitBranch ?? "unknown"}`,
		),
	].join("\n");
}

function formatPreview(preview: ContextRewindPreview): string {
	const metrics = preview.metrics;
	return [
		`Checkpoint: ${preview.checkpoint.data.name ?? preview.checkpoint.data.id}`,
		`将移出活动上下文: ${metrics.messagesRemoved} 条消息`,
		`预计 Token: ${metrics.estimatedInputTokensBefore.toLocaleString()} → ${metrics.estimatedInputTokensAfter.toLocaleString()} (-${metrics.tokenReductionPercent.toFixed(1)}%)`,
		`必须保留的证据: ${metrics.deterministicEvidenceRetained}/${metrics.deterministicEvidenceTotal}`,
		`用户消息: ${metrics.userMessagesRetained}/${metrics.userMessagesTotal}`,
		`Prompt cache 可复用前缀: ${metrics.promptCacheReusablePrefixMessages} 条 / ${metrics.promptCacheReusablePrefixTokens.toLocaleString()} tokens`,
		`可以恢复: ${metrics.recoverable ? "是" : "否"}`,
		"",
		preview.report.text,
	].join("\n");
}

function formatSavings(service: ContextLifecycleService, ctx: ExtensionContext): string {
	const savings = service.getSavings(ctx.sessionManager);
	return [
		`Rewind views: ${savings.views}`,
		`Estimated tokens removed: ${savings.estimatedTokensRemoved.toLocaleString()}`,
		`Average reduction: ${savings.averageReductionPercent.toFixed(1)}%`,
		`Deterministic evidence retention: ${savings.evidenceRetentionPercent.toFixed(1)}%`,
		`User message retention: ${savings.userMessageRetentionPercent.toFixed(1)}%`,
	].join("\n");
}

async function chooseCheckpoint(
	service: ContextLifecycleService,
	ctx: ExtensionCommandContext,
): Promise<string | undefined> {
	const checkpoints = service.listCheckpoints(ctx.sessionManager);
	if (checkpoints.length === 0) return undefined;
	const labels = checkpoints.map(checkpointLabel);
	const selected = await ctx.ui.select("选择 checkpoint", labels);
	const index = selected ? labels.indexOf(selected) : -1;
	return index >= 0 ? checkpoints[index].data.id : undefined;
}

async function handleCommand(
	pi: ExtensionAPI,
	service: ContextLifecycleService,
	rawArgs: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const [rawAction, ...argumentParts] = rawArgs.trim().split(/\s+/u);
	let action = rawAction.toLowerCase();
	let argument = argumentParts.join(" ").trim();

	if (!action) {
		if (!ctx.hasUI) {
			ctx.ui.notify(
				"用法: /context create [name] | list | delete <checkpoint> | preview <checkpoint> | rewind <checkpoint> | restore [view] | savings",
				"info",
			);
			return;
		}
		const options = ["创建检查点", "查看检查点", "精简到检查点", "恢复完整上下文", "查看节省量"];
		const selected = await ctx.ui.select("上下文生命周期", options);
		if (!selected) return;
		const selectedActions = new Map([
			["创建检查点", "create"],
			["查看检查点", "list"],
			["精简到检查点", "rewind"],
			["恢复完整上下文", "restore"],
			["查看节省量", "savings"],
		]);
		action = selectedActions.get(selected) ?? "";
		if (action === "create") {
			argument = (await ctx.ui.input("Checkpoint 名称", "可选，最多 80 个字符"))?.trim() ?? "";
		}
	}

	const host = createHost(pi, ctx, ctx);
	if (action === "create") {
		await ctx.waitForIdle();
		const checkpoint = await service.createCheckpoint(host, argument || undefined);
		ctx.ui.notify(`已创建 checkpoint: ${checkpointLabel(checkpoint)}`, "info");
		return;
	}
	if (action === "list" || action === "view") {
		ctx.ui.notify(formatCheckpointList(service.listCheckpoints(ctx.sessionManager)), "info");
		return;
	}
	if (action === "savings") {
		ctx.ui.notify(formatSavings(service, ctx), "info");
		return;
	}
	if (action === "delete") {
		if (!ctx.hasUI) {
			ctx.ui.notify("删除 checkpoint 需要确认 UI；当前模式失败关闭。", "error");
			return;
		}
		if (!argument) argument = (await chooseCheckpoint(service, ctx)) ?? "";
		if (!argument) return;
		const confirmed = await ctx.ui.confirm("删除 checkpoint？", "只追加删除标记，不删除完整会话历史。");
		if (!confirmed) return;
		const checkpoint = service.deleteCheckpoint(host, argument);
		ctx.ui.notify(`已删除 checkpoint: ${checkpoint.data.name ?? checkpoint.data.id}`, "info");
		return;
	}
	if (action === "preview" || action === "rewind") {
		await ctx.waitForIdle();
		if (!argument) argument = (await chooseCheckpoint(service, ctx)) ?? "";
		if (!argument) return;
		const preview = await service.preview(host, argument);
		if (action === "preview") {
			ctx.ui.notify(formatPreview(preview), "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("Rewind 需要确认 UI 或协议审批；当前模式失败关闭。", "error");
			return;
		}
		const confirmed = await ctx.ui.confirm("应用 context rewind？", formatPreview(preview));
		if (!confirmed) return;
		const view = await service.apply(host, preview);
		ctx.ui.notify(
			`已切换活动上下文，预计减少 ${view.data.metrics.estimatedTokensRemoved.toLocaleString()} tokens；可用 /context restore 恢复。`,
			"info",
		);
		return;
	}
	if (action === "restore") {
		if (!ctx.hasUI) {
			ctx.ui.notify("恢复完整上下文需要确认 UI 或协议审批；当前模式失败关闭。", "error");
			return;
		}
		await ctx.waitForIdle();
		const preview = await service.previewRestore(host, argument || undefined);
		const confirmed = await ctx.ui.confirm(
			"恢复完整上下文？",
			`将恢复 rewind 前的完整活动分支。当前 rewind 分支仍保留在会话树中。\n预计恢复消息: ${preview.view.data.metrics.activeMessagesBefore}`,
		);
		if (!confirmed) return;
		const result = await service.restore(host, preview);
		ctx.ui.notify(`已恢复完整上下文，耗时 ${result.metrics.restoreDurationMs.toFixed(1)} ms。`, "info");
		return;
	}

	ctx.ui.notify(`未知 /context 操作: ${action}`, "error");
}

export function createContextLifecycleExtension(service: ContextLifecycleService): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.registerTool<typeof ContextLifecycleParams, ContextLifecycleToolDetails>({
			name: "context_lifecycle",
			label: "上下文生命周期",
			description:
				"创建探索 checkpoint，或只读查看 checkpoint、rewind 预览和 Token 节省。不能应用 rewind 或恢复；这些操作必须由用户运行 /context 并确认。",
			discovery: {
				keywords: ["checkpoint", "rewind context", "上下文检查点", "精简上下文", "恢复完整上下文"],
			},
			parameters: ContextLifecycleParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const host = createHost(pi, ctx);
				if (params.action === "create") {
					const checkpoint = await service.createCheckpoint(host, params.name);
					return {
						content: [{ type: "text", text: `Created checkpoint ${checkpointLabel(checkpoint)}` }],
						details: { action: params.action, checkpointId: checkpoint.data.id },
					};
				}
				if (params.action === "list") {
					return {
						content: [{ type: "text", text: formatCheckpointList(service.listCheckpoints(ctx.sessionManager)) }],
						details: { action: params.action },
					};
				}
				if (params.action === "savings") {
					return {
						content: [{ type: "text", text: formatSavings(service, ctx) }],
						details: { action: params.action },
					};
				}
				const preview = await service.preview(host, params.checkpoint);
				return {
					content: [
						{
							type: "text",
							text: `${formatPreview(preview)}\n\nPreview only. The model cannot apply rewind; the user must run /context rewind and confirm.`,
						},
					],
					details: {
						action: params.action,
						checkpointId: preview.checkpoint.data.id,
						metrics: preview.metrics,
					},
				};
			},
		});

		pi.registerCommand("context", {
			description: "创建、查看、精简或恢复活动上下文",
			handler: async (args, ctx) => {
				try {
					await handleCommand(pi, service, args, ctx);
				} catch (error) {
					ctx.ui.notify(`上下文操作失败: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			},
		});
	};
}

export default createContextLifecycleExtension(new ContextLifecycleService());
