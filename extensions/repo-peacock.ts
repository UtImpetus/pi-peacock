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
 * - `/peacock reset` — clear all runtime overrides, back to file config
 * - Tab-complete for commands and themes
 * - Runtime overrides persist across reloads via session storage
 */

import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
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

const STATUS_KEY = "pi-peacock";
const STATE_KEY = "pi-peacock-state";

const AUTO_THEMES = [
	"peacock-amber",
	"peacock-blue",
	"peacock-cyan",
	"peacock-green",
	"peacock-purple",
	"peacock-rose",
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
	showStatus?: boolean;
	showBranch?: boolean;
	showTitle?: boolean;
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
): string | undefined {
	if (!flags.showStatus) return undefined;

	const badge = ctx.ui.theme.fg("accent", `🦚 ${identity.label}`);
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

// ─── Session State Persistence ───────────────────────────────────────────────

function saveOverrides(pi: ExtensionAPI, overrides: RuntimeOverrides): void {
	pi.appendEntry(STATE_KEY, overrides);
}

function restoreOverrides(
	ctx: ExtensionContext,
	reportedErrors: Set<string>,
): RuntimeOverrides {
	const stateEntry = [...ctx.sessionManager.getBranch()]
		.reverse()
		.find(
			(e) => e.type === "custom" && e.customType === STATE_KEY,
		);

	const data = stateEntry?.data as RuntimeOverrides | undefined;
	if (data) {
		// Normalize: remove undefined keys
		const cleaned: RuntimeOverrides = {};
		if (data.theme) cleaned.theme = data.theme;
		if (data.label) cleaned.label = data.label;
		if (data.showStatus !== undefined) cleaned.showStatus = data.showStatus;
		if (data.showBranch !== undefined) cleaned.showBranch = data.showBranch;
		if (data.showTitle !== undefined) cleaned.showTitle = data.showTitle;
		return cleaned;
	}
	return {};
}

// ─── Interactive Settings UI ─────────────────────────────────────────────────

const SUBCOMMANDS = [
	"theme",
	"label",
	"toggle",
	"reset",
	"status",
] as const;

/**
 * Interactive settings panel — replaces editor temporarily with a full TUI.
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
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		// Local mutable copies
		let overrides = { ...currentOverrides };
		const availableThemes = [...AUTO_THEMES];
		let selectedThemeIdx = overrides.theme
			? availableThemes.indexOf(overrides.theme as (typeof AUTO_THEMES)[number])
			: -1;
		if (selectedThemeIdx === -1) selectedThemeIdx = availableThemes.indexOf(currentIdentity.theme as (typeof AUTO_THEMES)[number]);
		if (selectedThemeIdx === -1) selectedThemeIdx = 0;

		const flags = mergeFlags(currentConfig, overrides);
		let labelText = overrides.label ?? currentIdentity.label;

		// UI state
		let focusIndex = 0; // 0=theme, 1=label, 2=status, 3=branch, 4=title, 5=save, 6=cancel
		const totalOptions = 7;

		function getThemeName(): string {
			return availableThemes[selectedThemeIdx] ?? currentIdentity.theme;
		}

		

		let cachedLines: string[] | undefined;
		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.up)) {
				focusIndex = (focusIndex - 1 + totalOptions) % totalOptions;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				focusIndex = (focusIndex + 1) % totalOptions;
				refresh();
				return;
			}
			if (matchesKey(data, Key.left)) {
				if (focusIndex === 0) {
					// Navigate themes left
					selectedThemeIdx =
						(selectedThemeIdx - 1 + availableThemes.length) % availableThemes.length;
					overrides.theme = availableThemes[selectedThemeIdx];
					onChange(overrides);
					saveOverrides(pi, overrides);
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.right)) {
				if (focusIndex === 0) {
					selectedThemeIdx = (selectedThemeIdx + 1) % availableThemes.length;
					overrides.theme = availableThemes[selectedThemeIdx];
					onChange(overrides);
					saveOverrides(pi, overrides);
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				if (focusIndex === 2) {
					// Toggle status
					flags.showStatus = !flags.showStatus;
					overrides.showStatus = flags.showStatus;
					onChange(overrides);
					saveOverrides(pi, overrides);
					refresh();
					return;
				}
				if (focusIndex === 3) {
					flags.showBranch = !flags.showBranch;
					overrides.showBranch = flags.showBranch;
					onChange(overrides);
					saveOverrides(pi, overrides);
					refresh();
					return;
				}
				if (focusIndex === 4) {
					flags.showTitle = !flags.showTitle;
					overrides.showTitle = flags.showTitle;
					onChange(overrides);
					saveOverrides(pi, overrides);
					refresh();
					return;
				}
				if (focusIndex === 5) {
					// Save & apply
					onChange(overrides);
					saveOverrides(pi, overrides);
					done();
					return;
				}
				if (focusIndex === 6) {
					// Cancel
					done();
					return;
				}
			}
			if (matchesKey(data, Key.escape)) {
				done();
				return;
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			const sel = (idx: number, text: string) =>
				focusIndex === idx
					? theme.fg("accent", `▸ ${text}`)
					: `  ${text}`;

			// Header
			add(theme.fg("accent", theme.bold(" ── pi-peacock settings ──")));
			lines.push("");

			// Repo info
			add(theme.fg("dim", `   Repo: ${repo.repoName}  Branch: ${repo.branch}`));
			add(theme.fg("dim", `   Active rule: ${currentIdentity.source}`));
			lines.push("");

			// 1. Theme selector
			const themeName = getThemeName();
			const themeSwatch = theme.fg("accent", "■");
			const isThemeFocused = focusIndex === 0;
			const themePrefix = isThemeFocused ? theme.fg("accent", "▸") : " ";
			const themeHighlight = isThemeFocused ? theme.fg("accent", themeName) : themeName;
			add(
				`${themePrefix} ${theme.fg("dim", "Theme:")}  ${themeSwatch} ${themeHighlight}` +
					(isThemeFocused ? theme.fg("dim", "  ← → browse") : ""),
			);
			// Show mini theme palette
			add(
				`   ${theme.fg("dim", availableThemes.map((t) => {
					const isActive = t === themeName;
					return isActive ? theme.fg("accent", "●") : "○";
				}).join(" "))}`,
			);
			lines.push("");

			// 2. Label
			add(`${focusIndex === 1 ? theme.fg("accent", `▸ ${theme.fg("dim", "Label:")}  ${labelText}`) : `  ${theme.fg("dim", "Label:")}  ${labelText}`}`);
			lines.push("");

			// 3-5. Toggles with interactive enter/space
			const toggleStates = [flags.showStatus, flags.showBranch, flags.showTitle];
			const toggleLabels = ["Status badge", "Branch name", "Terminal title"];
			for (let i = 0; i < 3; i++) {
				const idx = i + 2;
				const checked = toggleStates[i];
				const checkChar = checked ? theme.fg("success", "☑") : theme.fg("dim", "☐");
				const label = toggleLabels[i];
				const focused = focusIndex === idx;
				add(
					(focused ? theme.fg("accent", "▸") : " ") +
						` ${checkChar} ${label}` +
						(focused ? theme.fg("dim", "  Enter/space to toggle") : ""),
				);
			}
			lines.push("");

			// Preview section
			add(theme.fg("dim", " ── Preview ──"));
			const previewFlags = { showStatus: flags.showStatus, showBranch: flags.showBranch, showTitle: flags.showTitle };
			const previewLabel = overrides.label ?? labelText;
			const preview = theme.fg("accent", `🦚 ${previewLabel}`);
			const branchText = previewFlags.showBranch && repo.branch ? theme.fg("dim", ` · ${repo.branch}`) : "";
			add(`   ${preview}${branchText}`);
			if (previewFlags.showTitle) {
				const prefix = currentConfig.titlePrefix ?? DEFAULT_CONFIG.titlePrefix;
				add(`   ${theme.fg("dim", `Title: ${prefix} ${previewLabel}${previewFlags.showBranch && repo.branch ? ` · ${repo.branch}` : ""}`)}`);
			}
			lines.push("");

			// Actions: Save / Cancel
			add(
				sel(5, theme.fg("success", "✓ Apply & close")),
			);
			add(
				sel(6, theme.fg("muted", "✕ Cancel")),
			);
			lines.push("");
			add(theme.fg("dim", " ↑↓ navigate · Enter select · Esc cancel"));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
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

	/**
	 * Apply the resolved identity to pi's UI.
	 * Returns the full applied state.
	 */
	async function applyIdentity(
		ctx: ExtensionContext,
		force: boolean = false,
	): Promise<AppliedIdentity> {
		const repo = await getRepoInfo(ctx.cwd);
		const { config, configPaths } = await loadConfig(
			repo,
			reportedConfigErrors,
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
			ctx.ui.notify(
				`pi-peacock: theme '${identity.theme}' not found`,
				"warning",
			);
		}

		// Status badge
		const statusText = getStatusText(ctx, repo, identity, flags);
		if (statusText) {
			ctx.ui.setStatus(STATUS_KEY, statusText);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}

		// Terminal title
		const title = getTitle(repo, identity, flags, config);
		if (title) {
			ctx.ui.setTitle(title);
		}

		lastSignature = signature;
		return { configPaths, identity, repo, signature };
	}

	// ── Sub-command handlers ──────────────────────────────────────────────

	async function cmdTheme(
		args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const name = args.trim();
		if (!name) {
			// No arg: show interactive theme selector
			const allThemes = [...AUTO_THEMES];
			const choice = await ctx.ui.select(
				"Select a peacock theme:",
				allThemes.map((t) => ({
					label: t,
					value: t,
				})),
			);
			if (!choice) return;
			runtimeOverrides.theme = choice;
		} else {
			// Validate the theme exists
			if ((AUTO_THEMES as readonly string[]).includes(name)) {
				runtimeOverrides.theme = name;
			} else {
				// Try it anyway — might be a custom peacock theme
				const themeResult = ctx.ui.setTheme(name);
				if (!themeResult.success) {
					ctx.ui.notify(
						`pi-peacock: theme '${name}' not found. Available: ${AUTO_THEMES.join(", ")}`,
						"warning",
					);
					return;
				}
				// Revert the test
				await applyIdentity(ctx);
				runtimeOverrides.theme = name;
			}
		}

		saveOverrides(pi, runtimeOverrides);
		const applied = await applyIdentity(ctx, true);
		ctx.ui.notify(
			`pi-peacock: theme → ${applied.identity.theme}`,
			"info",
		);
	}

	async function cmdLabel(
		args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const label = args.trim();
		if (!label) {
			const input = await ctx.ui.input(
				"Set peacock label:",
				runtimeOverrides.label ?? "",
			);
			if (!input) return;
			runtimeOverrides.label = input;
		} else {
			runtimeOverrides.label = label;
		}

		saveOverrides(pi, runtimeOverrides);
		const applied = await applyIdentity(ctx, true);
		ctx.ui.notify(
			`pi-peacock: label → ${applied.identity.label}`,
			"info",
		);
	}

	async function cmdToggle(
		args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const feature = args.trim().toLowerCase();

		const validFeatures: Record<string, ToggleKey> = {
			status: "showStatus",
			branch: "showBranch",
			title: "showTitle",
		};

		if (feature && !(feature in validFeatures)) {
			ctx.ui.notify(
				`pi-peacock: unknown feature '${feature}'. Use: status, branch, or title`,
				"warning",
			);
			return;
		}

		if (feature) {
			const key = validFeatures[feature];
			const current = runtimeOverrides[key] ?? true;
			runtimeOverrides[key] = !current;
		} else {
			// No feature specified: toggle them all? Just show interactive
			// We'll open the full settings panel instead
			await showFullSettings(ctx);
			return;
		}

		saveOverrides(pi, runtimeOverrides);
		const applied = await applyIdentity(ctx, true);
		ctx.ui.notify(
			`pi-peacock: ${feature} → ${runtimeOverrides[validFeatures[feature]] ? "on" : "off"}`,
			"info",
		);
	}

	async function cmdReset(
		_args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const ok = await ctx.ui.confirm(
			"Reset peacock overrides?",
			"This clears all runtime settings and reverts to file config.",
		);
		if (!ok) return;

		runtimeOverrides = {};
		lastSignature = "";
		saveOverrides(pi, runtimeOverrides);
		const applied = await applyIdentity(ctx, true);
		ctx.ui.notify(
			`pi-peacock: reset — using ${applied.identity.theme} (${applied.identity.source})`,
			"info",
		);
	}

	async function cmdStatus(
		_args: string,
		ctx: ExtensionContext,
	): Promise<void> {
		const applied = await applyIdentity(ctx, true);
		const branch = applied.repo.branch ? ` · ${applied.repo.branch}` : "";
		const configText =
			applied.configPaths.length > 0
				? `configs: ${applied.configPaths.join(", ")}`
				: "configs: none";

		// Show overrides
		const overrideKeys = Object.keys(runtimeOverrides);
		const overridesText =
			overrideKeys.length > 0
				? `overrides: ${overrideKeys.join(", ")}`
				: "overrides: none";

		ctx.ui.notify(
			`pi-peacock: ${applied.identity.label} → ${applied.identity.theme} (${applied.identity.source})${branch} · ${configText} · ${overridesText}`,
			"info",
		);
	}

	async function showFullSettings(ctx: ExtensionContext): Promise<void> {
		const repo = await getRepoInfo(ctx.cwd);
		const { config } = await loadConfig(
			repo,
			reportedConfigErrors,
			(msg: string) => ctx.ui.notify(msg, "warning"),
		);
		const identity = resolveIdentity(repo, config, runtimeOverrides);

		await showSettingsPanel(
			pi,
			ctx,
			runtimeOverrides,
			config,
			identity,
			repo,
			(newOverrides) => {
				runtimeOverrides = newOverrides;
				// Apply immediately while panel is open
				applyIdentity(ctx, true).catch(() => {});
			},
		);

		// Final apply after panel closes
		saveOverrides(pi, runtimeOverrides);
		await applyIdentity(ctx, true);
	}

	// ── Register /peacock command with autocomplete ──────────────────────

	pi.registerCommand("peacock", {
		description: "Manage pi-peacock repo identity. Usage: /peacock [theme|label|toggle|reset|status]",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const trimmed = prefix.trim();

			// The prefix might contain a subcommand already
			const parts = trimmed.split(/\s+/);
			const currentWord = parts[parts.length - 1] ?? "";

			if (parts.length <= 1) {
				// Completing subcommand
				const items: AutocompleteItem[] = SUBCOMMANDS.map((s) => ({
					value: s,
					label: s,
					description: SUBCOMMAND_DESCS[s],
				}));
				const filtered = items.filter((i) => i.value.startsWith(currentWord));
				return filtered.length > 0 ? filtered : null;
			}

			// Completing argument for a subcommand
			const cmd = parts[0];
			if (cmd === "theme") {
				const items: AutocompleteItem[] = AUTO_THEMES.map((t) => ({
					value: t,
					label: t,
				}));
				const filtered = items.filter((i) => i.value.startsWith(currentWord));
				return filtered.length > 0 ? filtered : null;
			}

			if (cmd === "toggle") {
				const items: AutocompleteItem[] = [
					{ value: "status", label: "status", description: "Toggle status badge" },
					{ value: "branch", label: "branch", description: "Toggle branch display" },
					{ value: "title", label: "title", description: "Toggle terminal title" },
				];
				const filtered = items.filter((i) => i.value.startsWith(currentWord));
				return filtered.length > 0 ? filtered : null;
			}

			return null;
		},
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("pi-peacock requires interactive mode", "warning");
				return;
			}

			const trimmed = (args ?? "").trim();
			const parts = trimmed.split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() ?? "";
			const subArgs = parts.slice(1).join(" ");

			switch (subcommand) {
				case "theme":
					await cmdTheme(subArgs, ctx);
					break;
				case "label":
					await cmdLabel(subArgs, ctx);
					break;
				case "toggle":
					await cmdToggle(subArgs, ctx);
					break;
				case "reset":
					await cmdReset(subArgs, ctx);
					break;
				case "status":
					await cmdStatus(subArgs, ctx);
					break;
				default:
					// No subcommand or unknown: open the full interactive panel
					await showFullSettings(ctx);
					break;
			}
		},
	});

	const SUBCOMMAND_DESCS: Record<string, string> = {
		theme: "Switch theme (e.g. /peacock theme peacock-amber)",
		label: "Set a custom label (e.g. /peacock label backend)",
		toggle: "Toggle a feature: status, branch, or title",
		reset: "Clear all runtime overrides, revert to file config",
		status: "Show current identity info",
	};

	// ── Discover bundled themes for pi ─────────────────────────────────

	pi.on("resources_discover", () => {
		return {
			themePaths: [THEMES_DIR],
		};
	});

	// ── Lifecycle hooks ──────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		runtimeOverrides = restoreOverrides(ctx, reportedConfigErrors);
		lastSignature = "";
		await applyIdentity(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		runtimeOverrides = restoreOverrides(ctx, reportedConfigErrors);
		lastSignature = "";
		await applyIdentity(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await applyIdentity(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
