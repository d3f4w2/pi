import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { GitOverview } from "../src/extensions/git/types.ts";
import { showGitDashboard } from "../src/extensions/git/ui.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const overview: GitOverview = {
	repositoryRoot: "C:/repo",
	branch: "main",
	upstream: "origin/main",
	ahead: 1,
	behind: 0,
	files: [
		{
			path: "packages/coding-agent/src/extensions/git/very-long-file-name.ts",
			indexStatus: ".",
			worktreeStatus: "M",
			staged: false,
			unstaged: true,
			untracked: false,
			conflicted: false,
		},
	],
	truncated: false,
};

beforeAll(() => initTheme("dark"));

describe("git dashboard", () => {
	test("renders width-safe Chinese status and stages with the right arrow", async () => {
		const requestRender = vi.fn();
		const onStageChange = vi.fn(async () => ({
			...overview,
			files: [{ ...overview.files[0]!, indexStatus: "M", staged: true }],
		}));
		const component = showGitDashboard(
			overview,
			{ requestRender } as never,
			theme,
			new KeybindingsManager(),
			onStageChange,
			vi.fn(),
			vi.fn(),
		);

		const lines = component.render(50);
		expect(lines.join("\n")).toContain("Git 变更管理");
		expect(lines.every((line) => visibleWidth(line) <= 50)).toBe(true);

		component.handleInput?.("\x1b[C");
		await vi.waitFor(() => expect(onStageChange).toHaveBeenCalledWith(overview.files[0], true));
		expect(requestRender).toHaveBeenCalled();
	});
});
