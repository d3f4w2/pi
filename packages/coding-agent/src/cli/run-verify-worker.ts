import { VerifyService } from "../extensions/verify/service.ts";
import type { VerifyOperation } from "../extensions/verify/types.ts";

interface VerifyWorkerRequest {
	verification: {
		operation: VerifyOperation;
		path: string;
		timeoutSeconds: number;
	};
	cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStdin(): Promise<string> {
	let text = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) text += chunk;
	return text;
}

function parseRequest(text: string): VerifyWorkerRequest {
	const value: unknown = JSON.parse(text);
	if (!isRecord(value) || !isRecord(value.verification) || typeof value.cwd !== "string") {
		throw new Error("invalid_request");
	}
	const operations = new Set<VerifyOperation>(["auto", "typecheck", "test", "lint"]);
	if (
		typeof value.verification.operation !== "string" ||
		!operations.has(value.verification.operation as VerifyOperation) ||
		typeof value.verification.path !== "string" ||
		typeof value.verification.timeoutSeconds !== "number"
	) {
		throw new Error("invalid_request");
	}
	return {
		verification: {
			operation: value.verification.operation as VerifyOperation,
			path: value.verification.path,
			timeoutSeconds: value.verification.timeoutSeconds,
		},
		cwd: value.cwd,
	};
}

async function main(): Promise<void> {
	try {
		const request = parseRequest(await readStdin());
		const service = new VerifyService();
		const result = await service.verify(request.verification, request.cwd);
		process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
	} catch {
		process.stdout.write(`${JSON.stringify({ ok: false, error: "verification_failed" })}\n`);
		process.exitCode = 1;
	}
}

void main();
