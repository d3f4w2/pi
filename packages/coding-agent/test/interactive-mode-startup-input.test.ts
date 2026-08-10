import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	isExtensionCommand: (text: string) => boolean;
	showPendingUserMessage: (text: string) => void;
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
};

type PendingRender = {
	text: string;
	spacer: object | undefined;
	component: object;
};

type ReconcileContext = {
	pendingRenderedUserMessages: PendingRender[];
	getUserMessageText: (message: { role: "user"; content: string }) => string;
	removePendingUserMessage: (pending: PendingRender) => void;
};

type DiscardContext = {
	pendingRenderedUserMessages: PendingRender[];
	removePendingUserMessage: (pending: PendingRender) => void;
	editor: {
		getText: () => string;
		setText: (text: string) => void;
	};
	ui: { requestRender: () => void };
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<string>;
	reconcilePendingUserMessage(this: ReconcileContext, message: { role: "user"; content: string }): boolean;
	discardPendingUserMessage(this: DiscardContext, text: string, restoreEditor: boolean): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		isExtensionCommand: vi.fn(() => false),
		showPendingUserMessage: vi.fn(),
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual(["early prompt"]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.showPendingUserMessage).toHaveBeenCalledWith("early prompt");
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("shows a normal prompt before handing it to the prompt loop", async () => {
		const order: string[] = [];
		const context = createSubmitContext();
		context.showPendingUserMessage = (text) => order.push(`show:${text}`);
		context.onInputCallback = (text) => order.push(`submit:${text}`);
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("visible now");

		expect(order).toEqual(["show:visible now", "submit:visible now"]);
	});

	it("does not render extension commands as user messages", async () => {
		const context = createSubmitContext();
		context.isExtensionCommand = vi.fn(() => true);
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/extension-command");

		expect(context.showPendingUserMessage).not.toHaveBeenCalled();
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("keeps the pending render when the real user event matches", () => {
		const pending: PendingRender = { text: "same", spacer: {}, component: {} };
		const context: ReconcileContext = {
			pendingRenderedUserMessages: [pending],
			getUserMessageText: (message) => message.content,
			removePendingUserMessage: vi.fn(),
		};

		expect(
			interactiveModePrototype.reconcilePendingUserMessage.call(context, {
				role: "user",
				content: "same",
			}),
		).toBe(true);
		expect(context.pendingRenderedUserMessages).toEqual([]);
		expect(context.removePendingUserMessage).not.toHaveBeenCalled();
	});

	it("removes transformed pending text so the real user event can replace it", () => {
		const pending: PendingRender = { text: "/template", spacer: {}, component: {} };
		const context: ReconcileContext = {
			pendingRenderedUserMessages: [pending],
			getUserMessageText: (message) => message.content,
			removePendingUserMessage: vi.fn(),
		};

		expect(
			interactiveModePrototype.reconcilePendingUserMessage.call(context, {
				role: "user",
				content: "expanded template",
			}),
		).toBe(false);
		expect(context.removePendingUserMessage).toHaveBeenCalledWith(pending);
	});

	it("restores rejected input after removing its pending render", () => {
		const pending: PendingRender = { text: "retry me", spacer: {}, component: {} };
		const context: DiscardContext = {
			pendingRenderedUserMessages: [pending],
			removePendingUserMessage: vi.fn(),
			editor: { getText: () => "", setText: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		interactiveModePrototype.discardPendingUserMessage.call(context, "retry me", true);

		expect(context.removePendingUserMessage).toHaveBeenCalledWith(pending);
		expect(context.editor.setText).toHaveBeenCalledWith("retry me");
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});
});
