import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface ChoiceOption {
	label: string;
	value?: string;
	description?: string;
}

interface NormalizedOption {
	label: string;
	value: string;
	description?: string;
}

interface ChoiceSelection {
	label: string;
	value: string;
	index?: number;
	custom?: boolean;
}

interface ChoiceDetails {
	mode: "single" | "multiple";
	question: string;
	options: NormalizedOption[];
	selected: ChoiceSelection[];
	cancelled: boolean;
}

interface SingleChoiceParams {
	question: string;
	options: ChoiceOption[];
	allowOther?: boolean;
	otherLabel?: string;
}

interface MultipleChoiceParams extends SingleChoiceParams {
	minSelections?: number;
	maxSelections?: number;
	defaultSelectedValues?: string[];
}

interface ChoiceQuestionParams extends MultipleChoiceParams {
	id?: string;
	label?: string;
	mode?: "single" | "multiple" | "multi" | string;
}

interface NormalizedQuestion {
	id: string;
	label: string;
	mode: "single" | "multiple";
	question: string;
	options: NormalizedOption[];
	allowOther: boolean;
	otherLabel: string;
	minSelections: number;
	maxSelections?: number;
	defaultSelectedValues: string[];
}

interface ChoiceQuestionnaireParams {
	title?: string;
	questions: ChoiceQuestionParams[];
}

interface ChoiceQuestionAnswer {
	id: string;
	label: string;
	mode: "single" | "multiple";
	question: string;
	selected: ChoiceSelection[];
}

interface ChoiceQuestionnaireDetails {
	title?: string;
	questions: Array<Omit<NormalizedQuestion, "defaultSelectedValues">>;
	answers: ChoiceQuestionAnswer[];
	cancelled: boolean;
}

type Done<T> = (result: T) => void;

const OptionSchema = Type.Object({
	label: Type.String({ description: "Human-readable option label shown to the user" }),
	value: Type.Optional(Type.String({ description: "Stable machine-readable value; defaults to label" })),
	description: Type.Optional(Type.String({ description: "Short secondary text shown below or next to the label" })),
});

const SingleChoiceSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { minItems: 1, description: "The available choices" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow a freeform other answer. Default: true" })),
	otherLabel: Type.Optional(Type.String({ description: "Label for the freeform other row" })),
});

const MultipleChoiceSchema = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { minItems: 1, description: "The available choices" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow a freeform other answer. Default: true" })),
	otherLabel: Type.Optional(Type.String({ description: "Label for the freeform other row" })),
	minSelections: Type.Optional(Type.Number({ minimum: 0, description: "Minimum selected choices before submit. Default: 0" })),
	maxSelections: Type.Optional(Type.Number({ minimum: 1, description: "Maximum selected choices. Omit for no limit" })),
	defaultSelectedValues: Type.Optional(
		Type.Array(Type.String(), { description: "Option values that should start selected" }),
	),
});

const ChoiceQuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable id for this question; defaults to q1, q2, ..." })),
	label: Type.Optional(Type.String({ description: "Short tab label, e.g. Scope, Edge cases, Tests" })),
	mode: Type.Optional(Type.String({ description: "\"single\" or \"multiple\". Defaults to \"single\"" })),
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(OptionSchema, { minItems: 1, description: "The available choices" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow a freeform other answer. Default: true" })),
	otherLabel: Type.Optional(Type.String({ description: "Label for the freeform other row" })),
	minSelections: Type.Optional(Type.Number({ minimum: 0, description: "For multiple mode: minimum selected choices" })),
	maxSelections: Type.Optional(Type.Number({ minimum: 1, description: "For multiple mode: maximum selected choices" })),
	defaultSelectedValues: Type.Optional(
		Type.Array(Type.String(), { description: "For multiple mode: option values that should start selected" }),
	),
});

const ChoiceQuestionnaireSchema = Type.Object({
	title: Type.Optional(Type.String({ description: "Short title for the batch of questions" })),
	questions: Type.Array(ChoiceQuestionSchema, {
		minItems: 1,
		description: "Questions to ask in one tabbed UI so the agent receives all answers in one result",
	}),
});

function normalizeOptions(options: ChoiceOption[]): NormalizedOption[] {
	return options.map((option) => ({
		label: option.label,
		value: option.value ?? option.label,
		description: option.description,
	}));
}

function normalizeQuestion(question: ChoiceQuestionParams, index: number): NormalizedQuestion {
	const mode = question.mode === "multiple" || question.mode === "multi" ? "multiple" : "single";
	return {
		id: question.id || `q${index + 1}`,
		label: question.label || `Q${index + 1}`,
		mode,
		question: question.question,
		options: normalizeOptions(question.options),
		allowOther: question.allowOther !== false,
		otherLabel: question.otherLabel ?? (mode === "multiple" ? "something else…" : "other…"),
		minSelections: Math.max(0, Math.floor(question.minSelections ?? 0)),
		maxSelections: question.maxSelections === undefined ? undefined : Math.max(1, Math.floor(question.maxSelections)),
		defaultSelectedValues: question.defaultSelectedValues ?? [],
	};
}

function padAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, Math.max(0, width), "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function isPrintable(data: string): boolean {
	if (!data) return false;
	if (data.includes("\x1b")) return false;
	return [...data].every((ch) => {
		const code = ch.charCodeAt(0);
		return code >= 32 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
	});
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const part = result.content[0];
	return part?.type === "text" ? (part.text ?? "") : "";
}

function noUiDetails(mode: "single" | "multiple", question: string, options: NormalizedOption[]): ChoiceDetails {
	return { mode, question, options, selected: [], cancelled: true };
}

function formatSelection(selection: ChoiceSelection): string {
	if (selection.custom) return `custom: ${selection.label}`;
	return selection.index ? `${selection.index}. ${selection.label}` : selection.label;
}

class SingleChoicePicker {
	private readonly input = new Input();
	private activeIndex = 0;
	private inputMode = false;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private _focused = false;

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: any,
		private readonly question: string,
		private readonly options: NormalizedOption[],
		private readonly allowOther: boolean,
		private readonly otherLabel: string,
		private readonly done: Done<ChoiceSelection | null>,
	) {
		this.input.onSubmit = (value) => this.submitOther(value);
		this.input.onEscape = () => this.stopInputMode();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.inputMode;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const add = (line = "") => lines.push(truncateToWidth(line, width, ""));
		const activeIsOther = this.allowOther && this.activeIndex === this.options.length;

		add(`${this.theme.fg("success", this.theme.bold("?"))}  ${this.theme.fg("text", this.theme.bold(this.question))}`);
		add("");

		for (let i = 0; i < this.options.length; i++) {
			const option = this.options[i]!;
			const active = this.activeIndex === i;
			const mark = active ? "◉" : "◯";
			const pillText = ` ${mark}  ${option.label} `;
			const pill = active
				? this.theme.bg("selectedBg", this.theme.fg("success", this.theme.bold(pillText)))
				: this.theme.fg("dim", pillText);
			add(`  ${pill}`);
			if (option.description) {
				add(`     ${active ? this.theme.fg("muted", option.description) : this.theme.fg("dim", option.description)}`);
			}
		}

		if (this.allowOther) {
			const value = this.input.getValue().trim();
			const label = value || this.otherLabel;
			const mark = activeIsOther ? "◉" : "◯";
			const otherText = ` ${mark}  ${label} `;
			const otherPill = activeIsOther
				? this.theme.bg("selectedBg", this.theme.fg("warning", this.theme.bold(otherText)))
				: this.theme.fg("warning", otherText);
			add(`  ${otherPill}`);
			if (activeIsOther && this.inputMode) {
				for (const inputLine of this.input.render(Math.max(1, width - 5))) {
					add(`     ${inputLine}`);
				}
			}
		}

		add("");
		const help = this.inputMode
			? "[enter] use custom answer · [esc] back"
			: "[tab/↑↓] move · [enter] confirm choice · [esc] cancel";
		add(this.theme.fg("dim", help));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): void {
		if (this.inputMode) {
			this.input.handleInput(data);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.down) || matchesKey(data, Key.right)) {
			this.move(1);
			return;
		}

		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up) || matchesKey(data, Key.left)) {
			this.move(-1);
			return;
		}

		const numeric = data.length === 1 ? Number(data) : Number.NaN;
		if (Number.isInteger(numeric) && numeric >= 1 && numeric <= this.options.length) {
			this.activeIndex = numeric - 1;
			this.refresh();
			return;
		}

		if (this.allowOther && (data === "+" || (isPrintable(data) && this.activeIndex === this.options.length))) {
			this.activeIndex = this.options.length;
			this.startInputMode(data === "+" ? undefined : data);
			return;
		}

		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			this.confirm();
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.input.invalidate();
	}

	private move(delta: number): void {
		const count = this.options.length + (this.allowOther ? 1 : 0);
		this.activeIndex = (this.activeIndex + delta + count) % count;
		this.refresh();
	}

	private confirm(): void {
		if (this.allowOther && this.activeIndex === this.options.length) {
			const value = this.input.getValue().trim();
			if (value) {
				this.submitOther(value);
			} else {
				this.startInputMode();
			}
			return;
		}

		const option = this.options[this.activeIndex];
		if (!option) return;
		this.done({ label: option.label, value: option.value, index: this.activeIndex + 1 });
	}

	private startInputMode(initial?: string): void {
		this.inputMode = true;
		this.input.focused = this._focused;
		if (initial) this.input.setValue(this.input.getValue() + initial);
		this.refresh();
	}

	private stopInputMode(): void {
		this.inputMode = false;
		this.input.focused = false;
		this.refresh();
	}

	private submitOther(value: string): void {
		const trimmed = value.trim();
		if (!trimmed) {
			this.stopInputMode();
			return;
		}
		this.done({ label: trimmed, value: trimmed, custom: true });
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}
}

class MultipleChoicePicker {
	private readonly input = new Input();
	private readonly checked = new Set<number>();
	private focusIndex = 0;
	private inputMode = false;
	private warning: string | undefined;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private _focused = false;

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: any,
		private readonly question: string,
		private readonly options: NormalizedOption[],
		private readonly allowOther: boolean,
		private readonly otherLabel: string,
		defaultSelectedValues: string[],
		private readonly minSelections: number,
		private readonly maxSelections: number | undefined,
		private readonly done: Done<ChoiceSelection[] | null>,
	) {
		const defaults = new Set(defaultSelectedValues);
		for (let i = 0; i < this.options.length; i++) {
			if (defaults.has(this.options[i]!.value)) this.checked.add(i);
		}
		this.input.onSubmit = (value) => {
			const trimmed = value.trim();
			if (trimmed) this.checked.add(-1);
			this.inputMode = false;
			this.input.focused = false;
			this.refresh();
		};
		this.input.onEscape = () => {
			this.inputMode = false;
			this.input.focused = false;
			this.refresh();
		};
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.inputMode;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const add = (line = "") => lines.push(truncateToWidth(line, width, ""));
		const suffix = this.theme.fg("dim", " · choose any");
		add(`${this.theme.fg("success", this.theme.bold("?"))}  ${this.theme.fg("text", this.theme.bold(this.question))}${suffix}`);
		add("");

		for (let i = 0; i < this.options.length; i++) {
			add(this.renderCell(i, width));
		}

		if (this.allowOther) {
			const otherIndex = this.options.length;
			const focused = this.focusIndex === otherIndex;
			const selected = this.checked.has(-1);
			const value = this.input.getValue().trim();
			const marker = selected ? this.theme.fg("success", this.theme.bold("[✓]")) : this.theme.fg("warning", "[+] ");
			const text = value || this.otherLabel;
			let row = ` ${marker}  ${this.theme.fg(selected ? "warning" : "dim", text)}`;
			if (focused) row = this.theme.bg("selectedBg", row);
			add(row);
			if (focused && this.inputMode) {
				for (const inputLine of this.input.render(Math.max(1, width - 3))) {
					add(`   ${inputLine}`);
				}
			}
		}

		add("");
		if (this.warning) add(this.theme.fg("warning", this.warning));
		const count = this.selectionCount();
		const limitText = this.maxSelections ? ` · max ${this.maxSelections}` : "";
		add(
			`${this.theme.fg("dim", "[↑↓/tab] move · [space] toggle · [enter] commit · [esc] cancel · ")}${this.theme.fg(
				count > 0 ? "success" : "dim",
				`${count} picked`,
			)}${this.theme.fg("dim", limitText)}`,
		);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): void {
		if (this.inputMode) {
			this.input.handleInput(data);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) {
			this.move(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.move(1);
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.move(-1);
			return;
		}

		const numeric = data.length === 1 ? Number(data) : Number.NaN;
		if (Number.isInteger(numeric) && numeric >= 1 && numeric <= this.options.length) {
			this.toggle(numeric - 1);
			return;
		}

		if (this.allowOther && data === "+") {
			this.focusIndex = this.options.length;
			this.startOtherInput();
			return;
		}

		if (matchesKey(data, Key.space)) {
			this.toggleFocused();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.submit();
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.input.invalidate();
	}

	private renderCell(index: number, width: number): string {
		const option = this.options[index]!;
		const selected = this.checked.has(index);
		const focused = this.focusIndex === index;
		const marker = selected ? this.theme.fg("success", this.theme.bold("[✓]")) : this.theme.fg("dim", "[ ]");
		const label = selected ? this.theme.fg("text", this.theme.bold(option.label)) : this.theme.fg("text", option.label);
		let cell = ` ${marker}  ${label}`;
		if (focused) cell = this.theme.bg("selectedBg", cell);
		return padAnsi(cell, width);
	}

	private move(delta: number): void {
		const count = this.options.length + (this.allowOther ? 1 : 0);
		this.focusIndex = (this.focusIndex + delta + count) % count;
		this.warning = undefined;
		this.refresh();
	}

	private toggleFocused(): void {
		if (this.allowOther && this.focusIndex === this.options.length) {
			if (this.checked.has(-1) && this.input.getValue().trim()) {
				this.checked.delete(-1);
				this.refresh();
			} else {
				this.startOtherInput();
			}
			return;
		}
		this.toggle(this.focusIndex);
	}

	private toggle(index: number): void {
		this.warning = undefined;
		if (this.checked.has(index)) {
			this.checked.delete(index);
			this.refresh();
			return;
		}
		if (this.maxSelections !== undefined && this.selectionCount() >= this.maxSelections) {
			this.warning = `Select at most ${this.maxSelections} option${this.maxSelections === 1 ? "" : "s"}.`;
			this.refresh();
			return;
		}
		this.checked.add(index);
		this.refresh();
	}

	private startOtherInput(): void {
		this.inputMode = true;
		this.input.focused = this._focused;
		this.warning = undefined;
		this.refresh();
	}

	private submit(): void {
		const count = this.selectionCount();
		if (count < this.minSelections) {
			this.warning = `Select at least ${this.minSelections} option${this.minSelections === 1 ? "" : "s"}.`;
			this.refresh();
			return;
		}
		const selections: ChoiceSelection[] = [];
		for (let i = 0; i < this.options.length; i++) {
			if (!this.checked.has(i)) continue;
			const option = this.options[i]!;
			selections.push({ label: option.label, value: option.value, index: i + 1 });
		}
		const other = this.input.getValue().trim();
		if (this.checked.has(-1) && other) selections.push({ label: other, value: other, custom: true });
		this.done(selections);
	}

	private selectionCount(): number {
		let count = 0;
		for (const index of this.checked) {
			if (index === -1) {
				if (this.input.getValue().trim()) count++;
			} else {
				count++;
			}
		}
		return count;
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}
}

class ChoiceQuestionnairePicker {
	private readonly input = new Input();
	private readonly focusByQuestion: number[];
	private readonly checkedByQuestion = new Map<string, Set<number>>();
	private readonly otherValues = new Map<string, string>();
	private readonly answers = new Map<string, ChoiceQuestionAnswer>();
	private current = 0;
	private inputMode = false;
	private warning: string | undefined;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private _focused = false;

	constructor(
		private readonly tui: { requestRender(): void },
		private readonly theme: any,
		private readonly title: string | undefined,
		private readonly questions: NormalizedQuestion[],
		private readonly done: Done<ChoiceQuestionnaireDetails | null>,
	) {
		this.focusByQuestion = questions.map(() => 0);
		for (const question of questions) {
			if (question.mode !== "multiple") continue;
			const checked = this.getChecked(question);
			const defaults = new Set(question.defaultSelectedValues);
			for (let i = 0; i < question.options.length; i++) {
				if (defaults.has(question.options[i]!.value)) checked.add(i);
			}
		}
		this.input.onSubmit = (value) => this.submitOther(value);
		this.input.onEscape = () => this.stopInputMode();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value && this.inputMode;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

		const lines: string[] = [];
		const add = (line = "") => lines.push(truncateToWidth(line, width, ""));
		const question = this.currentQuestion();
		if (!question) return [];

		if (this.title) add(this.theme.fg("accent", this.theme.bold(this.title)));
		for (const tabLine of this.renderTabs(width)) add(tabLine);
		add("");
		const modeHint = question.mode === "multiple" ? " · choose any" : " · choose one";
		add(
			`${this.theme.fg("success", this.theme.bold("?"))}  ${this.theme.fg("text", this.theme.bold(question.question))}${this.theme.fg(
				"dim",
				modeHint,
			)}`,
		);
		add("");

		for (let i = 0; i < question.options.length; i++) {
			add(this.renderOption(question, i, width));
			const description = question.options[i]?.description;
			if (description) add(`     ${this.theme.fg(this.focusIndex() === i ? "muted" : "dim", description)}`);
		}

		if (question.allowOther) {
			add(this.renderOther(question, width));
			if (this.focusIndex() === question.options.length && this.inputMode) {
				for (const inputLine of this.input.render(Math.max(1, width - 5))) {
					add(`     ${inputLine}`);
				}
			}
		}

		add("");
		if (this.warning) add(this.theme.fg("warning", this.warning));
		const answered = this.answers.size;
		const total = this.questions.length;
		const action = question.mode === "multiple" ? "[space] toggle · [enter] next" : "[enter] choose";
		add(
			`${this.theme.fg("dim", `[←→/tab] question · [↑↓] option · ${action} · [esc] cancel · `)}${this.theme.fg(
				answered > 0 ? "success" : "dim",
				`${answered}/${total} answered`,
			)}`,
		);

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	handleInput(data: string): void {
		if (this.inputMode) {
			this.input.handleInput(data);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.switchQuestion(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.switchQuestion(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveFocus(1);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveFocus(-1);
			return;
		}

		const question = this.currentQuestion();
		if (!question) return;

		const numeric = data.length === 1 ? Number(data) : Number.NaN;
		if (Number.isInteger(numeric) && numeric >= 1 && numeric <= question.options.length) {
			this.activateIndex(question, numeric - 1);
			return;
		}

		if (question.allowOther && data === "+") {
			this.setFocusIndex(question.options.length);
			this.activateIndex(question, question.options.length);
			return;
		}

		if (matchesKey(data, Key.space)) {
			if (question.mode === "multiple") {
				this.activateIndex(question, this.focusIndex());
			} else {
				this.activateIndex(question, this.focusIndex());
			}
			return;
		}

		if (matchesKey(data, Key.enter)) {
			if (question.mode === "multiple") {
				if (this.commitMultiple(question)) this.advanceOrFinish();
			} else {
				this.activateIndex(question, this.focusIndex());
			}
		}
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.input.invalidate();
	}

	private renderTabs(width: number): string[] {
		const lines: string[] = [];
		let line = "";
		for (let i = 0; i < this.questions.length; i++) {
			const question = this.questions[i]!;
			const active = i === this.current;
			const answered = this.answers.has(question.id);
			const mark = answered ? "✓" : "·";
			const raw = ` ${mark} ${question.label} `;
			const styled = active
				? this.theme.bg("selectedBg", this.theme.fg("text", raw))
				: this.theme.fg(answered ? "success" : "dim", raw);
			const candidate = line ? `${line} ${styled}` : styled;
			if (visibleWidth(candidate) > width && line) {
				lines.push(truncateToWidth(line, width, ""));
				line = styled;
			} else {
				line = candidate;
			}
		}
		if (line) lines.push(truncateToWidth(line, width, ""));
		return lines;
	}

	private renderOption(question: NormalizedQuestion, index: number, width: number): string {
		const option = question.options[index]!;
		const focused = this.focusIndex() === index;
		const selected = this.isSelected(question, index);
		const marker =
			question.mode === "multiple"
				? selected
					? this.theme.fg("success", this.theme.bold("[✓]"))
					: this.theme.fg("dim", "[ ]")
				: selected
					? this.theme.fg("success", this.theme.bold("◉"))
					: this.theme.fg("dim", "◯");
		const label = selected ? this.theme.fg("text", this.theme.bold(option.label)) : this.theme.fg("text", option.label);
		let row = ` ${marker}  ${label}`;
		if (focused) row = this.theme.bg("selectedBg", row);
		return padAnsi(row, width);
	}

	private renderOther(question: NormalizedQuestion, width: number): string {
		const focused = this.focusIndex() === question.options.length;
		const selected = this.isSelected(question, -1);
		const value = this.otherValues.get(question.id)?.trim();
		const marker =
			question.mode === "multiple"
				? selected
					? this.theme.fg("success", this.theme.bold("[✓]"))
					: this.theme.fg("warning", "[+]")
				: selected
					? this.theme.fg("warning", this.theme.bold("◉"))
					: this.theme.fg("warning", "◯");
		const label = value || question.otherLabel;
		let row = ` ${marker}  ${this.theme.fg(selected ? "warning" : "dim", label)}`;
		if (focused) row = this.theme.bg("selectedBg", row);
		return padAnsi(row, width);
	}

	private currentQuestion(): NormalizedQuestion | undefined {
		return this.questions[this.current];
	}

	private focusIndex(): number {
		return this.focusByQuestion[this.current] ?? 0;
	}

	private setFocusIndex(index: number): void {
		this.focusByQuestion[this.current] = index;
	}

	private totalItems(question: NormalizedQuestion): number {
		return question.options.length + (question.allowOther ? 1 : 0);
	}

	private switchQuestion(delta: number): void {
		this.current = (this.current + delta + this.questions.length) % this.questions.length;
		this.warning = undefined;
		this.inputMode = false;
		this.input.focused = false;
		this.refresh();
	}

	private moveFocus(delta: number): void {
		const question = this.currentQuestion();
		if (!question) return;
		const total = this.totalItems(question);
		this.setFocusIndex((this.focusIndex() + delta + total) % total);
		this.warning = undefined;
		this.refresh();
	}

	private activateIndex(question: NormalizedQuestion, index: number): void {
		this.warning = undefined;
		if (question.allowOther && index === question.options.length) {
			this.startOtherInput(question);
			return;
		}

		if (question.mode === "multiple") {
			this.toggleMultiple(question, index);
			return;
		}

		const option = question.options[index];
		if (!option) return;
		this.saveAnswer(question, [{ label: option.label, value: option.value, index: index + 1 }]);
		this.advanceOrFinish();
	}

	private startOtherInput(question: NormalizedQuestion): void {
		this.input.setValue(this.otherValues.get(question.id) ?? "");
		this.inputMode = true;
		this.input.focused = this._focused;
		this.refresh();
	}

	private stopInputMode(): void {
		this.inputMode = false;
		this.input.focused = false;
		this.refresh();
	}

	private submitOther(value: string): void {
		const question = this.currentQuestion();
		if (!question) return;
		const trimmed = value.trim();
		if (!trimmed) {
			this.stopInputMode();
			return;
		}

		if (question.mode === "multiple") {
			const checked = this.getChecked(question);
			if (!checked.has(-1) && question.maxSelections !== undefined && this.selectionCount(question) >= question.maxSelections) {
				this.warning = `Select at most ${question.maxSelections} option${question.maxSelections === 1 ? "" : "s"}.`;
				this.stopInputMode();
				return;
			}
			this.otherValues.set(question.id, trimmed);
			checked.add(-1);
			this.stopInputMode();
			return;
		}

		this.otherValues.set(question.id, trimmed);
		this.saveAnswer(question, [{ label: trimmed, value: trimmed, custom: true }]);
		this.inputMode = false;
		this.input.focused = false;
		this.advanceOrFinish();
	}

	private toggleMultiple(question: NormalizedQuestion, index: number): void {
		const checked = this.getChecked(question);
		if (checked.has(index)) {
			checked.delete(index);
			this.updateCommittedMultiple(question);
			this.refresh();
			return;
		}
		if (question.maxSelections !== undefined && this.selectionCount(question) >= question.maxSelections) {
			this.warning = `Select at most ${question.maxSelections} option${question.maxSelections === 1 ? "" : "s"}.`;
			this.refresh();
			return;
		}
		checked.add(index);
		this.updateCommittedMultiple(question);
		this.refresh();
	}

	private commitMultiple(question: NormalizedQuestion): boolean {
		const count = this.selectionCount(question);
		if (count < question.minSelections) {
			this.warning = `Select at least ${question.minSelections} option${question.minSelections === 1 ? "" : "s"}.`;
			this.refresh();
			return false;
		}
		this.saveAnswer(question, this.getSelections(question));
		return true;
	}

	private updateCommittedMultiple(question: NormalizedQuestion): void {
		if (!this.answers.has(question.id)) return;
		this.saveAnswer(question, this.getSelections(question));
	}

	private getChecked(question: NormalizedQuestion): Set<number> {
		let checked = this.checkedByQuestion.get(question.id);
		if (!checked) {
			checked = new Set<number>();
			this.checkedByQuestion.set(question.id, checked);
		}
		return checked;
	}

	private isSelected(question: NormalizedQuestion, index: number): boolean {
		if (question.mode === "multiple") {
			if (index === -1) return this.getChecked(question).has(-1) && Boolean(this.otherValues.get(question.id)?.trim());
			return this.getChecked(question).has(index);
		}
		const selected = this.answers.get(question.id)?.selected[0];
		if (!selected) return false;
		if (index === -1) return selected.custom === true;
		return selected.index === index + 1;
	}

	private selectionCount(question: NormalizedQuestion): number {
		let count = 0;
		for (const index of this.getChecked(question)) {
			if (index === -1) {
				if (this.otherValues.get(question.id)?.trim()) count++;
			} else {
				count++;
			}
		}
		return count;
	}

	private getSelections(question: NormalizedQuestion): ChoiceSelection[] {
		if (question.mode === "single") return this.answers.get(question.id)?.selected ?? [];
		const selections: ChoiceSelection[] = [];
		const checked = this.getChecked(question);
		for (let i = 0; i < question.options.length; i++) {
			if (!checked.has(i)) continue;
			const option = question.options[i]!;
			selections.push({ label: option.label, value: option.value, index: i + 1 });
		}
		const other = this.otherValues.get(question.id)?.trim();
		if (checked.has(-1) && other) selections.push({ label: other, value: other, custom: true });
		return selections;
	}

	private saveAnswer(question: NormalizedQuestion, selected: ChoiceSelection[]): void {
		this.answers.set(question.id, {
			id: question.id,
			label: question.label,
			mode: question.mode,
			question: question.question,
			selected,
		});
	}

	private allAnswered(): boolean {
		return this.questions.every((question) => this.answers.has(question.id));
	}

	private advanceOrFinish(): void {
		if (this.allAnswered()) {
			this.done(this.buildDetails(false));
			return;
		}
		for (let offset = 1; offset <= this.questions.length; offset++) {
			const next = (this.current + offset) % this.questions.length;
			if (!this.answers.has(this.questions[next]!.id)) {
				this.current = next;
				break;
			}
		}
		this.warning = undefined;
		this.inputMode = false;
		this.input.focused = false;
		this.refresh();
	}

	private buildDetails(cancelled: boolean): ChoiceQuestionnaireDetails {
		return {
			title: this.title,
			questions: this.questions.map((question) => ({
				id: question.id,
				label: question.label,
				mode: question.mode,
				question: question.question,
				options: question.options,
				allowOther: question.allowOther,
				otherLabel: question.otherLabel,
				minSelections: question.minSelections,
				maxSelections: question.maxSelections,
			})),
			answers: this.questions.flatMap((question) => {
				const answer = this.answers.get(question.id);
				return answer ? [answer] : [];
			}),
			cancelled,
		};
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}
}

async function askSingleChoice(ctx: ExtensionContext, params: SingleChoiceParams): Promise<ChoiceDetails> {
	const options = normalizeOptions(params.options);
	const allowOther = params.allowOther !== false;
	const otherLabel = params.otherLabel ?? "other…";

	if (!ctx.hasUI) return noUiDetails("single", params.question, options);
	if (options.length === 0) return noUiDetails("single", params.question, options);

	const selected = await ctx.ui.custom<ChoiceSelection | null>((tui, theme, _kb, done) => {
		return new SingleChoicePicker(tui, theme, params.question, options, allowOther, otherLabel, done);
	});

	return {
		mode: "single",
		question: params.question,
		options,
		selected: selected ? [selected] : [],
		cancelled: selected === null,
	};
}

async function askMultipleChoice(ctx: ExtensionContext, params: MultipleChoiceParams): Promise<ChoiceDetails> {
	const options = normalizeOptions(params.options);
	const allowOther = params.allowOther !== false;
	const otherLabel = params.otherLabel ?? "something else…";
	const minSelections = Math.max(0, Math.floor(params.minSelections ?? 0));
	const maxSelections = params.maxSelections === undefined ? undefined : Math.max(1, Math.floor(params.maxSelections));

	if (!ctx.hasUI) return noUiDetails("multiple", params.question, options);
	if (options.length === 0) return noUiDetails("multiple", params.question, options);

	const selected = await ctx.ui.custom<ChoiceSelection[] | null>((tui, theme, _kb, done) => {
		return new MultipleChoicePicker(
			tui,
			theme,
			params.question,
			options,
			allowOther,
			otherLabel,
			params.defaultSelectedValues ?? [],
			minSelections,
			maxSelections,
			done,
		);
	});

	return {
		mode: "multiple",
		question: params.question,
		options,
		selected: selected ?? [],
		cancelled: selected === null,
	};
}

function noUiQuestionnaireDetails(title: string | undefined, questions: NormalizedQuestion[]): ChoiceQuestionnaireDetails {
	return {
		title,
		questions: questions.map((question) => ({
			id: question.id,
			label: question.label,
			mode: question.mode,
			question: question.question,
			options: question.options,
			allowOther: question.allowOther,
			otherLabel: question.otherLabel,
			minSelections: question.minSelections,
			maxSelections: question.maxSelections,
		})),
		answers: [],
		cancelled: true,
	};
}

async function askChoiceQuestions(ctx: ExtensionContext, params: ChoiceQuestionnaireParams): Promise<ChoiceQuestionnaireDetails> {
	const questions = params.questions.map(normalizeQuestion).filter((question) => question.options.length > 0);
	if (!ctx.hasUI) return noUiQuestionnaireDetails(params.title, questions);
	if (questions.length === 0) return noUiQuestionnaireDetails(params.title, questions);

	const details = await ctx.ui.custom<ChoiceQuestionnaireDetails | null>((tui, theme, _kb, done) => {
		return new ChoiceQuestionnairePicker(tui, theme, params.title, questions, done);
	});

	return details ?? noUiQuestionnaireDetails(params.title, questions);
}

function renderCallSummary(name: string, question: string | undefined, options: unknown, theme: any) {
	const count = Array.isArray(options) ? options.length : 0;
	let text = theme.fg("toolTitle", theme.bold(`${name} `));
	text += theme.fg("muted", question ?? "");
	if (count) text += theme.fg("dim", ` (${count} option${count === 1 ? "" : "s"})`);
	return new Text(text, 0, 0);
}

function renderChoiceResult(result: { content: Array<{ type: string; text?: string }>; details?: ChoiceDetails }, theme: any) {
	const details = result.details;
	if (!details) return new Text(firstText(result), 0, 0);
	if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
	if (details.selected.length === 0) return new Text(theme.fg("dim", "No choices selected"), 0, 0);
	const lines = details.selected.map((selection) => {
		const label = formatSelection(selection);
		const prefix = selection.custom ? theme.fg("warning", "+ ") : theme.fg("success", "✓ ");
		return prefix + theme.fg(selection.custom ? "warning" : "accent", label);
	});
	return new Text(lines.join("\n"), 0, 0);
}

function formatAnswer(answer: ChoiceQuestionAnswer): string {
	if (answer.selected.length === 0) return "no selection";
	return answer.selected.map(formatSelection).join(", ");
}

function renderQuestionnaireResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ChoiceQuestionnaireDetails },
	theme: any,
) {
	const details = result.details;
	if (!details) return new Text(firstText(result), 0, 0);
	if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
	if (details.answers.length === 0) return new Text(theme.fg("dim", "No answers"), 0, 0);
	const lines = details.answers.map((answer) => {
		return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label)}: ${theme.fg("text", formatAnswer(answer))}`;
	});
	return new Text(lines.join("\n"), 0, 0);
}

export default function choicePickerExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "single_choice",
		label: "Single Choice",
		description:
			"Ask the user to pick exactly one option using pi's inline-pill choice picker UI. Use this instead of writing a plain numbered list when the user needs to choose one option.",
		promptSnippet: "Ask the user to choose exactly one option with an interactive inline-pill picker",
		promptGuidelines: [
			"Use single_choice whenever you need the user to choose exactly one option; do not ask with a plain numbered list unless the tool is unavailable.",
			"For single_choice, provide a concise question and an options array in the standard format: { label, value?, description? }. Use stable value strings when the label may change.",
		],
		parameters: SingleChoiceSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const details = await askSingleChoice(ctx, params as SingleChoiceParams);
			if (details.cancelled) {
				return { content: [{ type: "text", text: "User cancelled the single-choice question." }], details };
			}
			const selected = details.selected[0];
			return {
				content: [{ type: "text", text: selected ? `User selected: ${formatSelection(selected)}` : "No choice selected." }],
				details,
			};
		},
		renderCall(args, theme) {
			return renderCallSummary("single_choice", args.question, args.options, theme);
		},
		renderResult(result, _options, theme) {
			return renderChoiceResult(result, theme);
		},
	});

	pi.registerTool({
		name: "multiple_choice",
		label: "Multiple Choice",
		description:
			"Ask the user to pick zero or more options using pi's compact multi-select picker UI. Use this instead of writing a plain checkbox list when the user can choose multiple options.",
		promptSnippet: "Ask the user to choose any number of options with an interactive compact multi-select picker",
		promptGuidelines: [
			"Use multiple_choice whenever you need the user to choose any number of options; do not ask with a plain checkbox list unless the tool is unavailable.",
			"For multiple_choice, provide a concise question and an options array in the standard format: { label, value?, description? }. Set minSelections or maxSelections only when needed.",
		],
		parameters: MultipleChoiceSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const details = await askMultipleChoice(ctx, params as MultipleChoiceParams);
			if (details.cancelled) {
				return { content: [{ type: "text", text: "User cancelled the multiple-choice question." }], details };
			}
			const text = details.selected.length
				? `User selected ${details.selected.length} option${details.selected.length === 1 ? "" : "s"}: ${details.selected
						.map(formatSelection)
						.join(", ")}`
				: "User selected no options.";
			return { content: [{ type: "text", text }], details };
		},
		renderCall(args, theme) {
			return renderCallSummary("multiple_choice", args.question, args.options, theme);
		},
		renderResult(result, _options, theme) {
			return renderChoiceResult(result, theme);
		},
	});

	pi.registerTool({
		name: "choice_questions",
		label: "Choice Questions",
		description:
			"Ask the user a batch of single-choice and/or multiple-choice questions in one tabbed UI. Use when you have several clarifying questions so the user can answer one by one and the agent receives all answers in one result.",
		promptSnippet: "Ask several single/multiple choice questions in one tabbed picker and receive all answers at once",
		promptGuidelines: [
			"Use choice_questions when you have two or more clarifying questions; prefer it over asking multiple separate single_choice or multiple_choice questions.",
			"For choice_questions, provide { title?, questions: [{ id?, label?, mode?, question, options: [{ label, value?, description? }], allowOther?, minSelections?, maxSelections? }] }. Use short labels for the tab tags.",
		],
		parameters: ChoiceQuestionnaireSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const details = await askChoiceQuestions(ctx, params as ChoiceQuestionnaireParams);
			if (details.cancelled) {
				return { content: [{ type: "text", text: "User cancelled the batched choice questions." }], details };
			}
			const answerLines = details.answers.map((answer) => `${answer.label}: ${formatAnswer(answer)}`);
			return {
				content: [
					{
						type: "text",
						text: `User answered ${details.answers.length}/${details.questions.length} questions:\n${answerLines.join("\n")}`,
					},
				],
				details,
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			let text = theme.fg("toolTitle", theme.bold("choice_questions "));
			text += theme.fg("muted", args.title ?? `${count} question${count === 1 ? "" : "s"}`);
			if (args.title && count) text += theme.fg("dim", ` (${count} question${count === 1 ? "" : "s"})`);
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderQuestionnaireResult(result, theme);
		},
	});

	pi.registerCommand("choice-demo", {
		description: "Preview the single_choice, multiple_choice, and choice_questions pickers",
		handler: async (args, ctx) => {
			const mode = args.trim().toLowerCase();
			if (mode === "multi" || mode === "multiple" || mode === "m") {
				const details = await askMultipleChoice(ctx, {
					question: "Which stack pieces should I scaffold?",
					options: [
						{ label: "TypeScript + Vite frontend", value: "vite" },
						{ label: "Postgres + Drizzle ORM", value: "db" },
						{ label: "Auth (passkeys, sessions)", value: "auth" },
						{ label: "Stripe billing + webhooks", value: "billing" },
						{ label: "OpenAI streaming endpoint", value: "ai" },
					],
					defaultSelectedValues: ["vite", "db"],
				});
				ctx.ui.notify(
					details.cancelled ? "Cancelled" : `Picked: ${details.selected.map((s) => s.label).join(", ") || "none"}`,
					"info",
				);
				return;
			}

			if (mode === "batch" || mode === "questions" || mode === "q") {
				const details = await askChoiceQuestions(ctx, {
					title: "Clarifying questions",
					questions: [
						{
							id: "scope",
							label: "Scope",
							mode: "single",
							question: "How broad should this change be?",
							options: [
								{ label: "Minimal fix", value: "minimal" },
								{ label: "Balanced improvement", value: "balanced" },
								{ label: "Full polish", value: "full" },
							],
						},
						{
							id: "edges",
							label: "Edges",
							mode: "multiple",
							question: "Which edge cases should I cover?",
							options: [
								{ label: "Empty input", value: "empty" },
								{ label: "Invalid values", value: "invalid" },
								{ label: "Cancellation", value: "cancel" },
							],
							minSelections: 1,
						},
					],
				});
				ctx.ui.notify(
					details.cancelled ? "Cancelled" : `Answered: ${details.answers.map((answer) => `${answer.label}=${formatAnswer(answer)}`).join("; ")}`,
					"info",
				);
				return;
			}

			const details = await askSingleChoice(ctx, {
				question: "Where should I commit this change?",
				options: [
					{ label: "Existing branch · feat/picker-ctx", value: "existing" },
					{ label: "New branch off main", value: "new-main" },
					{ label: "New branch off feat/picker-ctx", value: "new-feature" },
				],
				otherLabel: "other branch name…",
			});
			ctx.ui.notify(
				details.cancelled ? "Cancelled" : `Picked: ${details.selected.map((s) => s.label).join(", ")}`,
				"info",
			);
		},
	});

	pi.on("before_agent_start", (event) => {
		const activeTools = new Set(pi.getActiveTools());
		const hasSingle = activeTools.has("single_choice");
		const hasMultiple = activeTools.has("multiple_choice");
		const hasQuestions = activeTools.has("choice_questions");
		if (!hasSingle && !hasMultiple && !hasQuestions) return;

		const lines = [
			"Choice picker standard format:",
			...(hasQuestions
				? [
						"- If you have two or more clarifying questions, prefer one choice_questions call so the user can answer every question in tabs and you receive all answers in one result.",
						"- For choice_questions, call { title?, questions: [{ id?, label?, mode: 'single' | 'multiple', question, options: [{ label, value?, description? }], allowOther?, minSelections?, maxSelections? }] }. Keep label short because it is shown as a tab tag.",
					]
				: []),
			...(hasSingle
				? [
						"- For exactly-one user decisions, call single_choice with { question, options: [{ label, value?, description? }], allowOther? } instead of writing a plain numbered list.",
					]
				: []),
			...(hasMultiple
				? [
						"- For choose-any user decisions, call multiple_choice with { question, options: [{ label, value?, description? }], minSelections?, maxSelections?, allowOther? } instead of writing a plain checkbox list.",
					]
				: []),
			"- After the choice tool returns, continue using the user's selected values.",
		];
		return { systemPrompt: `${event.systemPrompt}\n\n${lines.join("\n")}` };
	});
}
