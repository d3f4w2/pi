import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { ApiProviderStorage } from "../src/extensions/api/storage.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) await rm(directory, { recursive: true, force: true });
	}
});

describe("ApiProviderStorage", () => {
	test("loads compatible providers and ignores unrelated provider entries", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-api-storage-"));
		temporaryDirectories.push(directory);
		const modelsPath = join(directory, "models.json");
		await writeFile(
			modelsPath,
			JSON.stringify({
				providers: {
					compatible: {
						name: "兼容供应商",
						baseUrl: "https://example.test/v1",
						api: "openai-responses",
						models: [{ id: "model-a", reasoning: true, input: ["image"] }],
					},
					unrelated: { name: "内置供应商", baseUrl: "https://example.test", api: "unknown", models: [] },
				},
			}),
		);

		const providers = await new ApiProviderStorage(modelsPath).listProviders();

		expect(providers).toEqual([
			{
				id: "compatible",
				name: "兼容供应商",
				baseUrl: "https://example.test/v1",
				api: "openai-responses",
				models: [
					{
						id: "model-a",
						name: "model-a",
						reasoning: true,
						input: ["text", "image"],
						contextWindow: 128_000,
						maxTokens: 16_384,
					},
				],
				hasStoredApiKey: false,
				sourceId: "compatible",
			},
		]);
	});

	test("saves models, preserves unrelated fields, and removes a renamed source provider", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-api-storage-"));
		temporaryDirectories.push(directory);
		const modelsPath = join(directory, "models.json");
		await writeFile(
			modelsPath,
			JSON.stringify({
				providers: {
					"old-id": {
						customField: "preserve-me",
						baseUrl: "https://old.test",
						api: "openai-completions",
						models: [],
					},
					other: { name: "other", baseUrl: "https://other.test", api: "openai-responses", models: [] },
				},
			}),
		);

		await new ApiProviderStorage(modelsPath).saveProvider({
			id: "new-id",
			name: "新供应商",
			baseUrl: "https://new.test/v1",
			api: "anthropic-messages",
			models: [
				{
					id: "claude",
					name: "Claude",
					reasoning: false,
					input: ["text"],
					contextWindow: 200_000,
					maxTokens: 8_192,
				},
			],
			hasStoredApiKey: true,
			sourceId: "old-id",
		});

		const content = JSON.parse(await readFile(modelsPath, "utf8")) as {
			providers: Record<string, Record<string, unknown>>;
		};
		expect(content.providers["old-id"]).toBeUndefined();
		expect(content.providers.other).toEqual({
			name: "other",
			baseUrl: "https://other.test",
			api: "openai-responses",
			models: [],
		});
		expect(content.providers["new-id"]).toMatchObject({
			name: "新供应商",
			baseUrl: "https://new.test/v1",
			api: "anthropic-messages",
			authHeader: true,
			models: [{ id: "claude", name: "Claude", input: ["text"] }],
		});
		expect(content.providers["new-id"].customField).toBeUndefined();
	});
});
