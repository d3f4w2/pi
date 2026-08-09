import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import {
	access as fsAccess,
	chmod as fsChmod,
	readFile as fsReadFile,
	rename as fsRename,
	stat as fsStat,
	unlink as fsUnlink,
	writeFile as fsWriteFile,
} from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	computeAnchoredEditsDiff,
	computeEditsDiff,
	detectLineEnding,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { type AnchoredEdit, applyAnchoredEdits, createFileRevision } from "./file-anchors.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

type EditPreview = EditDiffResult | EditDiffError;

type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

const anchoredEditSchema = Type.Object(
	{
		startAnchor: Type.String({ description: "First line#hash anchor returned by read." }),
		endAnchor: Type.Optional(
			Type.String({ description: "Last line#hash anchor returned by read. Omit for a single-line edit." }),
		),
		newText: Type.String({ description: "Replacement text for the anchored line range." }),
	},
	{},
);

const editEntrySchema = Type.Union([anchoredEditSchema, replaceEditSchema]);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		baseHash: Type.Optional(
			Type.String({ description: "File revision returned by read. Required for strict stale-file protection." }),
		),
		edits: Type.Array(editEntrySchema, {
			description:
				"One or more anchored or exact-text replacements. Prefer startAnchor/endAnchor from read. Use one mode per call and do not overlap ranges.",
		}),
	},
	{},
);

export const editToolSystemPromptContribution = {
	snippet: "Make precise, stale-safe file edits with read anchors or exact text",
	guidelines: [
		"Prefer edit with baseHash and startAnchor/endAnchor values returned by read; use oldText only when anchors are unavailable.",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"All edits are matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
} as const;

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
}

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Atomically replace a file when supported by the backend */
	replaceFile?: (absolutePath: string, content: string) => Promise<void>;
	/** Check if file is readable and writable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
}

async function atomicReplaceLocalFile(absolutePath: string, content: string): Promise<void> {
	const fileStat = await fsStat(absolutePath);
	const tempPath = join(
		dirname(absolutePath),
		`.${basename(absolutePath)}.pi-edit-${process.pid}-${randomUUID()}.tmp`,
	);
	let committed = false;
	try {
		await fsWriteFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: fileStat.mode });
		await fsChmod(tempPath, fileStat.mode);
		await fsRename(tempPath, absolutePath);
		committed = true;
	} finally {
		if (!committed) {
			try {
				await fsUnlink(tempPath);
			} catch {}
		}
	}
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	replaceFile: atomicReplaceLocalFile,
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
	/** Custom operations for file editing. Default: local filesystem */
	operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {}
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

type ValidatedEditInput =
	| { path: string; baseHash: string | undefined; mode: "anchored"; edits: AnchoredEdit[] }
	| { path: string; baseHash: undefined; mode: "exact"; edits: Edit[] };

function validateEditInput(input: EditToolInput): ValidatedEditInput {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}

	const anchoredEdits: AnchoredEdit[] = [];
	const exactEdits: Edit[] = [];
	for (let index = 0; index < input.edits.length; index++) {
		const edit = input.edits[index] as Record<string, unknown>;
		const hasAnchorFields = typeof edit.startAnchor === "string" || typeof edit.endAnchor === "string";
		const hasExactFields = typeof edit.oldText === "string" || "oldText" in edit;
		if (hasAnchorFields === hasExactFields || typeof edit.newText !== "string") {
			throw new Error(`edits[${index}] must use exactly one mode: startAnchor/endAnchor or oldText, plus newText.`);
		}
		if (hasAnchorFields) {
			if (typeof edit.startAnchor !== "string") {
				throw new Error(`edits[${index}].startAnchor must be a string.`);
			}
			if (edit.endAnchor !== undefined && typeof edit.endAnchor !== "string") {
				throw new Error(`edits[${index}].endAnchor must be a string when provided.`);
			}
			anchoredEdits.push({
				startAnchor: edit.startAnchor,
				...(typeof edit.endAnchor === "string" ? { endAnchor: edit.endAnchor } : {}),
				newText: edit.newText,
			});
		} else {
			if (typeof edit.oldText !== "string") {
				throw new Error(`edits[${index}].oldText must be a string.`);
			}
			exactEdits.push({ oldText: edit.oldText, newText: edit.newText });
		}
	}
	if (anchoredEdits.length > 0 && exactEdits.length > 0) {
		throw new Error("Do not mix anchored and exact-text replacements in one edit call.");
	}
	if (anchoredEdits.length > 0) {
		return { path: input.path, baseHash: input.baseHash, mode: "anchored", edits: anchoredEdits };
	}
	if (input.baseHash !== undefined) {
		throw new Error("baseHash is only valid with anchored edits.");
	}
	return { path: input.path, baseHash: undefined, mode: "exact", edits: exactEdits };
}

type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	baseHash?: string;
	edits?: Array<Edit | AnchoredEdit>;
	oldText?: string;
	newText?: string;
};

type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

type EditCallRenderComponent = Box & {
	preview?: EditPreview;
	previewArgsKey?: string;
	previewPending?: boolean;
	settledError?: boolean;
};

function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

type RenderablePreviewInput =
	| { path: string; mode: "exact"; edits: Edit[] }
	| { path: string; mode: "anchored"; baseHash: string | undefined; edits: AnchoredEdit[] };

function getRenderablePreviewInput(args: RenderableEditArgs | undefined): RenderablePreviewInput | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every(
			(edit): edit is Edit =>
				"oldText" in edit && typeof edit.oldText === "string" && typeof edit.newText === "string",
		)
	) {
		return { path, mode: "exact", edits: args.edits };
	}

	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every(
			(edit): edit is AnchoredEdit =>
				"startAnchor" in edit &&
				typeof edit.startAnchor === "string" &&
				(edit.endAnchor === undefined || typeof edit.endAnchor === "string") &&
				typeof edit.newText === "string",
		)
	) {
		return { path, mode: "anchored", baseHash: args.baseHash, edits: args.edits };
	}

	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, mode: "exact", edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}

	return undefined;
}

function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) {
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));

	if (!component.preview) {
		return component;
	}

	const body =
		"error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit one file with stale-safe line anchors returned by read, or exact text when anchors are unavailable. Pass read's baseHash with anchored edits. Every range is validated before an atomic local-file replacement; overlapping edits are rejected without writing.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const validated = validateEditInput(input);
			const { path } = validated;
			const absolutePath = resolveToCwd(path, cwd);

			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// Check if file exists.
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// Read the file.
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// Strip BOM before matching. The model will not include an invisible BOM in oldText.
				const { bom, text: content } = stripBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				let baseContent: string;
				let newContent: string;
				if (validated.mode === "anchored") {
					const currentHash = createFileRevision(rawContent);
					if (validated.baseHash !== undefined && validated.baseHash !== currentHash) {
						throw new Error(
							`${path} changed since it was read (expected ${validated.baseHash}, current ${currentHash}). Reread the affected lines and retry.`,
						);
					}
					({ baseContent, newContent } = applyAnchoredEdits(normalizedContent, validated.edits, path));
				} else {
					({ baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, validated.edits, path));
				}
				throwIfAborted();

				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				if (ops.replaceFile) await ops.replaceFile(absolutePath, finalContent);
				else await ops.writeFile(absolutePath, finalContent);

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${validated.edits.length} block(s) in ${path}.`,
						},
					],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			const argsKey = previewInput ? JSON.stringify(previewInput) : undefined;

			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestKey = argsKey;
				const previewPromise =
					previewInput.mode === "anchored"
						? computeAnchoredEditsDiff(previewInput.path, previewInput.edits, previewInput.baseHash, context.cwd)
						: computeEditsDiff(previewInput.path, previewInput.edits, context.cwd);
				void previewPromise.then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(component, args, theme, context.cwd);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput ? JSON.stringify(previewInput) : undefined;
			const typedResult = result as EditToolResultLike;
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
							argsKey,
						) || changed;
				}
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				if (changed) {
					buildEditCallComponent(
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
					);
				}
			}

			const output = formatEditResult(context.args, callComponent?.preview, typedResult, theme, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
