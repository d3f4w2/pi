import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { getUiLanguage } from "../../modes/interactive/i18n/index.ts";
import type { MemoryStore, MemoryStoreSnapshot } from "./storage.ts";
import type { MemoryRecord, MemoryStatus, ProjectMemoryScope } from "./types.ts";

function text(chinese: string, english: string): string {
	return getUiLanguage() === "zh-CN" ? chinese : english;
}

function statusLabel(status: MemoryStatus): string {
	switch (status) {
		case "candidate":
			return text("待确认", "Pending");
		case "active":
			return text("当前", "Current");
		case "superseded":
			return text("旧版本", "Superseded");
		case "stale":
			return text("已失效", "Stale");
		case "rejected":
			return text("已拒绝", "Rejected");
	}
}

function recordLabel(record: MemoryRecord): string {
	const content = record.content.length <= 48 ? record.content : `${record.content.slice(0, 47)}…`;
	return `${record.claim.subject}.${record.claim.predicate} · ${content}`;
}

function evidenceLabel(record: MemoryRecord): string {
	const files = record.evidence
		.filter((item) => item.type === "file")
		.map((item) => `${item.path}${item.startLine ? `:${item.startLine}` : ""}`);
	return files.join("、") || text("用户确认", "User confirmation");
}

function details(record: MemoryRecord): string {
	return [
		`${text("状态", "Status")}：${statusLabel(record.status)}`,
		`${text("事实", "Claim")}：${record.claim.subject}.${record.claim.predicate} = ${record.claim.value}`,
		`${text("说明", "Content")}：${record.content}`,
		`${text("来源", "Source")}：${record.source === "user" ? text("用户", "User") : "Agent"}`,
		`${text("证据", "Evidence")}：${evidenceLabel(record)}`,
		`${text("可信度", "Confidence")}：${Math.round(record.confidence * 100)}%`,
		`${text("使用", "Usage")}：${text("召回", "recalled")} ${record.usage.recallCount} · ${text("有帮助", "helpful")} ${record.usage.helpfulCount} · ${text("有害", "harmful")} ${record.usage.harmfulCount}`,
		`ID：${record.id}`,
	].join("\n");
}

function recordsForCategory(
	snapshot: MemoryStoreSnapshot,
	category: "pending" | "current" | "history",
): MemoryRecord[] {
	if (category === "pending") return snapshot.records.filter((record) => record.status === "candidate");
	if (category === "current") return snapshot.records.filter((record) => record.status === "active");
	return snapshot.records.filter((record) => record.status !== "candidate" && record.status !== "active");
}

export async function showMemoryManager(
	store: MemoryStore,
	ctx: ExtensionCommandContext,
	scope: ProjectMemoryScope,
): Promise<void> {
	const snapshot = await store.list(scope);
	if (snapshot.records.length === 0) {
		ctx.ui.notify(
			text(
				"还没有记忆。你可以直接让 Agent 记住，也可以批准 Agent 提出的候选。",
				"No memories yet. Ask the agent to remember something or approve an agent proposal.",
			),
		);
		return;
	}

	const categories = [
		{ id: "pending" as const, label: text("待确认", "Pending") },
		{ id: "current" as const, label: text("当前记忆", "Current") },
		{ id: "history" as const, label: text("历史", "History") },
	];
	const options = categories.map((category) => {
		const count = recordsForCategory(snapshot, category.id).length;
		return `${category.label} · ${count}`;
	});
	const selectedCategory = await ctx.ui.select(
		text(`记忆 · ${snapshot.records.length} 条`, `Memory · ${snapshot.records.length} records`),
		options,
	);
	if (!selectedCategory) return;
	const category = categories[options.indexOf(selectedCategory)];
	if (!category) return;
	const records = recordsForCategory(snapshot, category.id);
	if (records.length === 0) {
		ctx.ui.notify(text("这里还没有内容。", "Nothing here yet."));
		return;
	}

	const recordOptions = records.map(recordLabel);
	const selectedRecord = await ctx.ui.select(category.label, recordOptions);
	if (!selectedRecord) return;
	const record = records[recordOptions.indexOf(selectedRecord)];
	if (!record) return;

	if (record.status === "candidate") {
		const approve = text("批准", "Approve");
		const reject = text("拒绝", "Reject");
		const action = await ctx.ui.select(details(record), [approve, reject, text("返回", "Back")]);
		if (action === approve) {
			if (!(await ctx.ui.confirm(text("批准这条记忆？", "Approve this memory?"), details(record)))) return;
			await store.approve(record.id, record.revision, scope);
			ctx.ui.notify(text("记忆已生效。", "Memory activated."));
			return;
		}
		if (action === reject) {
			await store.reject(record.id, record.revision, scope);
			ctx.ui.notify(text("候选已拒绝。", "Candidate rejected."));
		}
		return;
	}

	const forget = text("彻底删除", "Delete permanently");
	const action = await ctx.ui.select(details(record), [forget, text("返回", "Back")]);
	if (action !== forget) return;
	if (!(await ctx.ui.confirm(text("彻底删除？", "Delete permanently?"), details(record)))) return;
	await store.forget(record.id, record.revision, scope);
	ctx.ui.notify(text("记忆已删除。", "Memory deleted."));
}
