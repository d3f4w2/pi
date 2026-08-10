import { createHash } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import type { LanguageAdapter, LanguageServerLaunch } from "./types.ts";

export const LSP_BROKER_PROTOCOL_VERSION = 1;
export const LSP_BROKER_CONNECT_METHOD = "pi/broker/connect";
export const LSP_BROKER_HEALTH_METHOD = "pi/broker/health";
export const LSP_BROKER_RELOAD_METHOD = "pi/broker/reload";

export interface LspBrokerIdentity {
	protocolVersion: number;
	projectRoot: string;
	adapterId: LanguageAdapter["id"];
	launch: LanguageServerLaunch;
	cacheKey: string;
}

export interface LspBrokerConnectResult {
	protocolVersion: number;
	cacheKey: string;
	clientCount: number;
	brokerPid: number;
	languageServerPid?: number;
}

export interface LspBrokerHealth extends LspBrokerConnectResult {
	projectRoot: string;
	status: "starting" | "ready" | "failed";
	negativeCacheUntil?: number;
}

function platformIdentity(): string {
	try {
		return `${userInfo().username}:${homedir()}`;
	} catch {
		return homedir();
	}
}

export function lspBrokerCacheKey(
	projectRoot: string,
	adapterId: LanguageAdapter["id"],
	launch: LanguageServerLaunch,
): string {
	const normalizedRoot =
		process.platform === "win32" ? path.resolve(projectRoot).toLowerCase() : path.resolve(projectRoot);
	return createHash("sha256")
		.update(JSON.stringify({ protocolVersion: LSP_BROKER_PROTOCOL_VERSION, normalizedRoot, adapterId, launch }))
		.digest("hex");
}

export function lspBrokerIdentity(
	projectRoot: string,
	adapterId: LanguageAdapter["id"],
	launch: LanguageServerLaunch,
): LspBrokerIdentity {
	return {
		protocolVersion: LSP_BROKER_PROTOCOL_VERSION,
		projectRoot: path.resolve(projectRoot),
		adapterId,
		launch,
		cacheKey: lspBrokerCacheKey(projectRoot, adapterId, launch),
	};
}

export function lspBrokerEndpoint(identity: LspBrokerIdentity): string {
	const userHash = createHash("sha256").update(platformIdentity()).digest("hex").slice(0, 10);
	const name = `pi-go-lsp-${userHash}-${identity.cacheKey.slice(0, 24)}`;
	return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(tmpdir(), `${name}.sock`);
}

export function assertBrokerIdentity(expected: LspBrokerIdentity, received: unknown): void {
	if (!received || typeof received !== "object") throw new Error("LSP broker 缺少连接身份。");
	const candidate = received as Partial<LspBrokerIdentity>;
	if (candidate.protocolVersion !== LSP_BROKER_PROTOCOL_VERSION) {
		throw new Error(
			`LSP broker 协议版本不兼容：需要 ${LSP_BROKER_PROTOCOL_VERSION}，收到 ${String(candidate.protocolVersion)}。`,
		);
	}
	if (candidate.cacheKey !== expected.cacheKey) throw new Error("LSP broker 配置缓存键不匹配。");
	const expectedRoot = process.platform === "win32" ? expected.projectRoot.toLowerCase() : expected.projectRoot;
	const candidateRoot =
		typeof candidate.projectRoot === "string"
			? process.platform === "win32"
				? path.resolve(candidate.projectRoot).toLowerCase()
				: path.resolve(candidate.projectRoot)
			: "";
	if (candidateRoot !== expectedRoot || candidate.adapterId !== expected.adapterId) {
		throw new Error("LSP broker 拒绝跨项目或跨语言服务器共享。");
	}
}
