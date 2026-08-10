import { appendFile } from "node:fs/promises";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";

function argument(name, fallback) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

const delayMs = Number(argument("--delay", "0"));
const counterPath = argument("--counter", "");
const failInitialize = process.argv.includes("--fail-initialize");
if (counterPath) await appendFile(counterPath, `${process.pid}\n`, "utf8");

const connection = createMessageConnection(
	new StreamMessageReader(process.stdin),
	new StreamMessageWriter(process.stdout),
	{ error() {}, warn() {}, info() {}, log() {} },
);

connection.onRequest("initialize", async () => {
	if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
	if (failInitialize) throw new Error("injected initialize failure");
	return {
		capabilities: {
			hoverProvider: true,
			definitionProvider: true,
			textDocumentSync: 1,
		},
	};
});
connection.onRequest("textDocument/hover", () => ({ contents: { kind: "plaintext", value: "fake hover" } }));
connection.onRequest("textDocument/definition", () => []);
connection.onRequest("pi/test/memory", () => process.memoryUsage().rss);
connection.onRequest("shutdown", () => null);
connection.onRequest(() => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
