import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { registerInternalReadResourceResolver } from "../src/core/tools/unified-read.ts";

const tempDirs: string[] = [];
const disposers: Array<() => void> = [];

afterEach(async () => {
	for (const dispose of disposers.splice(0)) dispose();
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-unified-read-"));
	tempDirs.push(directory);
	return directory;
}

function textFrom(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

async function read(cwd: string, input: { path: string; entry?: string; page?: number }) {
	return createReadToolDefinition(cwd).execute("read", input, undefined, undefined, {} as ExtensionContext);
}

function zipStored(name: string, content: string): Buffer {
	const nameBytes = Buffer.from(name, "utf8");
	const data = Buffer.from(content, "utf8");
	const local = Buffer.alloc(30 + nameBytes.length);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(0x0800, 6);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(nameBytes.length, 26);
	nameBytes.copy(local, 30);
	const central = Buffer.alloc(46 + nameBytes.length);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(0x0800, 8);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(nameBytes.length, 28);
	nameBytes.copy(central, 46);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(local.length + data.length, 16);
	return Buffer.concat([local, data, central, end]);
}

function tarFile(name: string, content: string): Buffer {
	const data = Buffer.from(content, "utf8");
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, "utf8");
	header.write("0000644\0", 100, 8, "ascii");
	header.write("0000000\0", 108, 8, "ascii");
	header.write("0000000\0", 116, 8, "ascii");
	header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
	header.write("00000000000\0", 136, 12, "ascii");
	header.fill(0x20, 148, 156);
	header[156] = 0x30;
	header.write("ustar\0", 257, 6, "ascii");
	const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
	const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
	return Buffer.concat([header, data, padding, Buffer.alloc(1024)]);
}

function simplePdf(text: string): Buffer {
	const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
		"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
		`5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
	];
	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (const object of objects) {
		offsets.push(Buffer.byteLength(body));
		body += object;
	}
	const xrefOffset = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	body += offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("");
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body, "ascii");
}

describe("unified read", () => {
	it("lists ZIP entries and reads one entry", async () => {
		const directory = await createTempDir();
		await writeFile(join(directory, "sample.zip"), zipStored("docs/hello.txt", "hello from zip"));

		const listing = await read(directory, { path: "sample.zip" });
		const entry = await read(directory, { path: "sample.zip", entry: "docs/hello.txt" });

		expect(textFrom(listing)).toContain("docs/hello.txt");
		expect(textFrom(entry)).toBe("hello from zip");
		expect(entry.details?.source).toMatchObject({ kind: "archive", entry: "docs/hello.txt" });
	});

	it("rejects archive path traversal before extraction", async () => {
		const directory = await createTempDir();
		await writeFile(join(directory, "unsafe.zip"), zipStored("../escape.txt", "blocked"));

		await expect(read(directory, { path: "unsafe.zip" })).rejects.toThrow(/不安全路径/);
	});

	it("reads a TAR.GZ entry without external tools", async () => {
		const directory = await createTempDir();
		await writeFile(join(directory, "sample.tar.gz"), gzipSync(tarFile("src/main.ts", "export const ready = true;")));

		const result = await read(directory, { path: "sample.tar.gz!/src/main.ts" });

		expect(textFrom(result)).toBe("export const ready = true;");
		expect(result.details?.source).toMatchObject({ kind: "archive", entry: "src/main.ts" });
	});

	it("extracts one PDF page", async () => {
		const directory = await createTempDir();
		await writeFile(join(directory, "sample.pdf"), simplePdf("Hello PDF"));

		const result = await read(directory, { path: "sample.pdf", page: 1 });

		expect(textFrom(result)).toContain("Hello PDF");
		expect(result.details?.source).toMatchObject({ kind: "pdf", pageCount: 1 });
	});

	it("ignores a strict-schema page 1 default for ordinary text files", async () => {
		const directory = await createTempDir();
		await writeFile(join(directory, "math.ts"), "export const sum = 1 + 2;\n");

		const result = await read(directory, { path: "math.ts", page: 1 });

		expect(textFrom(result)).toContain("export const sum = 1 + 2;");
	});

	it("rejects an explicit later PDF page for ordinary text files", async () => {
		const directory = await createTempDir();
		await writeFile(join(directory, "math.ts"), "export const sum = 1 + 2;\n");

		await expect(read(directory, { path: "math.ts", page: 2 })).rejects.toThrow("不是 PDF 文件");
	});

	it("resolves pi project URIs and pluggable internal resources", async () => {
		const directory = await createTempDir();
		await writeFile(join(directory, "note.txt"), "project note");
		disposers.push(
			registerInternalReadResourceResolver({
				name: "memory-test",
				canRead: (uri) => uri === "memory://facts/current",
				read: async () => ({ data: "remembered fact", mimeType: "text/plain" }),
			}),
		);

		const project = await read(directory, { path: "pi://project/note.txt" });
		const internal = await read(directory, { path: "memory://facts/current" });

		expect(textFrom(project)).toContain("project note");
		expect(textFrom(internal)).toBe("remembered fact");
		expect(internal.details?.source?.kind).toBe("resource");
	});
});
