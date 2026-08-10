const SECRET_PATTERNS = [
	/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\b\s*[:=]\s*["']?[^\s"']{8,}/iu,
	/\b(?:sk|pk|ghp|gho|github_pat|xox[baprs])-[a-z0-9._-]{8,}\b/iu,
	/\bAKIA[0-9A-Z]{16}\b/u,
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];

export function containsSensitiveCredential(value: string): boolean {
	return SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

const AUTHORITY_DIRECTIVE_PATTERNS = [
	/(?:允许|批准|禁止|绕过|忽略).{0,16}(?:权限|安全|审批|工具|命令)/u,
	/(?:权限|安全策略|审批).{0,16}(?:允许|批准|禁止|绕过|忽略)/u,
	/\b(?:always\s+(?:allow|approve)|bypass\s+(?:safety|permission)|ignore\s+(?:safety|permission))\b/iu,
];

export function containsAuthorityDirective(value: string): boolean {
	return AUTHORITY_DIRECTIVE_PATTERNS.some((pattern) => pattern.test(value));
}
