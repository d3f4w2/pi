import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export class PanelHeaderComponent implements Component {
	private readonly title: string;

	constructor(title: string) {
		this.title = title;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const titleWidth = Math.max(1, safeWidth - 4);
		const title = truncateToWidth(this.title.replace(/[\r\n\t]/g, " ").trim(), titleWidth, "");
		const lead = `${theme.fg("accent", "›")} ${theme.bold(theme.fg("text", title))}`;
		const railWidth = Math.max(0, safeWidth - visibleWidth(lead) - 1);
		return [truncateToWidth(`${lead} ${theme.fg("borderMuted", "─".repeat(railWidth))}`, safeWidth, "")];
	}
}

export class PanelHintComponent implements Component {
	private readonly hints: string[];

	constructor(hints: string[]) {
		this.hints = hints;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const hint = this.hints
			.map((item) => item.replace(/[\r\n\t]/g, " ").trim())
			.filter((item) => item.length > 0)
			.join(" · ");
		return [theme.fg("dim", truncateToWidth(`  ${hint}`, Math.max(1, width), ""))];
	}
}
