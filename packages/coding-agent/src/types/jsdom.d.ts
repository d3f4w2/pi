declare module "jsdom" {
	export interface DOMNode {}

	export interface DOMElement extends DOMNode {
		readonly tagName: string;
		textContent: string | null;
		innerHTML: string;
		getAttribute(name: string): string | null;
		setAttribute(name: string, value: string): void;
		removeAttribute(name: string): void;
		remove(): void;
		replaceWith(...nodes: DOMNode[]): void;
		after(...nodes: DOMNode[]): void;
	}

	export interface DOMDocument extends DOMNode {
		readonly title: string;
		readonly body: DOMElement | null;
		querySelector(selectors: string): DOMElement | null;
		querySelectorAll(selectors: string): Iterable<DOMElement>;
		createTextNode(data: string): DOMNode;
		cloneNode(deep?: boolean): DOMDocument;
	}

	export interface ConstructorOptions {
		url?: string;
		contentType?: string;
		virtualConsole?: VirtualConsole;
	}

	export class VirtualConsole {}

	export class JSDOM {
		constructor(input?: string, options?: ConstructorOptions);
		readonly window: { document: DOMDocument; close(): void };
	}
}
