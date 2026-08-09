import { beforeAll, describe, expect, test } from "vitest";
import { createFileDiff } from "../src/core/tools/edit-diff.ts";
import { renderFileDiff } from "../src/modes/interactive/components/diff.ts";
import { setLanguageSetting } from "../src/modes/interactive/i18n/index.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("shared file diff", () => {
	beforeAll(() => initTheme("dark"));

	test("reports file state and line statistics", () => {
		const diff = createFileDiff("src/example.ts", "const a = 1;\n", "const a = 2;\nconst b = 3;\n");

		expect(diff).toMatchObject({
			path: "src/example.ts",
			status: "modified",
			additions: 2,
			deletions: 1,
			firstChangedLine: 1,
		});
	});

	test("renders a file header, statistics, and changed lines", () => {
		const rendered = renderFileDiff(createFileDiff("src/example.ts", "const value = 1;\n", "const value = 2;\n"), {
			expanded: true,
		});

		expect(rendered).toContain("src/example.ts");
		expect(rendered).toContain("+1");
		expect(rendered).toContain("-1");
		expect(rendered).toContain("const value = 1");
		expect(rendered).toContain("const value = 2");
	});

	test("folds a large diff in compact mode without hiding its totals", () => {
		const oldContent = Array.from({ length: 120 }, (_, index) => `before ${index}`).join("\n");
		const newContent = Array.from({ length: 120 }, (_, index) => `after ${index}`).join("\n");
		const rendered = renderFileDiff(createFileDiff("large.ts", oldContent, newContent), {
			expanded: false,
			maxLines: 20,
		});

		expect(rendered).toContain("large.ts");
		expect(rendered).toContain("+120");
		expect(rendered).toContain("-120");
		expect(rendered).toContain("folded");
		expect(rendered.split("\n").length).toBeLessThanOrEqual(23);
	});

	test("labels a newly created file", () => {
		const rendered = renderFileDiff(createFileDiff("new.ts", null, "export {};\n"), { expanded: true });
		expect(rendered).toContain("Created");
		expect(rendered).toContain("+1");
	});

	test("renders file status in Chinese when selected", () => {
		setLanguageSetting("zh-CN");
		try {
			expect(renderFileDiff(createFileDiff("new.ts", null, "export {};\n"), { expanded: true })).toContain("新建");
		} finally {
			setLanguageSetting("en");
		}
	});
});
