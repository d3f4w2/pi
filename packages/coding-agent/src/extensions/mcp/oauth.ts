import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import type {
	OAuthClientInformationContext,
	OAuthClientMetadata,
	OAuthClientProvider,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { AuthStorage } from "../../core/auth-storage.ts";
import type { McpOAuthConfig } from "./types.ts";

interface McpOAuthPayload {
	version: 1;
	tokens: Record<string, StoredOAuthTokens>;
	clients: Record<string, StoredOAuthClientInformation>;
	lastIssuer?: string;
	codeVerifier?: string;
	state?: string;
}

export interface McpOAuthProviderOptions {
	serverName: string;
	serverUrl: string;
	redirectUrl: URL;
	oauth: McpOAuthConfig;
	storage?: AuthStorage;
	onRedirect?: (url: URL) => void | Promise<void>;
}

function emptyPayload(): McpOAuthPayload {
	return { version: 1, tokens: {}, clients: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payloadFromCredential(credential: OAuthCredential | undefined): McpOAuthPayload {
	const value = credential === undefined ? undefined : Reflect.get(credential, "mcpOAuth");
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.tokens) || !isRecord(value.clients)) {
		return emptyPayload();
	}
	return {
		version: 1,
		tokens: structuredClone(value.tokens) as Record<string, StoredOAuthTokens>,
		clients: structuredClone(value.clients) as Record<string, StoredOAuthClientInformation>,
		...(typeof value.lastIssuer === "string" ? { lastIssuer: value.lastIssuer } : {}),
		...(typeof value.codeVerifier === "string" ? { codeVerifier: value.codeVerifier } : {}),
		...(typeof value.state === "string" ? { state: value.state } : {}),
	};
}

function credentialFromPayload(payload: McpOAuthPayload): OAuthCredential {
	const latest = payload.lastIssuer === undefined ? undefined : payload.tokens[payload.lastIssuer];
	const expiresIn = latest?.expires_in;
	return {
		type: "oauth",
		access: latest?.access_token ?? "",
		refresh: latest?.refresh_token ?? "",
		expires: typeof expiresIn === "number" ? Date.now() + expiresIn * 1_000 : 0,
		mcpOAuth: payload,
	};
}

function safeEqual(left: string | undefined, right: string): boolean {
	if (left === undefined) return false;
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class McpOAuthProvider implements OAuthClientProvider {
	readonly #storage: AuthStorage;
	readonly #storageKey: string;
	readonly #configuredClientId: string | undefined;
	readonly #scope: string | undefined;
	#onRedirect: ((url: URL) => void | Promise<void>) | undefined;
	readonly redirectUrl: URL;
	readonly clientMetadata: OAuthClientMetadata;
	#authorizationUrl: URL | undefined;

	constructor(options: McpOAuthProviderOptions) {
		this.#storage = options.storage ?? AuthStorage.create();
		this.#storageKey = `mcp:${options.serverName}:${createHash("sha256").update(options.serverUrl).digest("hex").slice(0, 16)}`;
		this.#configuredClientId = options.oauth.clientId;
		this.#scope = options.oauth.scope;
		this.#onRedirect = options.onRedirect;
		this.redirectUrl = options.redirectUrl;
		this.clientMetadata = {
			client_name: "Pi Coding Agent",
			redirect_uris: [this.redirectUrl.toString()],
			grant_types: ["authorization_code"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			...(this.#scope === undefined ? {} : { scope: this.#scope }),
		};
	}

	get authorizationUrl(): URL | undefined {
		return this.#authorizationUrl === undefined ? undefined : new URL(this.#authorizationUrl);
	}

	setRedirectHandler(handler: ((url: URL) => void | Promise<void>) | undefined): void {
		this.#onRedirect = handler;
	}

	async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
		if (this.#configuredClientId)
			return { client_id: this.#configuredClientId, ...(ctx ? { issuer: ctx.issuer } : {}) };
		const payload = await this.#read();
		const issuer = ctx?.issuer ?? payload.lastIssuer;
		return issuer === undefined ? undefined : payload.clients[issuer];
	}

	async saveClientInformation(
		clientInformation: StoredOAuthClientInformation,
		ctx?: OAuthClientInformationContext,
	): Promise<void> {
		const issuer = ctx?.issuer ?? clientInformation.issuer;
		if (!issuer) throw new Error("MCP OAuth client registration is missing an issuer.");
		await this.#update((payload) => {
			payload.clients[issuer] = structuredClone(clientInformation);
			payload.lastIssuer = issuer;
		});
	}

	async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
		const payload = await this.#read();
		const issuer = ctx?.issuer ?? payload.lastIssuer;
		return issuer === undefined ? undefined : payload.tokens[issuer];
	}

	async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
		const issuer = ctx?.issuer ?? tokens.issuer;
		if (!issuer) throw new Error("MCP OAuth tokens are missing an issuer.");
		await this.#update((payload) => {
			payload.tokens[issuer] = structuredClone(tokens);
			payload.lastIssuer = issuer;
		});
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		this.#authorizationUrl = new URL(authorizationUrl);
		await this.#onRedirect?.(new URL(authorizationUrl));
	}

	async state(): Promise<string> {
		const state = randomUUID();
		await this.#update((payload) => {
			payload.state = state;
		});
		return state;
	}

	async validateState(value: string): Promise<boolean> {
		return safeEqual((await this.#read()).state, value);
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		await this.#update((payload) => {
			payload.codeVerifier = codeVerifier;
		});
	}

	async codeVerifier(): Promise<string> {
		const verifier = (await this.#read()).codeVerifier;
		if (!verifier) throw new Error("MCP OAuth PKCE verifier is missing.");
		return verifier;
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "all") {
			await this.#storage.delete(this.#storageKey);
			return;
		}
		await this.#update((payload) => {
			if (scope === "client") payload.clients = {};
			if (scope === "tokens") payload.tokens = {};
			if (scope === "verifier") {
				delete payload.codeVerifier;
				delete payload.state;
			}
		});
	}

	async #read(): Promise<McpOAuthPayload> {
		const credential = await this.#storage.read(this.#storageKey);
		return payloadFromCredential(credential?.type === "oauth" ? credential : undefined);
	}

	async #update(update: (payload: McpOAuthPayload) => void): Promise<void> {
		await this.#storage.modify(this.#storageKey, async (current) => {
			const payload = payloadFromCredential(current?.type === "oauth" ? current : undefined);
			update(payload);
			return credentialFromPayload(payload);
		});
	}
}
