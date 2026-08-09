import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { TurnUndoService } from "./service.ts";
import type {
	TurnUndoBeginResult,
	TurnUndoCapture,
	TurnUndoFinalizeResult,
	TurnUndoResult,
	TurnUndoSnapshot,
} from "./types.ts";

export interface TurnUndoOperations {
	begin(cwd: string, sessionId: string): Promise<TurnUndoBeginResult>;
	finalize(capture: TurnUndoCapture): Promise<TurnUndoFinalizeResult>;
	getLatest(cwd: string): Promise<TurnUndoSnapshot | undefined>;
	undoLatest(cwd: string): Promise<TurnUndoResult>;
	release(capture: Pick<TurnUndoCapture, "workspaceDirectory" | "lockToken">): void;
}

function displayPath(path: string): string {
	return path.length <= 90 ? path : `…${path.slice(-89)}`;
}

function formatPreview(snapshot: TurnUndoSnapshot): string {
	const visible = snapshot.files.slice(0, 12).map((file) => {
		const label = file.kind === "modified" ? "修改" : file.kind === "created" ? "新建" : "删除";
		const effect = file.kind === "created" ? "（撤销时删除）" : file.kind === "deleted" ? "（撤销时恢复）" : "";
		return `${label}  ${displayPath(file.path)}${effect}`;
	});
	if (snapshot.files.length > visible.length) visible.push(`另有 ${snapshot.files.length - visible.length} 个文件`);
	return [
		`将恢复最近一次代理运行涉及的 ${snapshot.files.length} 个文件：`,
		"",
		...visible,
		"",
		"代理运行期间的手动文件修改也会一起撤销。",
		"如果文件在运行结束后又被修改，系统会拒绝整次撤销。",
	].join("\n");
}

function notifyResult(ctx: ExtensionContext, result: TurnUndoResult): void {
	if (result.status === "restored") {
		ctx.ui.notify(
			`已撤销最近一次代理修改，共恢复 ${result.snapshot.files.length} 个文件。${result.warning ? `\n警告：${result.warning}` : ""}`,
			result.warning ? "warning" : "info",
		);
	} else if (result.status === "none") {
		ctx.ui.notify("没有可撤销的代理文件修改。", "warning");
	} else if (result.status === "conflict") {
		const paths = result.paths.slice(0, 8).map(displayPath).join("、");
		ctx.ui.notify(`撤销已取消：这些文件后来又被修改，未覆盖任何文件：${paths}`, "error");
	} else {
		ctx.ui.notify(`撤销失败：${result.reason}`, "error");
	}
}

export function createTurnUndoExtension(operations: TurnUndoOperations) {
	return (pi: ExtensionAPI): void => {
		let active: TurnUndoCapture | undefined;
		const warned = new Set<string>();

		pi.on("agent_start", async (_event, ctx) => {
			if (active) return;
			if (!ctx.isProjectTrusted()) {
				const reason = "项目尚未被信任，不会自动运行 Git 快照命令";
				if (ctx.hasUI && !warned.has(reason)) {
					warned.add(reason);
					ctx.ui.notify(`本回合无法创建撤销快照：${reason}`, "warning");
				}
				return;
			}
			const result = await operations.begin(ctx.cwd, ctx.sessionManager.getSessionId());
			if (result.status === "started") {
				active = result.capture;
				return;
			}
			if (ctx.hasUI && !warned.has(result.reason)) {
				warned.add(result.reason);
				ctx.ui.notify(`本回合无法创建撤销快照：${result.reason}`, "warning");
			}
		});

		pi.on("agent_settled", async (_event, ctx) => {
			const capture = active;
			active = undefined;
			if (!capture) return;
			const result = await operations.finalize(capture);
			if (!ctx.hasUI) return;
			if (result.status === "saved") {
				ctx.ui.notify(`已保存本回合 ${result.snapshot.files.length} 个文件的修改，需要时输入 /undo-turn。`, "info");
			} else if (result.status === "skipped") {
				ctx.ui.notify(`本回合没有可用的撤销快照：${result.reason}`, "warning");
			}
		});

		pi.on("session_shutdown", async () => {
			const capture = active;
			active = undefined;
			if (capture) await operations.finalize(capture);
		});

		pi.registerCommand("undo-turn", {
			description: "撤销最近一次代理运行修改的文件",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) {
					ctx.ui.notify("/undo-turn 需要交互界面确认，当前模式不会自动恢复文件。", "error");
					return;
				}
				await ctx.waitForIdle();
				const latest = await operations.getLatest(ctx.cwd);
				if (!latest) {
					ctx.ui.notify("没有可撤销的代理文件修改。", "warning");
					return;
				}
				const confirmed = await ctx.ui.confirm("撤销最近一次代理修改？", formatPreview(latest));
				if (!confirmed) return;
				notifyResult(ctx, await operations.undoLatest(ctx.cwd));
			},
		});
	};
}

export default createTurnUndoExtension(new TurnUndoService({ storageRoot: join(getAgentDir(), "turn-undo") }));
