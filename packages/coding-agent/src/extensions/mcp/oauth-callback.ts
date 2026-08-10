import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface OAuthCallbackServer {
	redirectUrl: URL;
	wait(): Promise<URLSearchParams>;
	close(): Promise<void>;
}

function loopbackHostname(hostname: string): boolean {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

export async function startOAuthCallbackServer(
	configuredRedirectUrl: URL,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<OAuthCallbackServer> {
	if (configuredRedirectUrl.protocol !== "http:" || !loopbackHostname(configuredRedirectUrl.hostname)) {
		throw new Error("MCP OAuth callback must use a loopback HTTP URL.");
	}
	const timeoutMs = options.timeoutMs ?? 5 * 60 * 1_000;
	let settle: ((params: URLSearchParams) => void) | undefined;
	let fail: ((error: Error) => void) | undefined;
	const callback = new Promise<URLSearchParams>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	const server: Server = createServer((request, response) => {
		if (request.method !== "GET" || !request.url) {
			response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Method not allowed");
			return;
		}
		const url = new URL(request.url, configuredRedirectUrl);
		if (url.pathname !== configuredRedirectUrl.pathname) {
			response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			response.end("Not found");
			return;
		}
		response.writeHead(200, {
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
			"Content-Type": "text/html; charset=utf-8",
		});
		response.end("<!doctype html><title>Pi MCP authorization</title><p>Authorization received. Return to Pi.</p>");
		settle?.(new URLSearchParams(url.searchParams));
		settle = undefined;
		fail = undefined;
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(Number(configuredRedirectUrl.port || 80), "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address() as AddressInfo;
	const redirectUrl = new URL(configuredRedirectUrl);
	redirectUrl.hostname = "127.0.0.1";
	redirectUrl.port = String(address.port);
	const timeout = setTimeout(() => {
		fail?.(new Error(`MCP OAuth callback timed out after ${timeoutMs} ms`));
		settle = undefined;
		fail = undefined;
	}, timeoutMs);
	timeout.unref?.();
	const onAbort = () => {
		fail?.(options.signal?.reason instanceof Error ? options.signal.reason : new Error("MCP OAuth was cancelled."));
		settle = undefined;
		fail = undefined;
	};
	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });

	return {
		redirectUrl,
		wait: () => callback,
		async close() {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}
