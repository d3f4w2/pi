import { Compile } from "typebox/compile";
import type { AuthStorageBackend } from "../../core/auth-storage.ts";
import {
	EVOLUTION_SCHEMA_VERSION,
	type EvolutionStoreData,
	EvolutionStoreDataSchema,
	MAX_EVOLUTION_CANDIDATES,
	MAX_EVOLUTION_EVENTS,
	MAX_EVOLUTION_SIGNALS,
} from "./types.ts";

const validator = Compile(EvolutionStoreDataSchema);

export interface EvolutionBackendMutation<T> {
	result: T;
	changed?: boolean;
}

export interface EvolutionBackend {
	transact<T>(mutate: (store: EvolutionStoreData) => Promise<EvolutionBackendMutation<T>>): Promise<T>;
}

function emptyStore(): EvolutionStoreData {
	return {
		schemaVersion: EVOLUTION_SCHEMA_VERSION,
		revision: 0,
		settings: { enabled: true, signalThreshold: 2, canaryRuns: 3 },
		signals: [],
		candidates: [],
		events: [],
	};
}

function parseStore(content: string | undefined): EvolutionStoreData {
	if (!content?.trim() || content.trim() === "{}") return emptyStore();
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error("自进化记录损坏：不是有效的 JSON；原文件不会被覆盖");
	}
	if (!validator.Check(parsed)) throw new Error("自进化记录损坏：数据格式无效；原文件不会被覆盖");
	return structuredClone(parsed);
}

function serializeStore(store: EvolutionStoreData): string {
	store.signals = store.signals.slice(-MAX_EVOLUTION_SIGNALS);
	store.candidates = store.candidates.slice(-MAX_EVOLUTION_CANDIDATES);
	store.events = store.events.slice(-MAX_EVOLUTION_EVENTS);
	return `${JSON.stringify(store, null, 2)}\n`;
}

export class LockedJsonEvolutionBackend implements EvolutionBackend {
	private readonly storage: AuthStorageBackend;

	constructor(storage: AuthStorageBackend) {
		this.storage = storage;
	}

	async transact<T>(mutate: (store: EvolutionStoreData) => Promise<EvolutionBackendMutation<T>>): Promise<T> {
		return this.storage.withLockAsync(async (content) => {
			const store = parseStore(content);
			const mutation = await mutate(store);
			return {
				result: mutation.result,
				...(mutation.changed ? { next: serializeStore(store) } : {}),
			};
		});
	}
}
