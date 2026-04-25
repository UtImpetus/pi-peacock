/**
 * pi-peacock
 *
 * Peacock-style repo identity for pi:
 * - repo-specific theme
 * - colored footer badge
 * - terminal title with repo + branch
 *
 * Interactive features:
 * - `/peacock` — opens a full TUI settings panel
 * - `/peacock theme <name>` — switch theme directly
 * - `/peacock label <text>` — set a custom label
 * - `/peacock toggle <feature>` — toggle status/branch/title on/off
 * - `/peacock emoji` — pick emoji for footer badge
 * - `/peacock reset` — clear all runtime overrides, back to file config
 * - Tab-complete for commands and themes
 * - Runtime overrides persist across reloads via session storage
 */

import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
	AutocompleteItem,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

const execFileAsync = promisify(execFile);

// Resolve themes directory relative to this extension file
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = path.resolve(EXTENSION_DIR, "..", "themes");
const OVERRIDES_FILE = path.join(os.homedir(), ".pi", "agent", ".peacock-state.json");

const STATUS_KEY = "pi-peacock";
const STATE_KEY = "pi-peacock-state";

const AUTO_THEMES = [
	"peacock-amber",
	"peacock-blue",
	"peacock-cyan",
	"peacock-green",
	"peacock-lime",
	"peacock-orange",
	"peacock-pink",
	"peacock-purple",
	"peacock-red",
	"peacock-rose",
	"peacock-sky",
	"peacock-teal",
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

type PeacockRule = {
	repo?: string;
	pathIncludes?: string | string[];
	theme?: string;
	label?: string;
	title?: string;
	status?: string;
};

type PeacockConfig = {
	autoAssignTheme?: boolean;
	fallbackLabel?: string;
	fallbackTheme?: string;
	rules?: PeacockRule[];
	showBranch?: boolean;
	showStatus?: boolean;
	showTitle?: boolean;
	titlePrefix?: string;
};

/** Settings the user can override at runtime via commands/UI */
type RuntimeOverrides = {
	theme?: string;
	label?: string;
	emoji?: string;
	showStatus?: boolean;
	showBranch?: boolean;
	showTitle?: boolean;
	footerLine?: boolean;
	footerLineColor?: string;
	footerLineWidth?: number;
};

/** Subset of RuntimeOverrides that are boolean toggles */
type ToggleKey = "showStatus" | "showBranch" | "showTitle";

type RepoInfo = {
	branch: string;
	cwd: string;
	gitRoot: string | null;
	repoName: string;
};

type IdentitySource = "rule" | "auto" | "fallback";

type ResolvedIdentity = {
	label: string;
	source: IdentitySource;
	status?: string;
	theme: string;
	title?: string;
};

type AppliedIdentity = {
	configPaths: string[];
	identity: ResolvedIdentity;
	repo: RepoInfo;
	signature: string;
};

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PeacockConfig = {
	autoAssignTheme: true,
	showBranch: true,
	showStatus: true,
	showTitle: true,
	titlePrefix: "π",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function git(cwd: string, ...args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd });
		return stdout.trim();
	} catch {
		return "";
	}
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

function hashString(value: string): number {
	let hash = 0;
	for (const char of value) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}
	return hash;
}

function asArray(value: string | string[] | undefined): string[] {
	if (!value) return [];
	return Array.isArray(value) ? value : [value];
}

function fillTemplate(template: string, repo: RepoInfo, label: string): string {
	return template
		.replaceAll("{repo}", repo.repoName)
		.replaceAll("{branch}", repo.branch)
		.replaceAll("{label}", label)
		.replaceAll("{cwd}", repo.cwd)
		.replaceAll("{gitRoot}", repo.gitRoot ?? "");
}

function pickAutoTheme(repoName: string): string {
	return AUTO_THEMES[hashString(repoName) % AUTO_THEMES.length] ?? "peacock-blue";
}

function ruleMatches(rule: PeacockRule, repo: RepoInfo): boolean {
	let hasSelector = false;

	if (rule.repo) {
		hasSelector = true;
		if (rule.repo !== repo.repoName) return false;
	}

	const pathIncludes = asArray(rule.pathIncludes);
	if (pathIncludes.length > 0) {
		hasSelector = true;
		const haystacks = [repo.cwd, repo.gitRoot ?? ""];
		const matched = pathIncludes.some((needle) =>
			haystacks.some((haystack) => haystack.includes(needle)),
		);
		if (!matched) return false;
	}

	return hasSelector;
}

// ─── Config Loading ──────────────────────────────────────────────────────────

async function readConfigFile(
	filePath: string,
	reportedErrors: Set<string>,
	notify: (msg: string) => void,
): Promise<PeacockConfig | undefined> {
	if (!(await exists(filePath))) return undefined;
	try {
		return JSON.parse(await readFile(filePath, "utf8")) as PeacockConfig;
	} catch (error) {
		if (!reportedErrors.has(filePath)) {
			reportedErrors.add(filePath);
			const message = error instanceof Error ? error.message : String(error);
			notify(`pi-peacock: failed to parse ${filePath} (${message})`);
		}
		return undefined;
	}
}

async function getRepoInfo(cwd: string): Promise<RepoInfo> {
	const gitRoot = (await git(cwd, "rev-parse", "--show-toplevel")) || null;
	const repoName = path.basename(gitRoot ?? cwd);
	const branch = gitRoot
		? (await git(cwd, "branch", "--show-current")) ||
		  (await git(cwd, "rev-parse", "--short", "HEAD"))
		: "";

	return { branch, cwd, gitRoot, repoName };
}

async function loadConfig(
	repo: RepoInfo,
	reportedErrors: Set<string>,
	notify: (msg: string) => void,
): Promise<{ config: PeacockConfig; configPaths: string[] }> {
	const globalConfigPath = path.join(os.homedir(), ".pi", "agent", "peacock.json");
	const projectConfigPath = path.join(repo.gitRoot ?? repo.cwd, ".pi", "peacock.json");
	const configPaths: string[] = [];

	const globalConfig = await readConfigFile(globalConfigPath, reportedErrors, notify);
	const projectConfig = await readConfigFile(projectConfigPath, reportedErrors, notify);

	if (globalConfig) configPaths.push(globalConfigPath);
	if (projectConfig) configPaths.push(projectConfigPath);

	return {
		config: {
			...globalConfig,
			...projectConfig,
			rules: [...(projectConfig?.rules ?? []), ...(globalConfig?.rules ?? [])],
		},
		configPaths,
	};
}

// ─── Identity Resolution ─────────────────────────────────────────────────────

function resolveIdentity(
	repo: RepoInfo,
	config: PeacockConfig,
	overrides: RuntimeOverrides,
): ResolvedIdentity {
	// 1. Try a config file rule
	const matchedRule = (config.rules ?? []).find((rule) => ruleMatches(rule, repo));
	if (matchedRule) {
		return {
			label: overrides.label ?? matchedRule.label ?? repo.repoName,
			source: "rule",
			status: matchedRule.status,
			theme: overrides.theme ?? matchedRule.theme ?? config.fallbackTheme ?? pickAutoTheme(repo.repoName),
			title: matchedRule.title,
		};
	}

	// 2. Auto-assign or fallback
	if (config.autoAssignTheme ?? DEFAULT_CONFIG.autoAssignTheme) {
		return {
			label: overrides.label ?? config.fallbackLabel ?? repo.repoName,
			source: "auto",
			theme: overrides.theme ?? pickAutoTheme(repo.repoName),
		};
	}

	return {
		label: overrides.label ?? config.fallbackLabel ?? repo.repoName,
		source: "fallback",
		theme: overrides.theme ?? config.fallbackTheme ?? "dark",
	};
}

function mergeFlags(
	config: PeacockConfig,
	overrides: RuntimeOverrides,
): { showStatus: boolean; showBranch: boolean; showTitle: boolean } {
	return {
		showStatus: overrides.showStatus ?? config.showStatus ?? DEFAULT_CONFIG.showStatus ?? true,
		showBranch: overrides.showBranch ?? config.showBranch ?? DEFAULT_CONFIG.showBranch ?? true,
		showTitle: overrides.showTitle ?? config.showTitle ?? DEFAULT_CONFIG.showTitle ?? true,
	};
}

// ─── Identity Display Helpers ────────────────────────────────────────────────

function getStatusText(
	ctx: ExtensionContext,
	repo: RepoInfo,
	identity: ResolvedIdentity,
	flags: { showStatus: boolean; showBranch: boolean },
	emojiOverride?: string,
): string | undefined {
	if (!flags.showStatus) return undefined;

	const badgeEmoji = emojiOverride ?? "🦚";
	const badge = ctx.ui.theme.fg("accent", `${badgeEmoji} ${identity.label}`);
	const branch =
		flags.showBranch && repo.branch
			? ctx.ui.theme.fg("dim", ` · ${repo.branch}`)
			: "";
	return `${badge}${branch}`;
}

function getTitle(
	repo: RepoInfo,
	identity: ResolvedIdentity,
	flags: { showTitle: boolean; showBranch: boolean },
	config: PeacockConfig,
): string | undefined {
	if (!flags.showTitle) return undefined;

	if (identity.title) {
		return fillTemplate(identity.title, repo, identity.label);
	}

	const branch = flags.showBranch && repo.branch ? ` · ${repo.branch}` : "";
	const prefix = config.titlePrefix ?? DEFAULT_CONFIG.titlePrefix;
	return `${prefix} ${identity.label}${branch}`.trim();
}

function getSignature(
	repo: RepoInfo,
	identity: ResolvedIdentity,
	flags: { showStatus: boolean; showBranch: boolean; showTitle: boolean },
): string {
	return JSON.stringify({
		branch: repo.branch,
		label: identity.label,
		showBranch: flags.showBranch,
		showStatus: flags.showStatus,
		showTitle: flags.showTitle,
		source: identity.source,
		theme: identity.theme,
	});
}

// ─── Dual-persistence state ─────────────────────────────────────────────────

function saveOverrides(pi: ExtensionAPI, overrides: RuntimeOverrides): void {
	pi.appendEntry(STATE_KEY, overrides);
	// Fire-and-forget disk write so overrides survive new sessions
	writeFile(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), "utf8").catch(() => {
		/* disk write suppressed */
	});
}

async function restoreOverrides(
	ctx: ExtensionContext,
	_reportedErrors: Set<string>,
): Promise<RuntimeOverrides> {
	// 1. Try session entries (most recent for current session)
	const stateEntry = [...ctx.sessionManager.getBranch()]
		.reverse()
		.find((e) => e.type === "custom" && e.customType === STATE_KEY);

	const data = stateEntry?.data as RuntimeOverrides | undefined;
	if (data) {
		const cleaned = normalizeOverrides(data);
		if (Object.keys(cleaned).length > 0) return cleaned;
	}

	// 2. Fall back to disk file (survives new sessions)
	try {
		const content = await readFile(OVERRIDES_FILE, "utf8");
		const parsed = JSON.parse(content) as RuntimeOverrides | undefined;
		if (parsed) return normalizeOverrides(parsed);
	} catch { /* file missing or unreadable */ }

	return {};
}

function normalizeOverrides(data: RuntimeOverrides): RuntimeOverrides {
	const cleaned: RuntimeOverrides = {};
	if (data.theme) cleaned.theme = data.theme;
	if (data.label) cleaned.label = data.label;
	if (data.emoji) cleaned.emoji = data.emoji;
	if (data.footerLine !== undefined) cleaned.footerLine = data.footerLine;
	if (data.footerLineColor) cleaned.footerLineColor = data.footerLineColor;
	if (data.footerLineWidth !== undefined) cleaned.footerLineWidth = data.footerLineWidth;
	if (data.showStatus !== undefined) cleaned.showStatus = data.showStatus;
	if (data.showBranch !== undefined) cleaned.showBranch = data.showBranch;
	if (data.showTitle !== undefined) cleaned.showTitle = data.showTitle;
	return cleaned;
}

// ─── Interactive Settings UI ─────────────────────────────────────────────────

const SUBCOMMANDS = [
	"theme",
	"label",
	"toggle",
	"emoji",
	"reset",
	"status",
] as const;

// ─── Emoji Unicode ranges ────────────────────────────────────────────────────

interface EmojiRange {
	name: string;
	ranges: [number, number][];
}

const EMOJI_CATEGORIES: EmojiRange[] = [
	{ name: "Smileys", ranges: [[0x1f600, 0x1f64f]] },
	{ name: "Gestures", ranges: [[0x1f9b0, 0x1f9ff]] },
	{ name: "People", ranges: [[0x1f300, 0x1f3ff]] },
	{ name: "Animals", ranges: [[0x1f400, 0x1f4ff]] },
	{ name: "Food", ranges: [[0x1f32d, 0x1f37f]] },
	{ name: "Travel", ranges: [[0x1f680, 0x1f6ff]] },
	{ name: "Activities", ranges: [[0x1f3a0, 0x1f3ff]] },
	{ name: "Objects", ranges: [[0x1f4a0, 0x1f5ff]] },
	{
		name: "Symbols",
		ranges: [
			[0x2600, 0x26ff], [0x2700, 0x27bf], [0x2300, 0x23ff],
			[0x2934, 0x2935], [0x2b05, 0x2b55], [0x3030, 0x303d],
			[0x3297, 0x3299],
		],
	},
	{ name: "Flags", ranges: [[0x1f1e6, 0x1f1ff]] },
];

function getAllEmojiRanges(): [number, number][] {
	const all: [number, number][] = [];
	for (const cat of EMOJI_CATEGORIES) {
		for (const r of cat.ranges) all.push(r);
	}
	return all;
}

const ALL_EMOJI_PAGES: EmojiRange[] = [
	{ name: "All", ranges: getAllEmojiRanges() },
	...EMOJI_CATEGORIES,
];

function generateEmoji(ranges: [number, number][]): string[] {
	const result: string[] = [];
	const seen = new Set<number>();
	for (const [start, end] of ranges) {
		for (let cp = start; cp <= end; cp++) {
			if (seen.has(cp)) continue;
			seen.add(cp);
			if (cp >= 0xfe00 && cp <= 0xfe0f) continue;
			if (cp === 0x200d || cp === 0x200b || cp === 0xfeff) continue;
			try { result.push(String.fromCodePoint(cp)); } catch { /* skip */ }
		}
	}
	return result;
}

const EMOJI_PAGE_GRIDS: string[][] = ALL_EMOJI_PAGES.map((cat) =>
	generateEmoji(cat.ranges),
);

async function copyEmoji(text: string): Promise<void> {
	const platform = os.platform();
	try {
		if (platform === "darwin") {
			const proc = execFile("pbcopy", []);
			if (proc.stdin) { proc.stdin.end(text); }
			await new Promise<void>((resolve, reject) => {
				proc.on("exit", (c) => (c === 0 ? resolve() : reject()));
				proc.on("error", reject);
			});
			return;
		}
		if (platform === "linux") {
			try { await execFileAsync("wl-copy", [text]); return; } catch {}
			try { await execFileAsync("xclip", ["-selection", "clipboard"], { input: text }); return; } catch {}
			try { await execFileAsync("xsel", ["-b", "-i"], { input: text }); return; } catch {}
			return;
		}
		if (platform === "win32") {
			const proc = execFile("clip", []);
			if (proc.stdin) { proc.stdin.end(text); }
			await new Promise<void>((resolve, reject) => {
				proc.on("exit", (c) => (c === 0 ? resolve() : reject()));
				proc.on("error", reject);
			});
		}
	} catch { /* clipboard not available */ }
}

// ─── Footer line constants ───────────────────────────────────────────────────

const LINE_COLORS = ["accent", "border", "muted", "dim", "success", "warning", "error"] as const;

interface LineWidthOption {
	label: string;
	char: string;
	width: number;
}

const LINE_WIDTHS: LineWidthOption[] = [
	{ label: "dot", char: "·", width: 1 },
	{ label: "thin", char: "─", width: 2 },
	{ label: "dash", char: "┄", width: 3 },
	{ label: "hdash", char: "┅", width: 4 },
	{ label: "thick", char: "━", width: 5 },
	{ label: "block", char: "▬", width: 6 },
	{ label: "solid", char: "█", width: 7 },
];

/**
 * Interactive settings panel — replaces editor temporarily with a full TUI.
 * Supports two pages: "settings" (main) and "emoji" (emoji picker).
 */
async function showSettingsPanel(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	currentOverrides: RuntimeOverrides,
	currentConfig: PeacockConfig,
	currentIdentity: ResolvedIdentity,
	repo: RepoInfo,
	onChange: (overrides: RuntimeOverrides) => void,
): Promise<void> {
	await ctx.ui.custom((tui, theme, _kb, done) => {
		// ── Shared state ────────────────────────────────────────────────
		let page: "settings" | "emoji" | "labelEdit" = "settings";
		// Label edit state
		let labelBuffer = "";
		let labelCursor = 0;

		// Settings page state
		let overrides = { ...currentOverrides };
		const availableThemes = [...AUTO_THEMES];
		let selectedThemeIdx = overrides.theme
			? availableThemes.indexOf(overrides.theme as (typeof AUTO_THEMES)[number])
			: -1;
		if (selectedThemeIdx === -1)
			selectedThemeIdx = availableThemes.indexOf(currentIdentity.theme as (typeof AUTO_THEMES)[number]);
		if (selectedThemeIdx === -1) selectedThemeIdx = 0;

		const flags = mergeFlags(currentConfig, overrides);
		let labelText = overrides.label ?? currentIdentity.label;

		// Settings focus: 0=theme, 1=label, 2=status, 3=branch, 4=title,
		//   5=footerLine, 6=lineColor, 7=lineWidth, 8=emoji, 9=save, 10=cancel
		const TOTAL_SETTINGS_OPTIONS = 11;
		let focusIndex = 0;
		const footerLineOn = () => overrides.footerLine ?? false;
		let lineColorIdx = Math.max(0,
			LINE_COLORS.indexOf((overrides.footerLineColor ?? "muted") as any));
		let lineWidthIdx = Math.max(0,
			LINE_WIDTHS.findIndex((w) => w.width === (overrides.footerLineWidth ?? 2)));

		function clampFocus() {
			if (!footerLineOn()) {
				if (focusIndex === 6 || focusIndex === 7) focusIndex = 5;
			}
		}

		// Emoji picker state
		let emojiCategoryIdx = 0;
		let emojiCursorIdx = 0;
		const emojiCols = 8;

		// ── Helpers ──────────────────────────────────────────────────────

		function getThemeName(): string {
			return availableThemes[selectedThemeIdx] ?? currentIdentity.theme;
		}

		function currentEmojiList(): string[] {
			return EMOJI_PAGE_GRIDS[emojiCategoryIdx] ?? [];
		}

		function emojiTotalRows(): number {
			return Math.ceil(currentEmojiList().length / emojiCols);
		}

		// ── Rendering ────────────────────────────────────────────────────

		let cachedLines: string[] | undefined;

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			if (page === "emoji") return renderEmojiPage(lines, add, width);
			if (page === "labelEdit") return renderLabelEditPage(lines, add, width);
			return renderSettingsPage(lines, add, width);
		}

		function renderSettingsPage(lines: string[], add: (s: string) => void, width: number): string[] {
			const sel = (idx: number, text: string) =>
				focusIndex === idx ? theme.fg("accent", `▸ ${text}`) : `  ${text}`;
			const cur = (idx: number, text: string) =>
				focusIndex === idx ? theme.fg("accent", text) : theme.fg("text", text);

			add(theme.fg("accent", theme.bold(" ── pi-peacock settings ──")));
			lines.push("");

			add(theme.fg("dim", `   Repo: ${repo.repoName}  Branch: ${repo.branch}`));
			add(theme.fg("dim", `   Active rule: ${currentIdentity.source}`));
			lines.push("");

			// 1. Theme
			const tn = getThemeName();
			add(`${cur(0, "▸")}${focusIndex === 0 ? "" : " "} ${theme.fg("dim", "Theme:")}  ${theme.fg("accent", "■")} ${tn}${focusIndex === 0 ? theme.fg("dim", "  ← → browse") : ""}`);
			add(`   ${theme.fg("dim", availableThemes.map((t) => t === tn ? theme.fg("accent", "●") : "○").join(" "))}`);
			lines.push("");

			// 2. Label
			// 2. Label
			add(`${focusIndex === 1 ? theme.fg("accent", `▸ ${theme.fg("dim", "Label:")}  ${labelText}  ${theme.fg("dim", "Enter to edit")}`) : `  ${theme.fg("dim", "Label:")}  ${labelText}`}`);
			lines.push("");

			// 3-5. Toggles
			const tog = [["Status badge", flags.showStatus], ["Branch name", flags.showBranch], ["Terminal title", flags.showTitle]];
			for (let i = 0; i < 3; i++) {
				const idx = i + 2;
				const ch = tog[i][1] ? theme.fg("success", "☑") : theme.fg("dim", "☐");
				add(`${focusIndex === idx ? theme.fg("accent", "▸") : " "} ${ch} ${tog[i][0]}${focusIndex === idx ? theme.fg("dim", "  Enter/space to toggle") : ""}`);
			}
			lines.push("");

			// 6. Footer line toggle
			const lineCh = footerLineOn() ? theme.fg("success", "☑") : theme.fg("dim", "☐");
			add(`${focusIndex === 5 ? theme.fg("accent", "▸") : " "} ${lineCh} ${theme.fg("dim", "Footer line:")}${focusIndex === 5 ? theme.fg("dim", "  Enter/space to toggle") : ""}`);
			if (footerLineOn()) {
				// 7. Line color
				const lc = LINE_COLORS[lineColorIdx] ?? "muted";
				const lcSwatch = theme.fg(lc as any, "───");
				add(`${focusIndex === 6 ? theme.fg("accent", "▸") : " "}   ${theme.fg("dim", "Color:")}  ${lcSwatch} ${lc}${focusIndex === 6 ? theme.fg("dim", "  ← →") : ""}`);
				// 8. Line width
				const lw = LINE_WIDTHS[lineWidthIdx] ?? LINE_WIDTHS[0];
				add(`${focusIndex === 7 ? theme.fg("accent", "▸") : " "}   ${theme.fg("dim", "Width:")}  ${lw.char.repeat(5)} ${lw.label}${focusIndex === 7 ? theme.fg("dim", "  ← →") : ""}`);
			}
			lines.push("");

			// 9. Emoji badge
			const curEmoji = overrides.emoji ?? "🦚";
			add(`${focusIndex === 8 ? theme.fg("accent", "▸") : " "} ${theme.fg("dim", "Emoji badge:")}  ${curEmoji}${focusIndex === 8 ? theme.fg("dim", "  Enter to pick") : ""}`);
			lines.push("");

			// Preview
			add(theme.fg("dim", " ── Preview ──"));
			const pl = overrides.label ?? labelText;
			const previewBadge = `${curEmoji} ${pl}`;
			const bt = flags.showBranch && repo.branch ? theme.fg("dim", ` · ${repo.branch}`) : "";
			add(`   ${theme.fg("accent", previewBadge)}${bt}`);
			if (flags.showTitle) {
				const pfx = currentConfig.titlePrefix ?? DEFAULT_CONFIG.titlePrefix;
				add(`   ${theme.fg("dim", `Title: ${pfx} ${pl}${flags.showBranch && repo.branch ? ` · ${repo.branch}` : ""}`)}`);
			}
			lines.push("");

			// 10. Apply, 11. Cancel
			add(sel(9, theme.fg("success", "✓ Apply & close")));
			add(sel(10, theme.fg("muted", "✕ Cancel")));
			lines.push("");
			add(theme.fg("dim", " ↑↓ navigate · Enter select · Esc cancel"));

			return lines;
		}

		function renderEmojiPage(lines: string[], add: (s: string) => void, width: number): string[] {
			add(theme.fg("accent", theme.bold(" ── pick an emoji for the footer badge ──")));
			lines.push("");

			const tabParts: string[] = [];
			for (let i = 0; i < ALL_EMOJI_PAGES.length; i++) {
				const n = ALL_EMOJI_PAGES[i].name;
				tabParts.push(i === emojiCategoryIdx ? theme.fg("accent", `[${n}]`) : theme.fg("dim", n));
			}
			add(tabParts.join("  "));
			lines.push("");

			const emoji = currentEmojiList();
			if (emoji.length === 0) {
				add(theme.fg("muted", "  (no emoji in this category)"));
			} else {
				const total = emoji.length;
				const totalRows = emojiTotalRows();
				const visRows = Math.min(8, totalRows);
				const curRow = Math.floor(emojiCursorIdx / emojiCols);
				const startRow = Math.max(0, Math.min(curRow - Math.floor(visRows / 2), totalRows - visRows));
				const endRow = Math.min(startRow + visRows, totalRows);

				for (let r = startRow; r < endRow; r++) {
					let row = "";
					for (let c = 0; c < emojiCols; c++) {
						const idx = r * emojiCols + c;
						if (idx >= total) { row += "  "; continue; }
						row += idx === emojiCursorIdx ? theme.fg("accent", `[${emoji[idx]}]`) : ` ${emoji[idx]} `;
					}
					add(row);
				}

				if (totalRows > visRows) {
					const pct = Math.round((startRow / Math.max(1, totalRows - visRows)) * 100);
					add(theme.fg("dim", `  ${curRow + 1}/${totalRows} rows  ·  ${total} emoji  ·  ${pct}%`));
				}
			}

			lines.push("");
			add(theme.fg("dim", " ← → cats  ·  ↑↓←→ grid  ·  Enter pick  ·  Tab/1-9 jump  ·  Esc back"));
			return lines;
		}

		function renderLabelEditPage(lines: string[], add: (s: string) => void, _width: number): string[] {
			add(theme.fg("accent", theme.bold(" ── Edit label ──")));
			lines.push("");
			add(theme.fg("dim", "   Rename the repo badge shown in the footer:"));
			lines.push("");
			const before = labelBuffer.slice(0, labelCursor);
			const after = labelBuffer.slice(labelCursor);
			add("  " + theme.fg("accent", before) + theme.fg("success", "▁") + theme.fg("accent", after));
			lines.push("");
			add(theme.fg("dim", " Type text  ·  Enter confirm  ·  Esc cancel  ·  Backspace delete"));
			return lines;
		}

		// ── Input handling ────────────────────────────────────────────────

		function handleInput(data: string) {
			if (page === "emoji") { handleEmojiInput(data); return; }
			if (page === "labelEdit") { handleLabelEditInput(data); return; }
			handleSettingsInput(data);
		}

		function handleLabelEditInput(data: string) {
			// Backspace: DEL (0x7f) or BS (0x08)
			if (data === String.fromCharCode(0x7f) || data === String.fromCharCode(0x08)) {
				if (labelCursor > 0) {
					labelBuffer = labelBuffer.slice(0, labelCursor - 1) + labelBuffer.slice(labelCursor);
					labelCursor--;
					refresh();
				}
				return;
			}
			// Confirm
			if (matchesKey(data, Key.enter)) {
				const trimmed = labelBuffer.trim();
				if (trimmed) overrides.label = trimmed;
				onChange(overrides); saveOverrides(pi, overrides);
				labelText = overrides.label ?? labelText;
				page = "settings"; refresh();
				return;
			}
			// Cancel
			if (matchesKey(data, Key.escape)) {
				page = "settings"; refresh();
				return;
			}
			// Cursor left
			if (matchesKey(data, Key.left)) {
				labelCursor = Math.max(0, labelCursor - 1); refresh(); return;
			}
			// Cursor right
			if (matchesKey(data, Key.right)) {
				labelCursor = Math.min(labelBuffer.length, labelCursor + 1); refresh(); return;
			}
			// Ignore control characters (tabs, arrows, etc.)
			if (data.length === 1 && data.charCodeAt(0) < 0x20) return;
			if (data.startsWith(String.fromCharCode(0x1b))) return; // escape sequences
			if (data) {
				labelBuffer = labelBuffer.slice(0, labelCursor) + data + labelBuffer.slice(labelCursor);
				labelCursor += data.length;
				refresh();
			}
		}

		function handleSettingsInput(data: string) {
			if (matchesKey(data, Key.up)) {
				focusIndex = (focusIndex - 1 + TOTAL_SETTINGS_OPTIONS) % TOTAL_SETTINGS_OPTIONS;
				clampFocus();
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				focusIndex = (focusIndex + 1) % TOTAL_SETTINGS_OPTIONS;
				clampFocus();
				refresh();
				return;
			}
			if (matchesKey(data, Key.left)) {
				if (focusIndex === 0) {
					selectedThemeIdx = (selectedThemeIdx - 1 + availableThemes.length) % availableThemes.length;
					overrides.theme = availableThemes[selectedThemeIdx];
				} else if (focusIndex === 6 && footerLineOn()) {
					lineColorIdx = (lineColorIdx - 1 + LINE_COLORS.length) % LINE_COLORS.length;
					overrides.footerLineColor = LINE_COLORS[lineColorIdx];
				} else if (focusIndex === 7 && footerLineOn()) {
					lineWidthIdx = (lineWidthIdx - 1 + LINE_WIDTHS.length) % LINE_WIDTHS.length;
					overrides.footerLineWidth = LINE_WIDTHS[lineWidthIdx].width;
				}
				if (focusIndex === 0 || focusIndex === 6 || focusIndex === 7) {
					onChange(overrides);
					saveOverrides(pi, overrides);
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.right)) {
				if (focusIndex === 0) {
					selectedThemeIdx = (selectedThemeIdx + 1) % availableThemes.length;
					overrides.theme = availableThemes[selectedThemeIdx];
				} else if (focusIndex === 6 && footerLineOn()) {
					lineColorIdx = (lineColorIdx + 1) % LINE_COLORS.length;
					overrides.footerLineColor = LINE_COLORS[lineColorIdx];
				} else if (focusIndex === 7 && footerLineOn()) {
					lineWidthIdx = (lineWidthIdx + 1) % LINE_WIDTHS.length;
					overrides.footerLineWidth = LINE_WIDTHS[lineWidthIdx].width;
				}
				if (focusIndex === 0 || focusIndex === 6 || focusIndex === 7) {
					onChange(overrides);
					saveOverrides(pi, overrides);
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				if (focusIndex === 1) {
					labelBuffer = overrides.label ?? labelText;
					labelCursor = labelBuffer.length;
					page = "labelEdit";
					refresh();
					return;
				}
				if (focusIndex === 2) {
					flags.showStatus = !flags.showStatus;
					overrides.showStatus = flags.showStatus;
					onChange(overrides); saveOverrides(pi, overrides); refresh();
					return;
				}
				if (focusIndex === 3) {
					flags.showBranch = !flags.showBranch;
					overrides.showBranch = flags.showBranch;
					onChange(overrides); saveOverrides(pi, overrides); refresh();
					return;
				}
				if (focusIndex === 4) {
					flags.showTitle = !flags.showTitle;
					overrides.showTitle = flags.showTitle;
					onChange(overrides); saveOverrides(pi, overrides); refresh();
					return;
				}
				if (focusIndex === 5) {
					overrides.footerLine = !footerLineOn();
					if (!overrides.footerLine) {
						overrides.footerLineColor = undefined;
						overrides.footerLineWidth = undefined;
					}
					onChange(overrides); saveOverrides(pi, overrides); refresh();
					return;
				}
				if (focusIndex === 8) {
					page = "emoji";
					emojiCategoryIdx = 0;
					emojiCursorIdx = 0;
					refresh();
					return;
				}
				if (focusIndex === 9) {
					onChange(overrides); saveOverrides(pi, overrides); done();
					return;
				}
				if (focusIndex === 10) {
					done();
					return;
				}
			}
			if (matchesKey(data, Key.escape)) { done(); }
		}

		function handleEmojiInput(data: string) {
			const emoji = currentEmojiList();
			const total = emoji.length;
			const totalRows = emojiTotalRows();

			if (matchesKey(data, Key.left) && emojiCursorIdx > 0) { emojiCursorIdx--; refresh(); return; }
			if (matchesKey(data, Key.right) && emojiCursorIdx < total - 1) { emojiCursorIdx++; refresh(); return; }
			if (matchesKey(data, Key.up)) { emojiCursorIdx = Math.max(0, emojiCursorIdx - emojiCols); refresh(); return; }
			if (matchesKey(data, Key.down)) { emojiCursorIdx = Math.min(total - 1, emojiCursorIdx + emojiCols); refresh(); return; }
			if (matchesKey(data, "tab")) { emojiCategoryIdx = (emojiCategoryIdx + 1) % ALL_EMOJI_PAGES.length; emojiCursorIdx = 0; refresh(); return; }
			if (matchesKey(data, "shift+tab")) { emojiCategoryIdx = (emojiCategoryIdx - 1 + ALL_EMOJI_PAGES.length) % ALL_EMOJI_PAGES.length; emojiCursorIdx = 0; refresh(); return; }
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				if (total > 0 && emojiCursorIdx < total) {
					overrides.emoji = emoji[emojiCursorIdx];
					onChange(overrides); saveOverrides(pi, overrides);
					copyEmoji(emoji[emojiCursorIdx]);
					page = "settings";
					focusIndex = 8; // back to emoji badge item
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.escape)) { page = "settings"; refresh(); return; }

			const num = Number.parseInt(data, 10);
			if (!Number.isNaN(num) && num >= 1 && num <= ALL_EMOJI_PAGES.length) {
				emojiCategoryIdx = num - 1; emojiCursorIdx = 0; refresh(); return;
			}
			const letter = data.toLowerCase();
			if (/^[a-z]$/.test(letter)) {
				const start = (emojiCategoryIdx + 1) % ALL_EMOJI_PAGES.length;
				for (let i = 0; i < ALL_EMOJI_PAGES.length; i++) {
					const idx = (start + i) % ALL_EMOJI_PAGES.length;
					if (ALL_EMOJI_PAGES[idx].name.toLowerCase().startsWith(letter)) {
						emojiCategoryIdx = idx; emojiCursorIdx = 0; refresh(); return;
					}
				}
			}
		}

		return {
			render,
			invalidate: () => { cachedLines = undefined; },
			handleInput,
		};
	});
}

// ─── Extension Factory ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let lastSignature = "";
	let runtimeOverrides: RuntimeOverrides = {};
	const reportedConfigErrors = new Set<string>();
	const reportedThemeErrors = new Set<string>();

	async function applyIdentity(
		ctx: ExtensionContext,
		force: boolean = false,
	): Promise<AppliedIdentity> {
		const repo = await getRepoInfo(ctx.cwd);
		const { config, configPaths } = await loadConfig(
			repo, reportedConfigErrors,
			(msg: string) => ctx.ui.notify(msg, "warning"),
		);
		const identity = resolveIdentity(repo, config, runtimeOverrides);
		const flags = mergeFlags(config, runtimeOverrides);
		const signature = getSignature(repo, identity, flags);

		if (!force && signature === lastSignature) {
			return { configPaths, identity, repo, signature };
		}

		// Apply theme
		const themeResult = ctx.ui.setTheme(identity.theme);
		if (!themeResult.success && !reportedThemeErrors.has(identity.theme)) {
			reportedThemeErrors.add(identity.theme);
			ctx.ui.notify(`pi-peacock: theme '${identity.theme}' not found`, "warning");
		}

		// Footer: status badge + optional horizontal line ABOVE footer
		const hasLine = runtimeOverrides.footerLine && flags.showStatus;
		const badgeText = getStatusText(ctx, repo, identity, flags, runtimeOverrides.emoji);

		if (badgeText) {
			ctx.ui.setStatus(STATUS_KEY, badgeText);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}

		if (hasLine) {
			const lineColor = runtimeOverrides.footerLineColor ?? "muted";
			const lineThickness = runtimeOverrides.footerLineWidth ?? 1;
			const lineOpt = LINE_WIDTHS.find((w) => w.width === lineThickness) ?? LINE_WIDTHS[0];
			ctx.ui.setWidget("pi-peacock-line",
				(tui, th) => { return { render: (w: number) => [th.fg(lineColor as any, lineOpt.char.repeat(w))], invalidate() {} }; },
				{ placement: "belowEditor" },
			);
		} else {
			ctx.ui.setWidget("pi-peacock-line", undefined);
		}

		// Terminal title
		const title = getTitle(repo, identity, flags, config);
		if (title) ctx.ui.setTitle(title);

		lastSignature = signature;
		return { configPaths, identity, repo, signature };
	}

	// ── Sub-command handlers ──────────────────────────────────────────────

	async function cmdTheme(args: string, ctx: ExtensionContext): Promise<void> {
		const name = args.trim();
		if (!name) {
			const choice = await ctx.ui.select(
				"Select a peacock theme:",
				[...AUTO_THEMES].map((t) => ({ label: t, value: t })),
			);
			if (!choice) return;
			runtimeOverrides.theme = choice;
		} else {
			if ((AUTO_THEMES as readonly string[]).includes(name)) {
				runtimeOverrides.theme = name;
			} else {
				const tr = ctx.ui.setTheme(name);
				if (!tr.success) {
					ctx.ui.notify(`pi-peacock: theme '${name}' not found. Available: ${AUTO_THEMES.join(", ")}`, "warning");
					return;
				}
				await applyIdentity(ctx);
				runtimeOverrides.theme = name;
			}
		}
		saveOverrides(pi, runtimeOverrides);
		const applied = await applyIdentity(ctx, true);
		ctx.ui.notify(`pi-peacock: theme → ${applied.identity.theme}`, "info");
	}

	async function cmdLabel(args: string, ctx: ExtensionContext): Promise<void> {
		const label = args.trim();
		if (!label) {
			const input = await ctx.ui.input("Set peacock label:", runtimeOverrides.label ?? "");
			if (!input) return;
			runtimeOverrides.label = input;
		} else {
			runtimeOverrides.label = label;
		}
		saveOverrides(pi, runtimeOverrides);
		const applied = await applyIdentity(ctx, true);
		ctx.ui.notify(`pi-peacock: label → ${applied.identity.label}`, "info");
	}

	async function cmdToggle(args: string, ctx: ExtensionContext): Promise<void> {
		const feature = args.trim().toLowerCase();
		const validFeatures: Record<string, ToggleKey> = { status: "showStatus", branch: "showBranch", title: "showTitle" };
		if (feature && !(feature in validFeatures)) {
			ctx.ui.notify(`pi-peacock: unknown feature '${feature}'. Use: status, branch, or title`, "warning");
			return;
		}
		if (feature) {
			const key = validFeatures[feature];
			runtimeOverrides[key] = !(runtimeOverrides[key] ?? true);
		} else {
			await showFullSettings(ctx);
			return;
		}
		saveOverrides(pi, runtimeOverrides);
		await applyIdentity(ctx, true);
		ctx.ui.notify(`pi-peacock: ${feature} → ${runtimeOverrides[validFeatures[feature]] ? "on" : "off"}`, "info");
	}

	async function cmdReset(_args: string, ctx: ExtensionContext): Promise<void> {
		const ok = await ctx.ui.confirm("Reset peacock overrides?", "This clears all runtime settings and reverts to file config.");
		if (!ok) return;
		runtimeOverrides = {};
		lastSignature = "";
		saveOverrides(pi, runtimeOverrides);
		const applied = await applyIdentity(ctx, true);
		ctx.ui.notify(`pi-peacock: reset — using ${applied.identity.theme} (${applied.identity.source})`, "info");
	}

	async function cmdStatus(_args: string, ctx: ExtensionContext): Promise<void> {
		const applied = await applyIdentity(ctx, true);
		const branch = applied.repo.branch ? ` · ${applied.repo.branch}` : "";
		const configText = applied.configPaths.length > 0 ? `configs: ${applied.configPaths.join(", ")}` : "configs: none";
		const overrideKeys = Object.keys(runtimeOverrides);
		const overridesText = overrideKeys.length > 0 ? `overrides: ${overrideKeys.join(", ")}` : "overrides: none";
		ctx.ui.notify(`pi-peacock: ${applied.identity.label} → ${applied.identity.theme} (${applied.identity.source})${branch} · ${configText} · ${overridesText}`, "info");
	}

	async function cmdEmoji(_args: string, ctx: ExtensionContext): Promise<void> {
		const repo = await getRepoInfo(ctx.cwd);
		const { config } = await loadConfig(repo, reportedConfigErrors, (m: string) => ctx.ui.notify(m, "warning"));
		const identity = resolveIdentity(repo, config, runtimeOverrides);
		await showSettingsPanel(pi, ctx, runtimeOverrides, config, identity, repo,
			(n) => { runtimeOverrides = n; applyIdentity(ctx, true).catch(() => {}); });
		saveOverrides(pi, runtimeOverrides);
		await applyIdentity(ctx, true);
	}

	async function showFullSettings(ctx: ExtensionContext): Promise<void> {
		const repo = await getRepoInfo(ctx.cwd);
		const { config } = await loadConfig(repo, reportedConfigErrors, (m: string) => ctx.ui.notify(m, "warning"));
		const identity = resolveIdentity(repo, config, runtimeOverrides);
		await showSettingsPanel(pi, ctx, runtimeOverrides, config, identity, repo,
			(n) => { runtimeOverrides = n; applyIdentity(ctx, true).catch(() => {}); });
		saveOverrides(pi, runtimeOverrides);
		await applyIdentity(ctx, true);
	}

	// ── Register /peacock command ────────────────────────────────────────

	pi.registerCommand("peacock", {
		description: "Manage pi-peacock repo identity. Usage: /peacock [theme|label|toggle|emoji|reset|status]",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const parts = prefix.trim().split(/\s+/);
			const word = parts[parts.length - 1] ?? "";
			if (parts.length <= 1) {
				const items: AutocompleteItem[] = SUBCOMMANDS.map((s) => ({ value: s, label: s, description: SUBCOMMAND_DESCS[s] }));
				const f = items.filter((i) => i.value.startsWith(word));
				return f.length > 0 ? f : null;
			}
			const cmd = parts[0];
			if (cmd === "theme") {
				const f = AUTO_THEMES.filter((t) => t.startsWith(word)).map((t) => ({ value: t, label: t }));
				return f.length > 0 ? f : null;
			}
			if (cmd === "toggle") {
				const opts = [
					{ value: "status", label: "status", description: "Toggle status badge" },
					{ value: "branch", label: "branch", description: "Toggle branch display" },
					{ value: "title", label: "title", description: "Toggle terminal title" },
				];
				const f = opts.filter((o) => o.value.startsWith(word));
				return f.length > 0 ? f : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) { ctx.ui.notify("pi-peacock requires interactive mode", "warning"); return; }
			const parts = (args ?? "").trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() ?? "";
			const rest = parts.slice(1).join(" ");
			switch (sub) {
				case "theme": await cmdTheme(rest, ctx); break;
				case "label": await cmdLabel(rest, ctx); break;
				case "toggle": await cmdToggle(rest, ctx); break;
				case "emoji": await cmdEmoji(rest, ctx); break;
				case "reset": await cmdReset(rest, ctx); break;
				case "status": await cmdStatus(rest, ctx); break;
				default: await showFullSettings(ctx); break;
			}
		},
	});

	const SUBCOMMAND_DESCS: Record<string, string> = {
		theme: "Switch theme (e.g. /peacock theme peacock-amber)",
		label: "Set a custom label (e.g. /peacock label backend)",
		emoji: "Pick an emoji for the footer badge",
		toggle: "Toggle a feature: status, branch, or title",
		reset: "Clear all runtime overrides, revert to file config",
		status: "Show current identity info",
	};

	// ── Discover bundled themes ──────────────────────────────────────────

	pi.on("resources_discover", async () => {
		const globalThemesDir = path.join(os.homedir(), ".pi", "agent", "themes");
		if (THEMES_DIR === globalThemesDir) return undefined;
		return { themePaths: [THEMES_DIR] };
	});

	// ── Lifecycle hooks ──────────────────────────────────────────────────

	pi.on("session_start", async (_e, ctx) => {
		runtimeOverrides = await restoreOverrides(ctx, reportedConfigErrors);
		lastSignature = "";
		await applyIdentity(ctx);
	});

	pi.on("session_tree", async (_e, ctx) => {
		runtimeOverrides = await restoreOverrides(ctx, reportedConfigErrors);
		lastSignature = "";
		await applyIdentity(ctx);
	});

	pi.on("turn_end", async (_e, ctx) => {
		await applyIdentity(ctx);
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget("pi-peacock-line", undefined);
	});
}
