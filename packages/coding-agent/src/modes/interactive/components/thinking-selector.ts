import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Container, type SelectItem, SelectList, type SelectListLayoutOptions, Spacer } from "@earendil-works/pi-tui";
import { t } from "../i18n/index.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { PanelHeaderComponent, PanelHintComponent } from "./panel-chrome.ts";

const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
		title = t("thinking.title"),
	) {
		super();

		const thinkingLevels: SelectItem[] = availableLevels.map((level) => ({
			value: level,
			label: level,
			description: t(`thinking.${level}.description`),
		}));

		this.addChild(new PanelHeaderComponent(title));
		this.addChild(new Spacer(1));

		// Create selector
		this.selectList = new SelectList(
			thinkingLevels,
			thinkingLevels.length,
			getSelectListTheme(),
			THINKING_SELECT_LIST_LAYOUT,
		);

		// Preselect current level
		const currentIndex = thinkingLevels.findIndex((item) => item.value === currentLevel);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			onSelect(item.value as ThinkingLevel);
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(
			new PanelHintComponent([
				`↑/↓ ${t("common.select")}`,
				`Enter ${t("common.confirm")}`,
				`Esc ${t("common.back")}`,
			]),
		);

		// Add bottom border
		this.addChild(new DynamicBorder((text) => theme.fg("borderMuted", text)));
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
