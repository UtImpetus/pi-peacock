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
import {
	createBashTool,
	createBashToolDefinition,
	createEditTool,
	createEditToolDefinition,
	createFindTool,
	createFindToolDefinition,
	createGrepTool,
	createGrepToolDefinition,
	createLsTool,
	createLsToolDefinition,
	createReadTool,
	createReadToolDefinition,
	createWriteTool,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
	AutocompleteItem,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);

// Resolve themes directory relative to this extension file
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const THEMES_DIR = path.resolve(EXTENSION_DIR, "..", "themes");
const OVERRIDES_DIR = path.join(os.homedir(), ".pi", "agent");

function getOverridesFile(repoName: string): string {
	return path.join(OVERRIDES_DIR, `.peacock-state-${repoName}.json`);
}

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

const FOOTER_LINE_ANIMATION_INTERVAL_MS = 320;

// ─── Types ───────────────────────────────────────────────────────────────────

type ToolStripeSide = "left" | "right" | "both";

type PeacockRule = {
	repo?: string;
	pathIncludes?: string | string[];
	theme?: string;
	label?: string;
	title?: string;
	status?: string;
	footerLine?: boolean;
	footerLineColor?: string;
	footerLinePattern?: string;
	footerLineWidth?: number;
	footerLineAnimate?: boolean;
	footerLineAnimationMs?: number;
	toolStripe?: boolean;
	toolStripeColor?: string;
	toolStripeChar?: string;
	toolStripeSide?: ToolStripeSide;
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
	footerLine?: boolean;
	footerLineColor?: string;
	footerLinePattern?: string;
	footerLineWidth?: number;
	footerLineAnimate?: boolean;
	footerLineAnimationMs?: number;
	toolStripe?: boolean;
	toolStripeColor?: string;
	toolStripeChar?: string;
	toolStripeSide?: ToolStripeSide;
};

/** Settings the user can override at runtime via commands/UI */
type RuntimeOverrides = {
	autoAssignTheme?: boolean;
	theme?: string;
	label?: string;
	emoji?: string;
	showStatus?: boolean;
	showBranch?: boolean;
	showTitle?: boolean;
	footerLine?: boolean;
	footerLineColor?: string;
	footerLinePattern?: string;
	footerLineWidth?: number;
	footerLineAnimate?: boolean;
	footerLineAnimationMs?: number;

	// Tool stripe customization
	toolStripe?: boolean;
	toolStripeColor?: string;
	toolStripeChar?: string;
	toolStripeSide?: ToolStripeSide;
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
	theme?: string;
	title?: string;
};

type AppliedIdentity = {
	configPaths: string[];
	identity: ResolvedIdentity;
	repo: RepoInfo;
	signature: string;
};

type ResolvedFooterLineSettings = {
	enabled: boolean;
	color: string;
	pattern: string;
	width?: number;
	customPattern?: string;
	animationEnabled: boolean;
	animationMs: number;
};

type ResolvedToolStripeSettings = {
	enabled: boolean;
	color: string;
	char: string;
	side: ToolStripeSide;
};

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: PeacockConfig = {
	autoAssignTheme: false,
	showBranch: true,
	showStatus: true,
	showTitle: true,
	titlePrefix: "π",
};

type BuiltInToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

type BuiltInToolBundle = {
	definition: any;
	tool: any;
};

const BUILT_IN_TOOL_NAMES: BuiltInToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const builtInToolCache = new Map<string, Record<BuiltInToolName, BuiltInToolBundle>>();

function createBuiltInTools(cwd: string): Record<BuiltInToolName, BuiltInToolBundle> {
	return {
		read: { definition: createReadToolDefinition(cwd), tool: createReadTool(cwd) },
		bash: { definition: createBashToolDefinition(cwd), tool: createBashTool(cwd) },
		edit: { definition: createEditToolDefinition(cwd), tool: createEditTool(cwd) },
		write: { definition: createWriteToolDefinition(cwd), tool: createWriteTool(cwd) },
		grep: { definition: createGrepToolDefinition(cwd), tool: createGrepTool(cwd) },
		find: { definition: createFindToolDefinition(cwd), tool: createFindTool(cwd) },
		ls: { definition: createLsToolDefinition(cwd), tool: createLsTool(cwd) },
	};
}

function getBuiltInTools(cwd: string): Record<BuiltInToolName, BuiltInToolBundle> {
	let tools = builtInToolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		builtInToolCache.set(cwd, tools);
	}
	return tools;
}

class StripedComponent implements Component {
	private child: Component | undefined;
	private prefix = "";
	private suffix = "";
	wantsKeyRelease?: boolean;

	getChild(): Component | undefined {
		return this.child;
	}

	setChild(child: Component | undefined): void {
		this.child = child;
		this.wantsKeyRelease = child?.wantsKeyRelease;
	}

	setPrefix(prefix: string): void {
		this.prefix = prefix;
	}

	setSuffix(suffix: string): void {
		this.suffix = suffix;
	}

	invalidate(): void {
		this.child?.invalidate?.();
	}

	handleInput(data: string): void {
		this.child?.handleInput?.(data);
	}

	render(width: number): string[] {
		if (!this.child || width <= 0) return [];

		let prefix = this.prefix;
		let suffix = this.suffix;
		let prefixWidth = visibleWidth(prefix);
		let suffixWidth = visibleWidth(suffix);
		const maxDecorationWidth = Math.max(0, width - 1);

		if (prefixWidth + suffixWidth > maxDecorationWidth) {
			const maxSuffixWidth = Math.max(0, maxDecorationWidth - prefixWidth);
			suffix = truncateToWidth(suffix, maxSuffixWidth, "");
			suffixWidth = visibleWidth(suffix);
		}
		if (prefixWidth + suffixWidth > maxDecorationWidth) {
			const maxPrefixWidth = Math.max(0, maxDecorationWidth - suffixWidth);
			prefix = truncateToWidth(prefix, maxPrefixWidth, "");
			prefixWidth = visibleWidth(prefix);
		}

		const childWidth = Math.max(1, width - prefixWidth - suffixWidth);
		const childLines = this.child.render(childWidth);
		if (childLines.length === 0) return [];
		return childLines.map((line) => `${prefix}${truncateToWidth(line, childWidth, "", true)}${suffix}`);
	}
}

function sanitizeStripeChar(char: string | undefined): string {
	if (!char) return DEFAULT_STRIPE_CHAR;
	const cleaned = char.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 4);
	if (!cleaned || visibleWidth(cleaned) === 0) return DEFAULT_STRIPE_CHAR;
	return cleaned;
}

function sanitizeToolStripeSide(side: ToolStripeSide | undefined): ToolStripeSide | undefined {
	if (!side) return undefined;
	return STRIPE_SIDES.includes(side) ? side : undefined;
}

function getToolStripeSide(side: ToolStripeSide | undefined): ToolStripeSide {
	return sanitizeToolStripeSide(side) ?? DEFAULT_STRIPE_SIDE;
}

function getMirroredToolStripeChar(char: string): string {
	return STRIPE_CHAR_MIRRORS[char] ?? char;
}

function getToolStripeDecoration(
	theme: { fg: (color: string, text: string) => string },
	settings: Pick<ResolvedToolStripeSettings, "color" | "char" | "side">,
): { prefix: string; suffix: string } {
	const color = settings.color || DEFAULT_STRIPE_COLOR;
	const char = sanitizeStripeChar(settings.char);
	const side = getToolStripeSide(settings.side);
	const leftStripe = `${theme.fg(color as any, char)} `;
	const rightStripe = ` ${theme.fg(color as any, getMirroredToolStripeChar(char))}`;
	return {
		prefix: side === "left" || side === "both" ? leftStripe : "",
		suffix: side === "right" || side === "both" ? rightStripe : "",
	};
}

function registerStripedBuiltInTools(
	pi: ExtensionAPI,
	getToolStripeSettings: () => ResolvedToolStripeSettings,
): void {
	const baseTools = getBuiltInTools(process.cwd());
	for (const toolName of BUILT_IN_TOOL_NAMES) {
		const base = baseTools[toolName];
		pi.registerTool({
			name: toolName,
			label: base.definition.label,
			description: base.definition.description,
			promptSnippet: base.definition.promptSnippet,
			promptGuidelines: base.definition.promptGuidelines,
			parameters: base.definition.parameters,
			prepareArguments: base.definition.prepareArguments,

			async execute(toolCallId, params, signal, onUpdate, ctx) {
				return getBuiltInTools(ctx.cwd)[toolName].tool.execute(toolCallId, params, signal, onUpdate);
			},

			renderCall(args, theme, context) {
				const toolStripeSettings = getToolStripeSettings();
				const definition = getBuiltInTools(context.cwd)[toolName].definition;
				const innerResult = definition.renderCall?.(args, theme, {
					...context,
					lastComponent: context.lastComponent instanceof StripedComponent
						? context.lastComponent.getChild()
						: context.lastComponent,
				});

				if (!toolStripeSettings.enabled) return innerResult ?? new StripedComponent();

				const wrapper = context.lastComponent instanceof StripedComponent
					? context.lastComponent
					: new StripedComponent();
				const decoration = getToolStripeDecoration(theme, toolStripeSettings);
				wrapper.setPrefix(decoration.prefix);
				wrapper.setSuffix(decoration.suffix);
				wrapper.setChild(innerResult);
				return wrapper;
			},

			renderResult(result, options, theme, context) {
				const toolStripeSettings = getToolStripeSettings();
				const definition = getBuiltInTools(context.cwd)[toolName].definition;
				const innerResult = definition.renderResult?.(result, options, theme, {
					...context,
					lastComponent: context.lastComponent instanceof StripedComponent
						? context.lastComponent.getChild()
						: context.lastComponent,
				});

				if (!toolStripeSettings.enabled) return innerResult ?? new StripedComponent();

				const wrapper = context.lastComponent instanceof StripedComponent
					? context.lastComponent
					: new StripedComponent();
				const decoration = getToolStripeDecoration(theme, toolStripeSettings);
				wrapper.setPrefix(decoration.prefix);
				wrapper.setSuffix(decoration.suffix);
				wrapper.setChild(innerResult);
				return wrapper;
			},
		});
	}
}

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

function findMatchingRule(config: PeacockConfig, repo: RepoInfo): PeacockRule | undefined {
	return (config.rules ?? []).find((rule) => ruleMatches(rule, repo));
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

function isAutoAssignThemeEnabled(
	config: PeacockConfig,
	overrides: RuntimeOverrides,
): boolean {
	return overrides.autoAssignTheme ?? config.autoAssignTheme ?? DEFAULT_CONFIG.autoAssignTheme ?? false;
}

function resolveTheme(
	repo: RepoInfo,
	config: PeacockConfig,
	overrides: RuntimeOverrides,
	matchedRule?: PeacockRule,
): string | undefined {
	const autoAssignEnabled = isAutoAssignThemeEnabled(config, overrides);
	if (autoAssignEnabled && overrides.theme) return overrides.theme;
	if (matchedRule?.theme) return matchedRule.theme;
	if (matchedRule) {
		if (config.fallbackTheme) return config.fallbackTheme;
		if (autoAssignEnabled) return pickAutoTheme(repo.repoName);
		return undefined;
	}
	if (autoAssignEnabled) return pickAutoTheme(repo.repoName);
	return config.fallbackTheme;
}

function formatThemeName(theme: string | undefined): string {
	return theme ?? "current theme";
}

function formatThemeValue(theme: string | undefined): string {
	return theme ?? "(unchanged)";
}

function isPeacockThemeName(name: string): boolean {
	return (AUTO_THEMES as readonly string[]).includes(name);
}

function getAvailableThemeNames(ctx: ExtensionContext): string[] {
	const uniqueNames = new Set<string>();
	for (const { name } of ctx.ui.getAllThemes()) {
		if (name) uniqueNames.add(name);
	}
	return Array.from(uniqueNames).sort((a, b) => {
		const aIsPeacock = isPeacockThemeName(a);
		const bIsPeacock = isPeacockThemeName(b);
		if (aIsPeacock !== bIsPeacock) return aIsPeacock ? -1 : 1;
		return a.localeCompare(b);
	});
}

function formatThemeListPreview(themeNames: string[], maxItems: number = 12): string {
	if (themeNames.length === 0) return "(none)";
	if (themeNames.length <= maxItems) return themeNames.join(", ");
	return `${themeNames.slice(0, maxItems).join(", ")}, … (+${themeNames.length - maxItems} more)`;
}

function resolveIdentity(
	repo: RepoInfo,
	config: PeacockConfig,
	overrides: RuntimeOverrides,
): ResolvedIdentity {
	// 1. Try a config file rule
	const matchedRule = findMatchingRule(config, repo);
	if (matchedRule) {
		return {
			label: overrides.label ?? matchedRule.label ?? repo.repoName,
			source: "rule",
			status: matchedRule.status,
			theme: resolveTheme(repo, config, overrides, matchedRule),
			title: matchedRule.title,
		};
	}

	// 2. Auto-assign or fallback
	if (isAutoAssignThemeEnabled(config, overrides)) {
		return {
			label: overrides.label ?? config.fallbackLabel ?? repo.repoName,
			source: "auto",
			theme: resolveTheme(repo, config, overrides),
		};
	}

	return {
		label: overrides.label ?? config.fallbackLabel ?? repo.repoName,
		source: "fallback",
		theme: resolveTheme(repo, config, overrides),
	};
}

function resolveToolStripeSettings(
	repo: RepoInfo,
	config: PeacockConfig,
	overrides: RuntimeOverrides,
): ResolvedToolStripeSettings {
	const matchedRule = findMatchingRule(config, repo);
	return {
		enabled: overrides.toolStripe ?? matchedRule?.toolStripe ?? config.toolStripe ?? false,
		color: overrides.toolStripeColor ?? matchedRule?.toolStripeColor ?? config.toolStripeColor ?? DEFAULT_STRIPE_COLOR,
		char: sanitizeStripeChar(overrides.toolStripeChar ?? matchedRule?.toolStripeChar ?? config.toolStripeChar),
		side: getToolStripeSide(overrides.toolStripeSide ?? matchedRule?.toolStripeSide ?? config.toolStripeSide),
	};
}

function resolveFooterLineSettings(
	repo: RepoInfo,
	config: PeacockConfig,
	overrides: RuntimeOverrides,
): ResolvedFooterLineSettings {
	const matchedRule = findMatchingRule(config, repo);
	const width = overrides.footerLineWidth ?? matchedRule?.footerLineWidth ?? config.footerLineWidth ?? DEFAULT_LINE_WIDTH;
	const customPattern = sanitizeFooterLinePattern(
		overrides.footerLinePattern ?? matchedRule?.footerLinePattern ?? config.footerLinePattern,
	);
	return {
		enabled: overrides.footerLine ?? matchedRule?.footerLine ?? config.footerLine ?? false,
		color: overrides.footerLineColor ?? matchedRule?.footerLineColor ?? config.footerLineColor ?? DEFAULT_LINE_COLOR,
		pattern: getFooterLinePattern(customPattern, width),
		width,
		customPattern,
		animationEnabled:
			overrides.footerLineAnimate ?? matchedRule?.footerLineAnimate ?? config.footerLineAnimate ?? true,
		animationMs:
			sanitizeFooterLineAnimationIntervalMs(
				overrides.footerLineAnimationMs ?? matchedRule?.footerLineAnimationMs ?? config.footerLineAnimationMs,
			) ?? FOOTER_LINE_ANIMATION_INTERVAL_MS,
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

function sanitizeFooterLineAnimationIntervalMs(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(80, Math.min(5000, Math.round(value)));
}

function getSignature(
	repo: RepoInfo,
	identity: ResolvedIdentity,
	flags: { showStatus: boolean; showBranch: boolean; showTitle: boolean },
	footerLineSettings: ResolvedFooterLineSettings,
	toolStripeSettings: ResolvedToolStripeSettings,
): string {
	return JSON.stringify({
		branch: repo.branch,
		footerLine: footerLineSettings.enabled,
		footerLineColor: footerLineSettings.color,
		footerLinePattern: footerLineSettings.pattern,
		footerLineWidth: footerLineSettings.width,
		footerLineAnimate: footerLineSettings.animationEnabled,
		footerLineAnimationMs: footerLineSettings.animationMs,
		label: identity.label,
		showBranch: flags.showBranch,
		showStatus: flags.showStatus,
		showTitle: flags.showTitle,
		source: identity.source,
		theme: identity.theme,
		toolStripe: toolStripeSettings.enabled,
		toolStripeChar: toolStripeSettings.char,
		toolStripeColor: toolStripeSettings.color,
		toolStripeSide: toolStripeSettings.side,
	});
}

// ─── Dual-persistence state ─────────────────────────────────────────────────

function saveOverrides(pi: ExtensionAPI, overrides: RuntimeOverrides, repoName: string): void {
	pi.appendEntry(STATE_KEY, overrides);
	// Fire-and-forget disk write so overrides survive new sessions
	writeFile(getOverridesFile(repoName), JSON.stringify(overrides, null, 2), "utf8").catch(() => {
		/* disk write suppressed */
	});
}

async function restoreOverrides(
	ctx: ExtensionContext,
	_reportedErrors: Set<string>,
	repoName: string,
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

	// 2. Fall back to per-repo disk file (survives new sessions)
	try {
		const content = await readFile(getOverridesFile(repoName), "utf8");
		const parsed = JSON.parse(content) as RuntimeOverrides | undefined;
		if (parsed) return normalizeOverrides(parsed);
	} catch { /* file missing or unreadable */ }

	return {};
}

function hasPersistedOverrides(ctx: ExtensionContext): boolean {
	const stateEntry = [...ctx.sessionManager.getBranch()]
		.reverse()
		.find((e) => e.type === "custom" && e.customType === STATE_KEY);
	if (stateEntry?.data) return true;
	return false;
}

function pickRandomEmoji(): string {
	const emoji = EMOJI_PAGE_GRIDS[0] ?? [];
	if (emoji.length === 0) return "🦚";
	return emoji[Math.floor(Math.random() * emoji.length)] ?? "🦚";
}

async function ensureInitialEmoji(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	overrides: RuntimeOverrides,
	repoName: string,
): Promise<RuntimeOverrides> {
	if (overrides.emoji) return overrides;
	if (hasPersistedOverrides(ctx)) return overrides;
	if (await exists(getOverridesFile(repoName))) return overrides;

	const nextOverrides = { ...overrides, emoji: pickRandomEmoji() };
	saveOverrides(pi, nextOverrides, repoName);
	return nextOverrides;
}

function normalizeOverrides(data: RuntimeOverrides): RuntimeOverrides {
	const cleaned: RuntimeOverrides = {};
	if (data.autoAssignTheme !== undefined) cleaned.autoAssignTheme = data.autoAssignTheme;
	if (data.theme) cleaned.theme = data.theme;
	if (data.label) cleaned.label = data.label;
	if (data.emoji) cleaned.emoji = data.emoji;
	if (data.footerLine !== undefined) cleaned.footerLine = data.footerLine;
	if (data.footerLineColor) cleaned.footerLineColor = data.footerLineColor;
	const pattern = sanitizeFooterLinePattern(data.footerLinePattern);
	if (pattern) cleaned.footerLinePattern = pattern;
	if (data.footerLineWidth !== undefined) cleaned.footerLineWidth = data.footerLineWidth;
	if (data.footerLineAnimate !== undefined) cleaned.footerLineAnimate = data.footerLineAnimate;
	const animationMs = sanitizeFooterLineAnimationIntervalMs(data.footerLineAnimationMs);
	if (animationMs !== undefined) cleaned.footerLineAnimationMs = animationMs;
	if (data.showStatus !== undefined) cleaned.showStatus = data.showStatus;
	if (data.showBranch !== undefined) cleaned.showBranch = data.showBranch;
	if (data.showTitle !== undefined) cleaned.showTitle = data.showTitle;
	if (data.toolStripe !== undefined) cleaned.toolStripe = data.toolStripe;
	if (data.toolStripeColor) cleaned.toolStripeColor = data.toolStripeColor;
	if (data.toolStripeChar) cleaned.toolStripeChar = data.toolStripeChar;
	const stripeSide = sanitizeToolStripeSide(data.toolStripeSide);
	if (stripeSide) cleaned.toolStripeSide = stripeSide;
	return cleaned;
}

// ─── Interactive Settings UI ─────────────────────────────────────────────────

const SUBCOMMANDS = [
	"theme",
	"auto-theme",
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
const DEFAULT_LINE_COLOR = LINE_COLORS[2];
const DEFAULT_LINE_WIDTH = 1;

// ─── Tool stripe constants ───────────────────────────────────────────────────

const STRIPE_COLORS = ["accent", "border", "borderAccent", "muted", "dim", "success", "warning", "error"] as const;

interface StripeCharOption {
	label: string;
	char: string;
}

const STRIPE_CHARS: StripeCharOption[] = [
	{ label: "block", char: "▌" },
	{ label: "solid", char: "█" },
	{ label: "bar", char: "│" },
	{ label: "thin", char: "╎" },
	{ label: "dot", char: "┊" },
	{ label: "dash", char: "╵" },
	{ label: "double", char: "▎" },
	{ label: "arrow", char: "▸" },
	{ label: "diamond", char: "◆" },
	{ label: "star", char: "★" },
	{ label: "pound", char: "#" },
];

const STRIPE_SIDES = ["left", "right", "both"] as const satisfies readonly ToolStripeSide[];
const DEFAULT_STRIPE_CHAR = STRIPE_CHARS[0].char;
const DEFAULT_STRIPE_COLOR = STRIPE_COLORS[0];
const DEFAULT_STRIPE_SIDE = STRIPE_SIDES[0];
const STRIPE_CHAR_MIRRORS: Partial<Record<string, string>> = {
	"▌": "▐",
	"▎": "▕",
	"▸": "◂",
};

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
	{ label: "bek", char: "#", width: 8},
];

function sanitizeFooterLinePattern(pattern: string | undefined): string | undefined {
	if (!pattern) return undefined;
	const cleaned = pattern
		.replace(/[\x00-\x1f\x7f]/g, "")
		.trim()
		.slice(0, 16);
	if (!cleaned || visibleWidth(cleaned) === 0) return undefined;
	return cleaned || undefined;
}

function getLegacyLineChar(width: number | undefined): string {
	return LINE_WIDTHS.find((w) => w.width === width)?.char ?? LINE_WIDTHS[0].char;
}

function getFooterLinePattern(
	pattern: string | undefined,
	width: number | undefined,
): string {
	return sanitizeFooterLinePattern(pattern) ?? getLegacyLineChar(width);
}

function rotateFooterLinePattern(pattern: string, phase: number): string {
	const safePattern = sanitizeFooterLinePattern(pattern) ?? LINE_WIDTHS[0].char;
	const chars = Array.from(safePattern);
	if (chars.length <= 1) return safePattern;

	const offset = ((phase % chars.length) + chars.length) % chars.length;
	if (offset === 0) return safePattern;
	return chars.slice(offset).join("") + chars.slice(0, offset).join("");
}

function getFooterLineAnimationFrameCount(pattern: string): number {
	const safePattern = sanitizeFooterLinePattern(pattern) ?? LINE_WIDTHS[0].char;
	return Array.from(safePattern).length;
}

function buildFooterLine(pattern: string, width: number, phase: number = 0): string {
	const rotatedPattern = rotateFooterLinePattern(pattern, phase);
	let line = "";
	while (visibleWidth(line) < width) {
		line += rotatedPattern;
	}
	return truncateToWidth(line, width);
}

/**
 * Interactive settings panel — replaces editor temporarily with a full TUI.
	 * Supports settings, emoji picker, and inline text editors.
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
		let page: "settings" | "emoji" | "labelEdit" | "linePatternEdit" | "stripeCharEdit" = "settings";
		// Label edit state
		let labelBuffer = "";
		let labelCursor = 0;
		let linePatternBuffer = "";
		let linePatternCursor = 0;

		// Settings page state
		let overrides = { ...currentOverrides };
		const availableThemes = getAvailableThemeNames(ctx);
		let selectedThemeIdx = overrides.theme
			? availableThemes.indexOf(overrides.theme)
			: -1;

		const flags = mergeFlags(currentConfig, overrides);
		let labelText = overrides.label ?? currentIdentity.label;

		// Settings focus: 0=autoAssignTheme, 1=theme, 2=label, 3=status, 4=branch,
		//   5=title, 6=footerLine, 7=lineColor, 8=linePreset, 9=lineCustom,
		//   10=lineAnimate, 11=lineAnimationMs,
		//   12=toolStripe, 13=stripeColor, 14=stripeSide, 15=stripeChar, 16=stripeCustom,
		//   17=emoji, 18=save, 19=cancel
		const TOTAL_SETTINGS_OPTIONS = 20;
		const FOOTER_LINE_ANIMATION_STEP_MS = 40;
		let focusIndex = 0;
		const autoAssignThemeOn = () => isAutoAssignThemeEnabled(currentConfig, overrides);
		const themeRowEnabled = () => autoAssignThemeOn();
		const footerLineSettings = () => resolveFooterLineSettings(repo, currentConfig, overrides);
		const footerLineOn = () => footerLineSettings().enabled;
		const footerLineAnimationOn = () => footerLineSettings().animationEnabled;
		const footerLineAnimationMs = () => footerLineSettings().animationMs;
		let lineWidthIdx = LINE_WIDTHS.findIndex((w) => w.width === (footerLineSettings().width ?? DEFAULT_LINE_WIDTH));
		if (lineWidthIdx === -1) lineWidthIdx = 0;
		let lineColorIdx = Math.max(0,
			LINE_COLORS.indexOf(footerLineSettings().color as any));
		const customLinePattern = () => footerLineSettings().customPattern;

		// Tool stripe state
		const toolStripeSettings = () => resolveToolStripeSettings(repo, currentConfig, overrides);
		const toolStripeOn = () => toolStripeSettings().enabled;
		const toolStripeSide = () => toolStripeSettings().side;
		let stripeColorIdx = Math.max(0,
			STRIPE_COLORS.indexOf(toolStripeSettings().color as any));
		let stripeSideIdx = Math.max(0, STRIPE_SIDES.indexOf(toolStripeSide()));
		let stripeCharIdx = STRIPE_CHARS.findIndex((s) => s.char === toolStripeSettings().char);
		if (stripeCharIdx === -1) stripeCharIdx = 0;
		let stripeCustomBuffer = toolStripeSettings().char;
		let stripeCustomCursor = 0;

		function isVisibleFocusIndex(index: number): boolean {
			if (!themeRowEnabled() && index === 1) return false;
			if (!footerLineOn()) {
				if (index >= 7 && index <= 11) return false;
			}
			if (footerLineOn() && !footerLineAnimationOn() && index === 11) return false;
			if (!toolStripeOn()) {
				if (index >= 13 && index <= 16) return false;
			}
			return true;
		}

		function clampFocus() {
			if (!themeRowEnabled() && focusIndex === 1) focusIndex = 0;
			if (!footerLineOn()) {
				if (focusIndex >= 7 && focusIndex <= 11) focusIndex = 6;
			}
			if (footerLineOn() && !footerLineAnimationOn() && focusIndex === 11) focusIndex = 10;
			if (!toolStripeOn()) {
				if (focusIndex >= 13 && focusIndex <= 16) focusIndex = 12;
			}
		}

		function moveFocus(delta: -1 | 1) {
			let nextIndex = focusIndex;
			do {
				nextIndex = (nextIndex + delta + TOTAL_SETTINGS_OPTIONS) % TOTAL_SETTINGS_OPTIONS;
			} while (!isVisibleFocusIndex(nextIndex));
			focusIndex = nextIndex;
		}

		// Emoji picker state
		let emojiCategoryIdx = 0;
		let emojiCursorIdx = 0;
		const emojiCols = 8;

		// ── Helpers ──────────────────────────────────────────────────────

		function getLiveIdentity(): ResolvedIdentity {
			return resolveIdentity(repo, currentConfig, overrides);
		}

		function getThemeName(): string {
			const liveIdentity = getLiveIdentity();
			if (selectedThemeIdx === -1) return formatThemeValue(liveIdentity.theme);
			return availableThemes[selectedThemeIdx] ?? formatThemeValue(liveIdentity.theme);
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
			if (page === "linePatternEdit") return renderLinePatternEditPage(lines, add, width);
			if (page === "stripeCharEdit") return renderStripeCharEditPage(lines, add, width);
			return renderSettingsPage(lines, add, width);
		}

		function renderSettingsPage(lines: string[], add: (s: string) => void, width: number): string[] {
			const sel = (idx: number, text: string) =>
				focusIndex === idx ? theme.fg("accent", `▸ ${text}`) : `  ${text}`;
			const cur = (idx: number, text: string) =>
				focusIndex === idx ? theme.fg("accent", text) : theme.fg("text", text);

			add(theme.fg("accent", theme.bold(" ── pi-peacock settings ──")));
			lines.push("");

			const liveIdentity = getLiveIdentity();
			const liveThemeIdx = liveIdentity.theme
				? availableThemes.indexOf(liveIdentity.theme)
				: -1;

			add(theme.fg("dim", `   Repo: ${repo.repoName}  Branch: ${repo.branch}`));
			add(theme.fg("dim", `   Active rule: ${liveIdentity.source}`));
			lines.push("");

			// 1. Auto theme toggle
			const autoThemeCh = autoAssignThemeOn() ? theme.fg("success", "☑") : theme.fg("dim", "☐");
			add(`${focusIndex === 0 ? theme.fg("accent", "▸") : " "} ${autoThemeCh} ${theme.fg("dim", "Auto-assign theme:")}${focusIndex === 0 ? theme.fg("dim", "  Enter/space to toggle") : ""}`);
			lines.push("");

			// 2. Theme
			const tn = getThemeName();
			const themeHint = themeRowEnabled() && focusIndex === 1
				? theme.fg("dim", "  ← → browse")
				: "";
			if (themeRowEnabled()) {
				add(`${cur(1, "▸")}${focusIndex === 1 ? "" : " "} ${theme.fg("dim", "Theme:")}  ${theme.fg("accent", "■")} ${tn}${themeHint}`);
			} else {
				add(`  ${theme.fg("dim", "Theme:")}  ${theme.fg("dim", "■")} ${theme.fg("dim", tn)}`);
			}
			const themeBrowseIdx = selectedThemeIdx !== -1 ? selectedThemeIdx : liveThemeIdx;
			if (themeBrowseIdx !== -1) {
				if (availableThemes.length === 1) {
					add(`   ${theme.fg("dim", "1 installed theme available.")}`);
				} else {
					const prevTheme = availableThemes[(themeBrowseIdx - 1 + availableThemes.length) % availableThemes.length];
					const nextTheme = availableThemes[(themeBrowseIdx + 1) % availableThemes.length];
					add(`   ${theme.fg("dim", `${themeBrowseIdx + 1}/${availableThemes.length} installed · ← ${prevTheme} · → ${nextTheme}`)}`);
				}
			} else if (liveIdentity.theme) {
				add(`   ${theme.fg("warning", `Theme '${liveIdentity.theme}' is not currently installed.`)}`);
			} else {
				add(`   ${theme.fg("dim", "Current pi theme is preserved.")}`);
			}
			if (!themeRowEnabled()) {
				add(`   ${theme.fg("dim", `Enable Auto-assign theme to browse ${availableThemes.length} installed themes.`)}`);
			}
			lines.push("");

			// 3. Label
			add(`${focusIndex === 2 ? theme.fg("accent", `▸ ${theme.fg("dim", "Label:")}  ${labelText}  ${theme.fg("dim", "Enter to edit")}`) : `  ${theme.fg("dim", "Label:")}  ${labelText}`}`);
			lines.push("");

			// 4-6. Toggles
			const tog = [["Status badge", flags.showStatus], ["Branch name", flags.showBranch], ["Terminal title", flags.showTitle]];
			for (let i = 0; i < 3; i++) {
				const idx = i + 3;
				const ch = tog[i][1] ? theme.fg("success", "☑") : theme.fg("dim", "☐");
				add(`${focusIndex === idx ? theme.fg("accent", "▸") : " "} ${ch} ${tog[i][0]}${focusIndex === idx ? theme.fg("dim", "  Enter/space to toggle") : ""}`);
			}
			lines.push("");

			// 7. Footer line toggle
			const lineCh = footerLineOn() ? theme.fg("success", "☑") : theme.fg("dim", "☐");
			add(`${focusIndex === 6 ? theme.fg("accent", "▸") : " "} ${lineCh} ${theme.fg("dim", "Footer line:")}${focusIndex === 6 ? theme.fg("dim", "  Enter/space to toggle") : ""}`);
			if (footerLineOn()) {
				// 8. Line color
				const lc = LINE_COLORS[lineColorIdx] ?? DEFAULT_LINE_COLOR;
				const lcSwatch = theme.fg(lc as any, "───");
				add(`${focusIndex === 7 ? theme.fg("accent", "▸") : " "}   ${theme.fg("dim", "Color:")}  ${lcSwatch} ${lc}${focusIndex === 7 ? theme.fg("dim", "  ← →") : ""}`);
				// 9. Line preset
				const lw = LINE_WIDTHS[lineWidthIdx] ?? LINE_WIDTHS[0];
				add(`${focusIndex === 8 ? theme.fg("accent", "▸") : " "}   ${theme.fg("dim", "Preset:")}  ${lw.char.repeat(5)} ${lw.label}${focusIndex === 8 ? theme.fg("dim", "  ← →") : ""}`);
				// 10. Custom line pattern
				const customPattern = customLinePattern();
				const customText = customPattern ?? theme.fg("muted", "(preset active)");
				add(`${focusIndex === 9 ? theme.fg("accent", "▸") : " "}   ${theme.fg("dim", "Custom:")}  ${customText}${focusIndex === 9 ? theme.fg("dim", "  Enter to edit") : ""}`);
				// 11. Animation toggle
				const animationCh = footerLineAnimationOn() ? theme.fg("success", "☑") : theme.fg("dim", "☐");
				add(`${focusIndex === 10 ? theme.fg("accent", "▸") : " "} ${animationCh} ${theme.fg("dim", "Footer line animation:")}${focusIndex === 10 ? theme.fg("dim", "  Enter/space to toggle") : ""}`);
				// 12. Animation speed
				if (footerLineAnimationOn()) {
					add(`${focusIndex === 11 ? theme.fg("accent", "▸") : " "}   ${theme.fg("dim", "Animation speed:")}  ${footerLineAnimationMs()}ms${focusIndex === 11 ? theme.fg("dim", "  ← →") : ""}`);
				}
			}
			lines.push("");

			// 12. Tool stripe toggle
			const stripeCh = toolStripeOn() ? theme.fg("success", "☑") : theme.fg("dim", "☐");
			add(`${focusIndex === 12 ? theme.fg("accent", "▸") : " "} ${stripeCh} ${theme.fg("dim", "Tool stripe:")}${focusIndex === 12 ? theme.fg("dim", "  Enter/space to toggle") : ""}`);
			if (toolStripeOn()) {
				// 13. Stripe color
				const sc = STRIPE_COLORS[stripeColorIdx] ?? DEFAULT_STRIPE_COLOR;
				const stripeSampleChar = toolStripeSettings().char;
				const scSwatch = theme.fg(sc as any, `${stripeSampleChar}${getMirroredToolStripeChar(stripeSampleChar)}`);
				add(`${focusIndex === 13 ? theme.fg("accent", "▸") : " "}   ${theme.fg("dim", "Color:")}  ${scSwatch} ${sc}${focusIndex === 13 ? theme.fg("dim", "  ← →") : ""}`);
				// 14. Stripe side
				add(`${focusIndex === 14 ? theme.fg("accent", "▸") : " "}   ${theme.fg("dim", "Side:")}  ${toolStripeSide()}${focusIndex === 14 ? theme.fg("dim", "  ← →") : ""}`);
				// 15. Stripe char preset
				const schar = STRIPE_CHARS[stripeCharIdx] ?? STRIPE_CHARS[0];
				add(`${focusIndex === 15 ? theme.fg("accent", "▸") : " "}   ${theme.fg("dim", "Char:")}  ${schar.char} ${schar.label}${focusIndex === 15 ? theme.fg("dim", "  ← →") : ""}`);
				// 16. Custom stripe char
				const effectiveStripeChar = toolStripeSettings().char;
				const customStripeChar = !STRIPE_CHARS.some((s) => s.char === effectiveStripeChar)
					? effectiveStripeChar
					: undefined;
				const customStripeText = customStripeChar ?? theme.fg("muted", "(preset active)");
				add(`${focusIndex === 16 ? theme.fg("accent", "▸") : " "}   ${theme.fg("dim", "Custom:")}  ${customStripeText}${focusIndex === 16 ? theme.fg("dim", "  Enter to edit") : ""}`);
			}
			lines.push("");

			// 17. Emoji badge
			const curEmoji = overrides.emoji ?? "🦚";
			add(`${focusIndex === 17 ? theme.fg("accent", "▸") : " "} ${theme.fg("dim", "Emoji badge:")}  ${curEmoji}${focusIndex === 17 ? theme.fg("dim", "  Enter to pick") : ""}`);
			lines.push("");

			// Preview
			add(theme.fg("dim", " ── Preview ──"));
			const pl = overrides.label ?? labelText;
			const previewBadge = `${curEmoji} ${pl}`;
			const bt = flags.showBranch && repo.branch ? theme.fg("dim", ` · ${repo.branch}`) : "";
			add(`   ${theme.fg("accent", previewBadge)}${bt}`);
			if (footerLineOn()) {
				const lineSettings = footerLineSettings();
				add(`   ${theme.fg(lineSettings.color as any, buildFooterLine(lineSettings.pattern, Math.max(8, width - 3)))}`);
				add(`   ${theme.fg("dim", `Animation: ${footerLineAnimationOn() ? `active-only · ${footerLineAnimationMs()}ms` : "off"}`)}`);
			}
			if (toolStripeOn()) {
				const decoration = getToolStripeDecoration(theme, toolStripeSettings());
				const renderToolStripePreviewLine = (text: string) => {
					const childWidth = Math.max(1, width - 3 - visibleWidth(decoration.prefix) - visibleWidth(decoration.suffix));
					return `   ${decoration.prefix}${truncateToWidth(theme.fg("dim", text), childWidth, "", true)}${decoration.suffix}`;
				};
				add(renderToolStripePreviewLine("read src/index.ts"));
				add(renderToolStripePreviewLine("42 lines"));
				add(`   ${theme.fg("dim", `Side: ${toolStripeSide()}`)}`);
			}
			if (flags.showTitle) {
				const pfx = currentConfig.titlePrefix ?? DEFAULT_CONFIG.titlePrefix;
				add(`   ${theme.fg("dim", `Title: ${pfx} ${pl}${flags.showBranch && repo.branch ? ` · ${repo.branch}` : ""}`)}`);
			}
			lines.push("");

			// 18. Apply, 19. Cancel
			add(sel(18, theme.fg("success", "✓ Apply & close")));
			add(sel(19, theme.fg("muted", "✕ Cancel")));
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

		function renderLinePatternEditPage(lines: string[], add: (s: string) => void, _width: number): string[] {
			add(theme.fg("accent", theme.bold(" ── Edit footer line pattern ──")));
			lines.push("");
			add(theme.fg("dim", "   Repeated to fill the footer line width, e.g. #-# or =="));
			add(theme.fg("dim", "   Leave empty to fall back to config or the selected preset."));
			lines.push("");
			const before = linePatternBuffer.slice(0, linePatternCursor);
			const after = linePatternBuffer.slice(linePatternCursor);
			add("  " + theme.fg("accent", before) + theme.fg("success", "▁") + theme.fg("accent", after));
			lines.push("");
					add(theme.fg("dim", " Type text  ·  Enter confirm  ·  Esc cancel  ·  Backspace delete"));
			return lines;
		}

		function renderStripeCharEditPage(lines: string[], add: (s: string) => void, _width: number): string[] {
			add(theme.fg("accent", theme.bold(" ── Edit tool stripe char ──")));
			lines.push("");
			add(theme.fg("dim", "   Character(s) used for the accent stripe on tool blocks."));
			add(theme.fg("dim", "   Leave empty to fall back to config or the selected preset."));
			lines.push("");
			const before = stripeCustomBuffer.slice(0, stripeCustomCursor);
			const after = stripeCustomBuffer.slice(stripeCustomCursor);
			add("  " + theme.fg("accent", before) + theme.fg("success", "▁") + theme.fg("accent", after));
			lines.push("");
			add(theme.fg("dim", " Type text  ·  Enter confirm  ·  Esc cancel  ·  Backspace delete"));
			return lines;
		}

		// ── Input handling ────────────────────────────────────────────────

		function handleInput(data: string) {
			if (page === "emoji") { handleEmojiInput(data); return; }
			if (page === "labelEdit") { handleLabelEditInput(data); return; }
			if (page === "linePatternEdit") { handleLinePatternEditInput(data); return; }
			if (page === "stripeCharEdit") { handleStripeCharEditInput(data); return; }
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
				onChange(overrides); saveOverrides(pi, overrides, repo.repoName);
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

		function handleLinePatternEditInput(data: string) {
			if (data === String.fromCharCode(0x7f) || data === String.fromCharCode(0x08)) {
				if (linePatternCursor > 0) {
					linePatternBuffer = linePatternBuffer.slice(0, linePatternCursor - 1) + linePatternBuffer.slice(linePatternCursor);
					linePatternCursor--;
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const sanitized = sanitizeFooterLinePattern(linePatternBuffer);
				if (sanitized) {
					overrides.footerLinePattern = sanitized;
				} else {
					overrides.footerLinePattern = undefined;
				}
				onChange(overrides); saveOverrides(pi, overrides, repo.repoName);
				page = "settings";
				refresh();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				page = "settings";
				refresh();
				return;
			}
			if (matchesKey(data, Key.left)) {
				linePatternCursor = Math.max(0, linePatternCursor - 1); refresh(); return;
			}
			if (matchesKey(data, Key.right)) {
				linePatternCursor = Math.min(linePatternBuffer.length, linePatternCursor + 1); refresh(); return;
			}
			if (data.length === 1 && data.charCodeAt(0) < 0x20) return;
			if (data.startsWith(String.fromCharCode(0x1b))) return;
			if (data) {
				linePatternBuffer = (linePatternBuffer.slice(0, linePatternCursor) + data + linePatternBuffer.slice(linePatternCursor)).slice(0, 16);
				linePatternCursor = Math.min(linePatternBuffer.length, linePatternCursor + data.length);
				refresh();
			}
		}

		function handleStripeCharEditInput(data: string) {
			if (data === String.fromCharCode(0x7f) || data === String.fromCharCode(0x08)) {
				if (stripeCustomCursor > 0) {
					stripeCustomBuffer = stripeCustomBuffer.slice(0, stripeCustomCursor - 1) + stripeCustomBuffer.slice(stripeCustomCursor);
					stripeCustomCursor--;
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const sanitized = sanitizeStripeChar(stripeCustomBuffer);
				if (sanitized && sanitized !== DEFAULT_STRIPE_CHAR) {
					overrides.toolStripeChar = sanitized;
				} else {
					overrides.toolStripeChar = undefined;
				}
				onChange(overrides); saveOverrides(pi, overrides, repo.repoName);
				page = "settings";
				refresh();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				page = "settings";
				refresh();
				return;
			}
			if (matchesKey(data, Key.left)) {
				stripeCustomCursor = Math.max(0, stripeCustomCursor - 1); refresh(); return;
			}
			if (matchesKey(data, Key.right)) {
				stripeCustomCursor = Math.min(stripeCustomBuffer.length, stripeCustomCursor + 1); refresh(); return;
			}
			if (data.length === 1 && data.charCodeAt(0) < 0x20) return;
			if (data.startsWith(String.fromCharCode(0x1b))) return;
			if (data) {
				stripeCustomBuffer = (stripeCustomBuffer.slice(0, stripeCustomCursor) + data + stripeCustomBuffer.slice(stripeCustomCursor)).slice(0, 4);
				stripeCustomCursor = Math.min(stripeCustomBuffer.length, stripeCustomCursor + data.length);
				refresh();
			}
		}

		function handleSettingsInput(data: string) {
			if (matchesKey(data, Key.up)) {
				moveFocus(-1);
				clampFocus();
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				moveFocus(1);
				clampFocus();
				refresh();
				return;
			}
			if (matchesKey(data, Key.left)) {
				if (focusIndex === 1 && themeRowEnabled() && availableThemes.length > 0) {
					selectedThemeIdx = selectedThemeIdx === -1
						? availableThemes.length - 1
						: (selectedThemeIdx - 1 + availableThemes.length) % availableThemes.length;
					overrides.theme = availableThemes[selectedThemeIdx];
				} else if (focusIndex === 7 && footerLineOn()) {
					lineColorIdx = (lineColorIdx - 1 + LINE_COLORS.length) % LINE_COLORS.length;
					overrides.footerLineColor = LINE_COLORS[lineColorIdx];
				} else if (focusIndex === 8 && footerLineOn()) {
					lineWidthIdx = (lineWidthIdx - 1 + LINE_WIDTHS.length) % LINE_WIDTHS.length;
					overrides.footerLineWidth = LINE_WIDTHS[lineWidthIdx].width;
					overrides.footerLinePattern = undefined;
				} else if (focusIndex === 11 && footerLineOn() && footerLineAnimationOn()) {
					overrides.footerLineAnimationMs = sanitizeFooterLineAnimationIntervalMs(footerLineAnimationMs() - FOOTER_LINE_ANIMATION_STEP_MS) ?? FOOTER_LINE_ANIMATION_INTERVAL_MS;
				} else if (focusIndex === 13 && toolStripeOn()) {
					stripeColorIdx = (stripeColorIdx - 1 + STRIPE_COLORS.length) % STRIPE_COLORS.length;
					overrides.toolStripeColor = STRIPE_COLORS[stripeColorIdx];
				} else if (focusIndex === 14 && toolStripeOn()) {
					stripeSideIdx = (stripeSideIdx - 1 + STRIPE_SIDES.length) % STRIPE_SIDES.length;
					overrides.toolStripeSide = STRIPE_SIDES[stripeSideIdx];
				} else if (focusIndex === 15 && toolStripeOn()) {
					stripeCharIdx = (stripeCharIdx - 1 + STRIPE_CHARS.length) % STRIPE_CHARS.length;
					overrides.toolStripeChar = STRIPE_CHARS[stripeCharIdx].char;
				}
				if ((focusIndex === 1 && themeRowEnabled() && availableThemes.length > 0) || focusIndex === 7 || focusIndex === 8 || focusIndex === 11 || focusIndex === 13 || focusIndex === 14 || focusIndex === 15) {
					onChange(overrides);
					saveOverrides(pi, overrides, repo.repoName);
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.right)) {
				if (focusIndex === 1 && themeRowEnabled() && availableThemes.length > 0) {
					selectedThemeIdx = selectedThemeIdx === -1
						? 0
						: (selectedThemeIdx + 1) % availableThemes.length;
					overrides.theme = availableThemes[selectedThemeIdx];
				} else if (focusIndex === 7 && footerLineOn()) {
					lineColorIdx = (lineColorIdx + 1) % LINE_COLORS.length;
					overrides.footerLineColor = LINE_COLORS[lineColorIdx];
				} else if (focusIndex === 8 && footerLineOn()) {
					lineWidthIdx = (lineWidthIdx + 1) % LINE_WIDTHS.length;
					overrides.footerLineWidth = LINE_WIDTHS[lineWidthIdx].width;
					overrides.footerLinePattern = undefined;
				} else if (focusIndex === 11 && footerLineOn() && footerLineAnimationOn()) {
					overrides.footerLineAnimationMs = sanitizeFooterLineAnimationIntervalMs(footerLineAnimationMs() + FOOTER_LINE_ANIMATION_STEP_MS) ?? FOOTER_LINE_ANIMATION_INTERVAL_MS;
				} else if (focusIndex === 13 && toolStripeOn()) {
					stripeColorIdx = (stripeColorIdx + 1) % STRIPE_COLORS.length;
					overrides.toolStripeColor = STRIPE_COLORS[stripeColorIdx];
				} else if (focusIndex === 14 && toolStripeOn()) {
					stripeSideIdx = (stripeSideIdx + 1) % STRIPE_SIDES.length;
					overrides.toolStripeSide = STRIPE_SIDES[stripeSideIdx];
				} else if (focusIndex === 15 && toolStripeOn()) {
					stripeCharIdx = (stripeCharIdx + 1) % STRIPE_CHARS.length;
					overrides.toolStripeChar = STRIPE_CHARS[stripeCharIdx].char;
				}
				if ((focusIndex === 1 && themeRowEnabled() && availableThemes.length > 0) || focusIndex === 7 || focusIndex === 8 || focusIndex === 11 || focusIndex === 13 || focusIndex === 14 || focusIndex === 15) {
					onChange(overrides);
					saveOverrides(pi, overrides, repo.repoName);
				}
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
				if (focusIndex === 0) {
					overrides.autoAssignTheme = !autoAssignThemeOn();
					if (!overrides.autoAssignTheme) {
						overrides.theme = undefined;
						selectedThemeIdx = -1;
					}
					clampFocus();
					onChange(overrides); saveOverrides(pi, overrides, repo.repoName); refresh();
					return;
				}
				if (focusIndex === 2) {
					labelBuffer = overrides.label ?? labelText;
					labelCursor = labelBuffer.length;
					page = "labelEdit";
					refresh();
					return;
				}
				if (focusIndex === 3) {
					flags.showStatus = !flags.showStatus;
					overrides.showStatus = flags.showStatus;
					onChange(overrides); saveOverrides(pi, overrides, repo.repoName); refresh();
					return;
				}
				if (focusIndex === 4) {
					flags.showBranch = !flags.showBranch;
					overrides.showBranch = flags.showBranch;
					onChange(overrides); saveOverrides(pi, overrides, repo.repoName); refresh();
					return;
				}
				if (focusIndex === 5) {
					flags.showTitle = !flags.showTitle;
					overrides.showTitle = flags.showTitle;
					onChange(overrides); saveOverrides(pi, overrides, repo.repoName); refresh();
					return;
				}
				if (focusIndex === 6) {
					overrides.footerLine = !footerLineOn();
					if (!overrides.footerLine) {
						overrides.footerLineColor = undefined;
					}
					onChange(overrides); saveOverrides(pi, overrides, repo.repoName); refresh();
					return;
				}
				if (focusIndex === 9 && footerLineOn()) {
					linePatternBuffer = customLinePattern() ?? "";
					linePatternCursor = linePatternBuffer.length;
					page = "linePatternEdit";
					refresh();
					return;
				}
				if (focusIndex === 10 && footerLineOn()) {
					overrides.footerLineAnimate = !footerLineAnimationOn();
					onChange(overrides); saveOverrides(pi, overrides, repo.repoName); clampFocus(); refresh();
					return;
				}
				if (focusIndex === 12) {
					overrides.toolStripe = !toolStripeOn();
					if (!overrides.toolStripe) {
						overrides.toolStripeColor = undefined;
						overrides.toolStripeChar = undefined;
						overrides.toolStripeSide = undefined;
					}
					onChange(overrides); saveOverrides(pi, overrides, repo.repoName); clampFocus(); refresh();
					return;
				}
				if (focusIndex === 16 && toolStripeOn()) {
					stripeCustomBuffer = toolStripeSettings().char;
					stripeCustomCursor = stripeCustomBuffer.length;
					page = "stripeCharEdit";
					refresh();
					return;
				}
				if (focusIndex === 17) {
					page = "emoji";
					emojiCategoryIdx = 0;
					emojiCursorIdx = 0;
					refresh();
					return;
				}
				if (focusIndex === 18) {
					onChange(overrides); saveOverrides(pi, overrides, repo.repoName); done();
					return;
				}
				if (focusIndex === 19) {
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
					onChange(overrides); saveOverrides(pi, overrides, repo.repoName);
					copyEmoji(emoji[emojiCursorIdx]);
					page = "settings";
					focusIndex = 17; // back to emoji badge item
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
	let toolStripeSettings: ResolvedToolStripeSettings = {
		enabled: false,
		color: DEFAULT_STRIPE_COLOR,
		char: DEFAULT_STRIPE_CHAR,
		side: DEFAULT_STRIPE_SIDE,
	};
	let availableThemeNames = [...AUTO_THEMES] as string[];
	let currentRepoName = "";
	const reportedConfigErrors = new Set<string>();
	const reportedThemeErrors = new Set<string>();
	let footerAnimationTimer: ReturnType<typeof setInterval> | null = null;
	let footerAnimationPhase = 0;
	let footerAnimationCtx: ExtensionContext | null = null;
	let footerAnimationEnabled = false;
	let footerAnimationAllowed = true;
	let footerAnimationIntervalMs = FOOTER_LINE_ANIMATION_INTERVAL_MS;
	let footerAnimationLineColor: string = DEFAULT_LINE_COLOR;
	let footerAnimationLinePattern = getLegacyLineChar(DEFAULT_LINE_WIDTH);

	registerStripedBuiltInTools(pi, () => toolStripeSettings);

	function renderFooterLineWidget(ctx: ExtensionContext): void {
		if (!footerAnimationEnabled) {
			ctx.ui.setWidget("pi-peacock-line", undefined);
			return;
		}

		const lineColor = footerAnimationLineColor;
		const linePattern = footerAnimationLinePattern;
		const phase = footerAnimationTimer ? footerAnimationPhase : 0;
		ctx.ui.setWidget(
			"pi-peacock-line",
			(_tui, th) => ({
				render: (w: number) => [th.fg(lineColor as any, buildFooterLine(linePattern, w, phase))],
				invalidate() {},
			}),
			{ placement: "belowEditor" },
		);
	}

	function stopFooterLineAnimation(redrawStaticLine: boolean = true): void {
		if (footerAnimationTimer) {
			clearInterval(footerAnimationTimer);
			footerAnimationTimer = null;
		}
		footerAnimationPhase = 0;
		if (redrawStaticLine && footerAnimationCtx && footerAnimationEnabled) {
			try {
				renderFooterLineWidget(footerAnimationCtx);
			} catch {
				// ctx is stale after session replacement/reload; skip redraw
			}
		}
	}

	function startFooterLineAnimation(ctx: ExtensionContext): void {
		footerAnimationCtx = ctx;
		if (!footerAnimationEnabled || !footerAnimationAllowed) return;

		const frameCount = getFooterLineAnimationFrameCount(footerAnimationLinePattern);
		if (frameCount <= 1) {
			stopFooterLineAnimation(true);
			return;
		}
		if (footerAnimationTimer) return;

		footerAnimationPhase = 0;
		renderFooterLineWidget(ctx);
		footerAnimationTimer = setInterval(() => {
			if (!footerAnimationCtx || !footerAnimationEnabled || !footerAnimationAllowed) return;
			footerAnimationPhase = (footerAnimationPhase + 1) % frameCount;
			try {
				renderFooterLineWidget(footerAnimationCtx);
			} catch {
				stopFooterLineAnimation(false);
			}
		}, footerAnimationIntervalMs);
	}

	async function applyIdentity(
		ctx: ExtensionContext,
		force: boolean = false,
		skipAnimationStart: boolean = false,
	): Promise<AppliedIdentity> {
		availableThemeNames = getAvailableThemeNames(ctx);
		const repo = await getRepoInfo(ctx.cwd);
		currentRepoName = repo.repoName;
		const { config, configPaths } = await loadConfig(
			repo, reportedConfigErrors,
			(msg: string) => ctx.ui.notify(msg, "warning"),
		);
		const identity = resolveIdentity(repo, config, runtimeOverrides);
		const flags = mergeFlags(config, runtimeOverrides);
		const footerLineSettings = resolveFooterLineSettings(repo, config, runtimeOverrides);
		toolStripeSettings = resolveToolStripeSettings(repo, config, runtimeOverrides);
		const signature = getSignature(repo, identity, flags, footerLineSettings, toolStripeSettings);

		if (!force && signature === lastSignature) {
			return { configPaths, identity, repo, signature };
		}

		// Apply theme when one is assigned. Otherwise preserve the current pi theme.
		if (identity.theme) {
			const themeResult = ctx.ui.setTheme(identity.theme);
			if (!themeResult.success && !reportedThemeErrors.has(identity.theme)) {
				reportedThemeErrors.add(identity.theme);
				ctx.ui.notify(`pi-peacock: theme '${identity.theme}' not found`, "warning");
			}
		}

		// Footer: status badge + optional horizontal line ABOVE footer
		const hasLine = footerLineSettings.enabled && flags.showStatus;
		const badgeText = getStatusText(ctx, repo, identity, flags, runtimeOverrides.emoji);

		if (badgeText) {
			ctx.ui.setStatus(STATUS_KEY, badgeText);
		} else {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}

		footerAnimationCtx = ctx;
		footerAnimationEnabled = hasLine;
		footerAnimationAllowed = footerLineSettings.animationEnabled;
		const nextFooterAnimationIntervalMs = footerLineSettings.animationMs;
		const footerAnimationNeedsRestart = footerAnimationTimer !== null && footerAnimationIntervalMs !== nextFooterAnimationIntervalMs;
		footerAnimationIntervalMs = nextFooterAnimationIntervalMs;
		footerAnimationLineColor = footerLineSettings.color;
		footerAnimationLinePattern = footerLineSettings.pattern;
		if (hasLine) {
			if (footerAnimationNeedsRestart) {
				stopFooterLineAnimation(false);
			}
			renderFooterLineWidget(ctx);
			if (!skipAnimationStart && !ctx.isIdle() && footerAnimationAllowed) {
				startFooterLineAnimation(ctx);
			} else {
				stopFooterLineAnimation(true);
			}
		} else {
			stopFooterLineAnimation(false);
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
		const repo = await getRepoInfo(ctx.cwd);
		const { config } = await loadConfig(repo, reportedConfigErrors, (m: string) => ctx.ui.notify(m, "warning"));
		if (!isAutoAssignThemeEnabled(config, runtimeOverrides)) {
			ctx.ui.notify("pi-peacock: enable Auto-assign theme in /peacock before using /peacock theme", "warning");
			return;
		}

		const availableThemes = getAvailableThemeNames(ctx);
		availableThemeNames = availableThemes;
		const name = args.trim();
		if (!name) {
			const choice = await ctx.ui.select("Select a theme for this repo:", availableThemes);
			if (!choice) return;
			runtimeOverrides.theme = choice;
		} else {
			const tr = ctx.ui.setTheme(name);
			if (!tr.success) {
				ctx.ui.notify(
					`pi-peacock: theme '${name}' not found. Installed themes: ${formatThemeListPreview(availableThemes)}`,
					"warning",
				);
				return;
			}
			runtimeOverrides.theme = name;
		}
		saveOverrides(pi, runtimeOverrides, currentRepoName);
		const applied = await applyIdentity(ctx, true);
		ctx.ui.notify(`pi-peacock: theme → ${formatThemeName(applied.identity.theme)}`, "info");
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
		saveOverrides(pi, runtimeOverrides, currentRepoName);
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
		saveOverrides(pi, runtimeOverrides, currentRepoName);
		await applyIdentity(ctx, true);
		ctx.ui.notify(`pi-peacock: ${feature} → ${runtimeOverrides[validFeatures[feature]] ? "on" : "off"}`, "info");
	}

	async function cmdAutoTheme(args: string, ctx: ExtensionContext): Promise<void> {
		const repo = await getRepoInfo(ctx.cwd);
		const { config } = await loadConfig(repo, reportedConfigErrors, (m: string) => ctx.ui.notify(m, "warning"));
		const value = args.trim().toLowerCase();
		const current = isAutoAssignThemeEnabled(config, runtimeOverrides);

		let next: boolean;
		if (!value || value === "toggle") next = !current;
		else if (value === "on") next = true;
		else if (value === "off") next = false;
		else {
			ctx.ui.notify(`pi-peacock: unknown auto-theme value '${value}'. Use: on or off`, "warning");
			return;
		}

		runtimeOverrides.autoAssignTheme = next;
		if (!next) {
			runtimeOverrides.theme = undefined;
		}
		saveOverrides(pi, runtimeOverrides, currentRepoName);
		const applied = await applyIdentity(ctx, true);
		ctx.ui.notify(`pi-peacock: auto-theme → ${next ? "on" : "off"} · ${formatThemeName(applied.identity.theme)}`, "info");
	}

	async function cmdReset(_args: string, ctx: ExtensionContext): Promise<void> {
		const ok = await ctx.ui.confirm("Reset peacock overrides?", "This clears all runtime settings and reverts to file config.");
		if (!ok) return;
		runtimeOverrides = {};
		lastSignature = "";
		saveOverrides(pi, runtimeOverrides, currentRepoName);
		const applied = await applyIdentity(ctx, true);
		ctx.ui.notify(`pi-peacock: reset — using ${formatThemeName(applied.identity.theme)} (${applied.identity.source})`, "info");
	}

	async function cmdStatus(_args: string, ctx: ExtensionContext): Promise<void> {
		const applied = await applyIdentity(ctx, true);
		const branch = applied.repo.branch ? ` · ${applied.repo.branch}` : "";
		const configText = applied.configPaths.length > 0 ? `configs: ${applied.configPaths.join(", ")}` : "configs: none";
		const overrideKeys = Object.keys(runtimeOverrides);
		const overridesText = overrideKeys.length > 0 ? `overrides: ${overrideKeys.join(", ")}` : "overrides: none";
		ctx.ui.notify(`pi-peacock: ${applied.identity.label} → ${formatThemeName(applied.identity.theme)} (${applied.identity.source})${branch} · ${configText} · ${overridesText}`, "info");
	}

	async function cmdEmoji(_args: string, ctx: ExtensionContext): Promise<void> {
		const repo = await getRepoInfo(ctx.cwd);
		const { config } = await loadConfig(repo, reportedConfigErrors, (m: string) => ctx.ui.notify(m, "warning"));
		const identity = resolveIdentity(repo, config, runtimeOverrides);
		await showSettingsPanel(pi, ctx, runtimeOverrides, config, identity, repo,
			(n) => { runtimeOverrides = n; applyIdentity(ctx, true).catch(() => {}); });
		saveOverrides(pi, runtimeOverrides, currentRepoName);
		await applyIdentity(ctx, true);
	}

	async function showFullSettings(ctx: ExtensionContext): Promise<void> {
		const repo = await getRepoInfo(ctx.cwd);
		const { config } = await loadConfig(repo, reportedConfigErrors, (m: string) => ctx.ui.notify(m, "warning"));
		const identity = resolveIdentity(repo, config, runtimeOverrides);
		await showSettingsPanel(pi, ctx, runtimeOverrides, config, identity, repo,
			(n) => { runtimeOverrides = n; applyIdentity(ctx, true).catch(() => {}); });
		saveOverrides(pi, runtimeOverrides, currentRepoName);
		await applyIdentity(ctx, true);
	}

	// ── Register /peacock command ────────────────────────────────────────

	pi.registerCommand("peacock", {
		description: "Manage pi-peacock repo identity. Usage: /peacock [theme|auto-theme|label|toggle|emoji|reset|status]",
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
				const f = availableThemeNames.filter((t) => t.startsWith(word)).map((t) => ({ value: t, label: t }));
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
			if (cmd === "auto-theme") {
				const opts = [
					{ value: "on", label: "on", description: "Enable auto theme assignment" },
					{ value: "off", label: "off", description: "Disable auto theme assignment" },
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
				case "auto-theme": await cmdAutoTheme(rest, ctx); break;
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
		"auto-theme": "Enable or disable auto theme assignment (e.g. /peacock auto-theme on)",
		label: "Set a custom label (e.g. /peacock label backend)",
		emoji: "Pick an emoji for the footer badge",
		toggle: "Toggle a feature: status, branch, or title",
		reset: "Clear all runtime overrides, revert to file config",
		status: "Show current identity info",
	};

	// ── Discover bundled themes ──────────────────────────────────────────

	// Track whether session_start applied its theme successfully.
	// On initial startup, resources_discover fires AFTER session_start,
	// so bundled peacock themes are not yet registered when session_start
	// tries to switch. We retry theme application in resources_discover
	// once themes become available.
	let themeApplied = false;

	pi.on("resources_discover", async (_e, ctx) => {
		const globalThemesDir = path.join(os.homedir(), ".pi", "agent", "themes");
		if (THEMES_DIR === globalThemesDir) return undefined;

		// If session_start already applied the theme successfully, nothing to do.
		if (themeApplied) return { themePaths: [THEMES_DIR] };

		// Bundled themes are now registered. Re-apply identity to pick up
		// any peacock theme that failed during session_start.
		if (currentRepoName) {
			reportedThemeErrors.clear();
			const applied = await applyIdentity(ctx, true);
			// Mark as applied if there was no theme to apply, or if setTheme succeeded.
			if (!applied.identity.theme) {
				themeApplied = true;
			} else {
				availableThemeNames = getAvailableThemeNames(ctx);
				themeApplied = availableThemeNames.includes(applied.identity.theme);
			}
		}

		return { themePaths: [THEMES_DIR] };
	});

	// ── Lifecycle hooks ──────────────────────────────────────────────────

	pi.on("session_start", async (_e, ctx) => {
		const repo = await getRepoInfo(ctx.cwd);
		currentRepoName = repo.repoName;
		runtimeOverrides = await restoreOverrides(ctx, reportedConfigErrors, currentRepoName);
		runtimeOverrides = await ensureInitialEmoji(pi, ctx, runtimeOverrides, currentRepoName);
		lastSignature = "";
		themeApplied = false;
		await applyIdentity(ctx);
	});

	pi.on("session_tree", async (_e, ctx) => {
		const repo = await getRepoInfo(ctx.cwd);
		currentRepoName = repo.repoName;
		runtimeOverrides = await restoreOverrides(ctx, reportedConfigErrors, currentRepoName);
		runtimeOverrides = await ensureInitialEmoji(pi, ctx, runtimeOverrides, currentRepoName);
		lastSignature = "";
		await applyIdentity(ctx);
	});

	pi.on("agent_start", async (_e, ctx) => {
		startFooterLineAnimation(ctx);
	});

	pi.on("agent_end", async (_e, ctx) => {
		stopFooterLineAnimation(true);
		await applyIdentity(ctx, true, true);
	});

	pi.on("turn_end", async (_e, ctx) => {
		await applyIdentity(ctx);
	});

	pi.on("session_shutdown", async (_e, ctx) => {
		stopFooterLineAnimation(false);
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget("pi-peacock-line", undefined);
	});
}
