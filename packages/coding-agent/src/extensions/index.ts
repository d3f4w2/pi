import type { InlineExtension } from "../core/extensions/types.ts";
import apiExtension from "./api/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "API 供应商管理", factory: apiExtension, hidden: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
];
