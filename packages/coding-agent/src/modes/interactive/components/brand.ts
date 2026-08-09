import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { t } from "../i18n/index.ts";
import { theme } from "../theme/theme.ts";

const FULL_PI = ["██████╗ ██╗", "██╔══██╗██║", "██████╔╝██║", "██╔═══╝ ██║", "██║     ██║", "╚═╝     ╚═╝"];
const FULL_GO = [
	" ██████╗  ██████╗",
	"██╔════╝ ██╔═══██╗",
	"██║  ███╗██║   ██║",
	"██║   ██║██║   ██║",
	"╚██████╔╝╚██████╔╝",
	" ╚═════╝  ╚═════╝",
];

const FULL_LOGO_LINES = FULL_PI.map((line, index) => `${line}─${FULL_GO[index]}`);
const COMPACT_LOGO_LINE = "pi-go  ━━━━━━━━━━━━━━━›";
const WORDMARK = "pi-go ›";

export const PI_GO_NAME = "pi-go";
export const PI_GO_LOADER_FRAMES = ["›··", "·›·", "··›"] as const;

export interface StartupDetailOptions {
	expanded: boolean;
	verbose: boolean;
}

export function shouldShowStartupDetails(options: StartupDetailOptions): boolean {
	return options.verbose || options.expanded;
}

export function getBrandLogoLines(width: number): string[] {
	if (width >= 60) return FULL_LOGO_LINES.map((line) => truncateToWidth(line, width, ""));
	if (width >= 32)
		return [COMPACT_LOGO_LINE, `       ${t("brand.tagline")}`].map((line) => truncateToWidth(line, width, ""));
	return [truncateToWidth(WORDMARK, Math.max(1, width), "")];
}

export interface BrandLogoOptions {
	version?: string;
	paddingX?: number;
	showTagline?: boolean;
}

export interface BrandHeaderOptions {
	version: string;
	collapsedText: () => string;
	expandedText: () => string;
	expanded?: boolean;
	paddingX?: number;
}

export class BrandLogoComponent implements Component {
	private readonly paddingX: number;
	private readonly showTagline: boolean;
	private readonly version: string | undefined;

	constructor(options: BrandLogoOptions = {}) {
		this.paddingX = Math.max(0, options.paddingX ?? 1);
		this.showTagline = options.showTagline ?? true;
		this.version = options.version;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const rawLines = getBrandLogoLines(contentWidth);
		const padding = " ".repeat(this.paddingX);
		const isFull = rawLines.length === FULL_LOGO_LINES.length;
		const isCompact = rawLines.length === 2;
		let lines: string[];

		if (isFull) {
			lines = FULL_PI.map((pi, index) => {
				const go = FULL_GO[index] ?? "";
				return theme.fg("accent", pi) + theme.fg("dim", "─") + theme.fg("text", go);
			});
		} else if (isCompact) {
			lines = [
				theme.bold(theme.fg("accent", "pi")) +
					theme.fg("dim", "-") +
					theme.bold(theme.fg("text", "go")) +
					theme.fg("accent", "  ━━━━━━━━━━━━━━━›"),
				theme.fg("muted", `       ${t("brand.tagline")}`),
			];
		} else {
			lines = [
				theme.bold(theme.fg("accent", "pi")) +
					theme.fg("dim", "-") +
					theme.bold(theme.fg("text", "go")) +
					theme.fg("accent", " ›"),
			];
		}

		if (!this.showTagline && lines.length > 1 && !isFull) lines = lines.slice(0, 1);
		if (this.showTagline && isFull) lines.push(theme.fg("muted", t("brand.tagline")));
		if (this.version) lines.push(theme.fg("dim", `v${this.version}`));

		return lines.map((line) => padding + truncateToWidth(line, contentWidth, ""));
	}
}

export class BrandHeaderComponent implements Component {
	private readonly collapsedText: () => string;
	private expanded: boolean;
	private readonly expandedText: () => string;
	private readonly logo: BrandLogoComponent;
	private readonly paddingX: number;

	constructor(options: BrandHeaderOptions) {
		this.collapsedText = options.collapsedText;
		this.expanded = options.expanded ?? false;
		this.expandedText = options.expandedText;
		this.paddingX = Math.max(0, options.paddingX ?? 1);
		this.logo = new BrandLogoComponent({ version: options.version, paddingX: this.paddingX });
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {
		this.logo.invalidate();
	}

	render(width: number): string[] {
		const body = new Text(this.expanded ? this.expandedText() : this.collapsedText(), this.paddingX, 0).render(width);
		return [...this.logo.render(width), "", ...body];
	}
}
