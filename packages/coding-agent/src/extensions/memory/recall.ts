import type { MemoryRecallHit, MemoryRecord } from "./types.ts";

function normalize(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function tokenize(value: string): string[] {
	const normalized = normalize(value);
	const tokens: string[] = [];
	for (const match of normalized.matchAll(/[\p{L}\p{N}_./:-]+/gu)) {
		const token = match[0];
		if (/^\p{Script=Han}+$/u.test(token)) {
			for (const character of token) tokens.push(character);
			for (let index = 0; index < token.length - 1; index += 1) tokens.push(token.slice(index, index + 2));
			for (let index = 0; index < token.length - 2; index += 1) tokens.push(token.slice(index, index + 3));
			continue;
		}
		if (token.length >= 2) tokens.push(token);
	}
	return tokens;
}

function documentText(record: MemoryRecord): string {
	return [
		record.claim.subject,
		record.claim.subject,
		record.claim.predicate,
		record.claim.predicate,
		record.claim.value,
		record.content,
		...record.evidence.flatMap((item) => (item.type === "file" ? [item.path, item.excerpt ?? ""] : [])),
	].join(" ");
}

function termFrequency(tokens: readonly string[]): Map<string, number> {
	const frequencies = new Map<string, number>();
	for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
	return frequencies;
}

function utilityMultiplier(record: MemoryRecord): number {
	const judged = record.usage.helpfulCount + record.usage.harmfulCount;
	if (judged === 0) return 1;
	const helpfulRate = record.usage.helpfulCount / judged;
	return Math.max(0.35, 0.7 + helpfulRate * 0.6 - record.usage.harmfulCount * 0.08);
}

export function rankMemoryRecords(query: string, records: readonly MemoryRecord[]): MemoryRecallHit[] {
	const normalizedQuery = normalize(query);
	if (!normalizedQuery || records.length === 0) return [];
	const queryTerms = [...new Set(tokenize(normalizedQuery))];
	if (queryTerms.length === 0) return [];
	const documents = records.map((record) => {
		const text = documentText(record);
		const tokens = tokenize(text);
		return { record, text: normalize(text), tokens, frequencies: termFrequency(tokens) };
	});
	const averageLength =
		documents.reduce((total, document) => total + document.tokens.length, 0) / documents.length || 1;
	const documentFrequency = new Map<string, number>();
	for (const term of queryTerms) {
		documentFrequency.set(term, documents.filter((document) => document.frequencies.has(term)).length);
	}

	return documents
		.map((document) => {
			let score = 0;
			const reasons: string[] = [];
			for (const term of queryTerms) {
				const frequency = document.frequencies.get(term) ?? 0;
				if (frequency === 0) continue;
				const containing = documentFrequency.get(term) ?? 0;
				const idf = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
				const denominator = frequency + 1.2 * (0.25 + 0.75 * (document.tokens.length / averageLength));
				score += idf * ((frequency * 2.2) / denominator);
			}
			const normalizedSubject = normalize(document.record.claim.subject);
			const normalizedPredicate = normalize(document.record.claim.predicate);
			const normalizedValue = normalize(document.record.claim.value);
			const normalizedContent = normalize(document.record.content);
			if (
				normalizedQuery === normalizedSubject ||
				normalizedQuery === `${normalizedSubject}.${normalizedPredicate}`
			) {
				score += 8;
				reasons.push("claim_exact");
			}
			if (normalizedContent.includes(normalizedQuery) || normalizedValue.includes(normalizedQuery)) {
				score += 4;
				reasons.push("phrase_exact");
			}
			const matchedTerms = queryTerms.filter((term) => document.frequencies.has(term)).length;
			if (matchedTerms > 0) reasons.push(`terms:${matchedTerms}/${queryTerms.length}`);
			if (matchedTerms === queryTerms.length && queryTerms.length > 1) score += 1.5;
			if (document.record.importance === "core") score += 0.35;
			score *= 0.75 + document.record.confidence * 0.25;
			score *= utilityMultiplier(document.record);
			return { record: document.record, score, reasons };
		})
		.filter((hit) => hit.score >= 0.75)
		.sort((left, right) => right.score - left.score || right.record.updatedAt.localeCompare(left.record.updatedAt));
}
