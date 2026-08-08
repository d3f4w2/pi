import { Readability } from "@mozilla/readability";
import { type DOMDocument, JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";

const NOISE_SELECTOR = [
	"script",
	"style",
	"noscript",
	"iframe",
	"object",
	"embed",
	"form",
	"dialog",
	"nav",
	"aside",
	"footer",
	".advertisement",
	".ads",
	".cookie-banner",
	".newsletter",
	".related-posts",
	".social-share",
].join(",");

const turndown = new TurndownService({
	headingStyle: "atx",
	bulletListMarker: "-",
	codeBlockStyle: "fenced",
	emDelimiter: "*",
});
turndown.remove(["script", "style", "noscript", "iframe", "object", "embed", "form"]);

interface ExtractedContent {
	title: string;
	html: string;
}

function normalizeWhitespace(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/[\t\f\v \u00a0]+/g, " ")
		.replace(/ +\n/g, "\n")
		.replace(/\n +/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function makeLinksAbsolute(document: DOMDocument, baseUrl: string): void {
	for (const element of document.querySelectorAll("a[href], img[src]")) {
		const attribute = element.tagName.toLowerCase() === "a" ? "href" : "src";
		const value = element.getAttribute(attribute);
		if (!value) continue;
		try {
			element.setAttribute(attribute, new URL(value, baseUrl).toString());
		} catch {
			element.removeAttribute(attribute);
		}
	}
}

function extractContent(html: string, url: string): ExtractedContent {
	const virtualConsole = new VirtualConsole();
	const dom = new JSDOM(html, { url, contentType: "text/html", virtualConsole });
	try {
		const document = dom.window.document;
		for (const element of document.querySelectorAll(NOISE_SELECTOR)) element.remove();
		makeLinksAbsolute(document, url);
		const fallbackTitle = normalizeWhitespace(document.querySelector("h1")?.textContent ?? document.title);
		const article = new Readability(document.cloneNode(true), {
			charThreshold: 80,
			keepClasses: false,
			maxElemsToParse: 100_000,
		}).parse();
		return {
			title: normalizeWhitespace(article?.title ?? fallbackTitle),
			html: article?.content ?? document.body?.innerHTML ?? html,
		};
	} finally {
		dom.window.close();
	}
}

export function htmlToMarkdown(html: string, url: string): string {
	const extracted = extractContent(html, url);
	const markdown = normalizeWhitespace(turndown.turndown(extracted.html));
	if (!extracted.title || /^#\s/m.test(markdown)) return markdown;
	return `# ${extracted.title}\n\n${markdown}`.trim();
}

export function htmlToText(html: string, url: string): string {
	const extracted = extractContent(html, url);
	const dom = new JSDOM(`<body>${extracted.html}</body>`, { url, contentType: "text/html" });
	try {
		const document = dom.window.document;
		for (const element of document.querySelectorAll("br")) element.replaceWith(document.createTextNode("\n"));
		for (const element of document.querySelectorAll("p,li,blockquote,pre,h1,h2,h3,h4,h5,h6,tr")) {
			element.after(document.createTextNode("\n"));
		}
		const text = normalizeWhitespace(document.body?.textContent ?? "");
		if (!extracted.title || text.startsWith(extracted.title)) return text;
		return `${extracted.title}\n\n${text}`.trim();
	} finally {
		dom.window.close();
	}
}
