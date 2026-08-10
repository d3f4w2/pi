export type PluginCapabilityKind = "extensions" | "skills" | "mcp" | "resources";
export type PluginScope = "user" | "project";

export interface PluginCapabilities {
	extensions: string[];
	skills: string[];
	mcp: string[];
	resources: string[];
}

export interface ControlledPluginManifest {
	schemaVersion: 1;
	id: string;
	version: string;
	minimumPiVersion?: string;
	capabilities: PluginCapabilities;
	integrity: Readonly<Record<string, string>>;
}

export interface InspectedPluginFile {
	kind: PluginCapabilityKind;
	relativePath: string;
	absolutePath: string;
	bytes: number;
	integrity: string;
}

export interface PluginInspection {
	root: string;
	manifestPath: string;
	manifest: ControlledPluginManifest;
	fingerprint: string;
	files: InspectedPluginFile[];
}

export interface RegisteredPlugin extends PluginInspection {
	source: string;
	enabled: boolean;
	requiresConfirmation: boolean;
}

export interface ResolvedPluginCapabilities {
	extensions: string[];
	skills: string[];
	mcp: string[];
	resources: Array<{ pluginId: string; relativePath: string; absolutePath: string }>;
}
