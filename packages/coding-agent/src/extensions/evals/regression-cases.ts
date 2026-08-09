import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessRegressionDraftQuality } from "./regression-quality.ts";
import type {
	ApprovedRegressionCase,
	EvalCategory,
	RecoveredFailureSignal,
	RegressionCaseStoreLike,
	RegressionCaseWriterLike,
	RegressionTestDraft,
} from "./types.ts";

const MAX_FILES = 2;
const MAX_TOTAL_CHARACTERS = 4_000;
const MAX_STEPS = 6;
const VALID_CATEGORIES = new Set<EvalCategory>([
	"navigation",
	"editing",
	"verification",
	"testing",
	"web",
	"process",
	"browser",
	"debugging",
	"fallback",
]);
const VALID_TEST_FRAMEWORKS = new Set(["node:test", "vitest", "pytest", "go test"]);
const SECRET_PATTERNS = [
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
	/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/i,
	/\bAKIA[A-Z0-9]{16}\b/,
	/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i,
];
const PRIVATE_PATH_PATTERNS = [/[A-Za-z]:\\Users\\[^\\\s]+/i, /\/(?:Users|home)\/[^/\s]+/];
const UNSAFE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function testLikePath(filePath: string): boolean {
	const normalized = filePath.replaceAll("\\", "/").toLowerCase();
	const name = normalized.slice(normalized.lastIndexOf("/") + 1);
	return (
		normalized.startsWith("test/") ||
		normalized.startsWith("tests/") ||
		normalized.includes("/test/") ||
		normalized.includes("/tests/") ||
		name.includes(".test.") ||
		name.includes(".spec.") ||
		name.startsWith("test_") ||
		name.endsWith("_test.go")
	);
}

function validateText(value: string, label: string): void {
	if (!value.trim()) throw new Error(`${label}不能为空。`);
	if (UNSAFE_CONTROL.test(value)) throw new Error(`${label}包含危险控制字符。`);
	if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) throw new Error(`${label}疑似包含密钥或凭据。`);
	if (PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(value))) throw new Error(`${label}包含用户绝对路径。`);
}

export function validateRegressionDraft(draft: RegressionTestDraft): RegressionTestDraft {
	validateText(draft.title, "测试标题");
	validateText(draft.expectedFailure, "修复前表现");
	validateText(draft.expectedSuccess, "修复后表现");
	if (draft.title.length > 120) throw new Error("测试标题不能超过 120 个字符。");
	if (draft.expectedFailure.length > 500 || draft.expectedSuccess.length > 500) {
		throw new Error("修复前后表现不能超过 500 个字符。");
	}
	if (!VALID_CATEGORIES.has(draft.category)) throw new Error("测试类别无效。");
	if (draft.reproduction.length === 0 || draft.reproduction.length > MAX_STEPS) {
		throw new Error(`复现步骤必须为 1 到 ${MAX_STEPS} 条。`);
	}
	for (const step of draft.reproduction) {
		validateText(step, "复现步骤");
		if (step.length > 300) throw new Error("单条复现步骤不能超过 300 个字符。");
	}
	if (draft.files.length === 0 || draft.files.length > MAX_FILES)
		throw new Error(`测试文件必须为 1 到 ${MAX_FILES} 个。`);
	let totalCharacters = 0;
	const seen = new Set<string>();
	for (const file of draft.files) {
		const normalized = file.path.replaceAll("\\", "/");
		if (normalized.length > 200) throw new Error("测试路径不能超过 200 个字符。");
		if (!normalized || normalized.includes("\0") || path.posix.isAbsolute(normalized))
			throw new Error("测试路径必须是相对路径。");
		if (normalized.split("/").some((part) => part === ".." || part === "." || part === "")) {
			throw new Error("测试路径不能包含目录跳转。");
		}
		if (!testLikePath(normalized)) throw new Error(`只允许创建测试文件：${normalized}`);
		if (seen.has(normalized.toLowerCase())) throw new Error(`测试路径重复：${normalized}`);
		seen.add(normalized.toLowerCase());
		validateText(file.content, `测试文件 ${normalized}`);
		totalCharacters += file.content.length;
	}
	if (totalCharacters > MAX_TOTAL_CHARACTERS) throw new Error(`测试内容不能超过 ${MAX_TOTAL_CHARACTERS} 个字符。`);
	return draft;
}

export interface RegressionDraftPreviewLabels {
	source: string;
	title: string;
	category: string;
	expectedFailure: string;
	expectedSuccess: string;
	reproduction: string;
	file: string;
}

const DEFAULT_PREVIEW_LABELS: RegressionDraftPreviewLabels = {
	source: "来源",
	title: "标题",
	category: "类别",
	expectedFailure: "修复前",
	expectedSuccess: "修复后",
	reproduction: "复现",
	file: "文件",
};

export function formatRegressionDraftPreview(
	draft: RegressionTestDraft,
	source: RecoveredFailureSignal,
	labels: RegressionDraftPreviewLabels = DEFAULT_PREVIEW_LABELS,
	sourceSummary = source.summary,
): string {
	return [
		`${labels.source}: ${sourceSummary}`,
		`${labels.title}: ${draft.title}`,
		`${labels.category}: ${draft.category}`,
		`${labels.expectedFailure}: ${draft.expectedFailure}`,
		`${labels.expectedSuccess}: ${draft.expectedSuccess}`,
		`${labels.reproduction}:`,
		...draft.reproduction.map((step, index) => `${index + 1}. ${step}`),
		...draft.files.flatMap((file) => ["", `${labels.file}: ${file.path}`, "```", file.content, "```"]),
	].join("\n");
}

function suppressionName(fingerprint: string): string {
	return `${createHash("sha256").update(fingerprint).digest("hex")}.json`;
}

function validQuality(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.version === 1 &&
		typeof value.framework === "string" &&
		VALID_TEST_FRAMEWORKS.has(value.framework) &&
		typeof value.assertionCount === "number" &&
		Number.isInteger(value.assertionCount) &&
		value.assertionCount > 0 &&
		Array.isArray(value.productReferences) &&
		value.productReferences.length > 0 &&
		value.productReferences.every((reference) => typeof reference === "string" && reference.length > 0)
	);
}

function validApprovedFile(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		typeof value.bytes === "number" &&
		Number.isInteger(value.bytes) &&
		value.bytes >= 0 &&
		typeof value.digest === "string" &&
		/^[a-f0-9]{64}$/.test(value.digest)
	);
}

function parseApproved(value: unknown): ApprovedRegressionCase | undefined {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		typeof value.title !== "string" ||
		typeof value.category !== "string" ||
		!VALID_CATEGORIES.has(value.category as EvalCategory) ||
		typeof value.approvedAt !== "string" ||
		!isRecord(value.source) ||
		!Array.isArray(value.reproduction) ||
		!value.reproduction.every((step) => typeof step === "string") ||
		typeof value.expectedFailure !== "string" ||
		typeof value.expectedSuccess !== "string" ||
		(value.quality !== undefined && !validQuality(value.quality)) ||
		!Array.isArray(value.files) ||
		value.files.length === 0 ||
		!value.files.every(validApprovedFile)
	) {
		return undefined;
	}
	return value as unknown as ApprovedRegressionCase;
}

export class RegressionCaseStore implements RegressionCaseStoreLike {
	private readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
	}

	async isSuppressed(fingerprint: string): Promise<boolean> {
		try {
			await access(path.join(this.directory, "suppressed", suppressionName(fingerprint)));
			return true;
		} catch {
			return false;
		}
	}

	async suppress(fingerprint: string): Promise<void> {
		const directory = path.join(this.directory, "suppressed");
		await mkdir(directory, { recursive: true });
		await writeFile(
			path.join(directory, suppressionName(fingerprint)),
			`${JSON.stringify({ version: 1, fingerprint, suppressedAt: new Date().toISOString() })}\n`,
			{ encoding: "utf8", flag: "wx" },
		).catch((error: unknown) => {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
		});
	}

	async saveApproved(testCase: ApprovedRegressionCase): Promise<void> {
		const directory = path.join(this.directory, "cases");
		await mkdir(directory, { recursive: true });
		await writeFile(path.join(directory, `${testCase.id}.json`), `${JSON.stringify(testCase, null, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
	}

	async listApproved(): Promise<ApprovedRegressionCase[]> {
		const directory = path.join(this.directory, "cases");
		try {
			const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
			const values = await Promise.all(
				names.map(async (name) => {
					try {
						return parseApproved(JSON.parse(await readFile(path.join(directory, name), "utf8")));
					} catch {
						return undefined;
					}
				}),
			);
			return values.filter((value): value is ApprovedRegressionCase => value !== undefined);
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return [];
			throw error;
		}
	}
}

function within(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class RegressionCaseWriter implements RegressionCaseWriterLike {
	private readonly store: RegressionCaseStoreLike;

	constructor(store: RegressionCaseStoreLike) {
		this.store = store;
	}

	async write(
		workspace: string,
		draft: RegressionTestDraft,
		source: RecoveredFailureSignal,
		now = new Date(),
	): Promise<ApprovedRegressionCase> {
		validateRegressionDraft(draft);
		const quality = assessRegressionDraftQuality(draft);
		if (!quality.passed || !quality.evidence) throw new Error("回归测试没有通过真实代码质量门。");
		const root = await realpath(workspace);
		const targets = draft.files.map((file) => ({ file, target: path.resolve(root, file.path) }));
		for (const { file, target } of targets) {
			if (!within(root, target)) throw new Error(`测试路径超出项目：${file.path}`);
			try {
				await access(target);
				throw new Error(`测试文件已经存在，拒绝覆盖：${file.path}`);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("测试文件已经存在")) throw error;
			}
		}
		const created: string[] = [];
		try {
			for (const { file, target } of targets) {
				await mkdir(path.dirname(target), { recursive: true });
				const parent = await realpath(path.dirname(target));
				if (!within(root, parent)) throw new Error(`测试目录通过链接跳出项目：${file.path}`);
				await writeFile(target, file.content, { encoding: "utf8", flag: "wx" });
				created.push(target);
			}
			const approvedAt = now.toISOString();
			const digestSource = JSON.stringify({ source, draft, approvedAt });
			const testCase: ApprovedRegressionCase = {
				version: 1,
				id: createHash("sha256").update(digestSource).digest("hex").slice(0, 24),
				title: draft.title,
				category: draft.category,
				approvedAt,
				source,
				reproduction: [...draft.reproduction],
				expectedFailure: draft.expectedFailure,
				expectedSuccess: draft.expectedSuccess,
				quality: quality.evidence,
				files: draft.files.map((file) => ({
					path: file.path.replaceAll("\\", "/"),
					bytes: Buffer.byteLength(file.content, "utf8"),
					digest: createHash("sha256").update(file.content).digest("hex"),
				})),
			};
			await this.store.saveApproved(testCase);
			return testCase;
		} catch (error) {
			await Promise.all(created.map((filePath) => rm(filePath, { force: true })));
			throw error;
		}
	}
}
