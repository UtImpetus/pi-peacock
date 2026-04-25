/**
 * pi-peacock — Emoji Picker
 *
 * Interactive emoji browser that generates emoji directly from Unicode ranges
 * (no hardcoded list). Browse categories, navigate with arrows, select to copy.
 *
 * Usage: /emoji
 *
 * Unicode ranges covered:
 *   Smileys    U+1F600–U+1F64F
 *   Gestures   U+1F9B0–U+1F9FF
 *   People     U+1F300–U+1F3FF
 *   Animals    U+1F400–U+1F4FF
 *   Food       U+1F32D–U+1F37F
 *   Travel     U+1F680–U+1F6FF
 *   Activities U+1F3A0–U+1F3FF
 *   Objects    U+1F4A0–U+1F5FF
 *   Symbols    Various blocks (U+2600–U+27BF, U+2300–U+23FF, etc.)
 *   Flags      U+1F1E6–U+1F1FF (regional indicator symbols)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";

const execFileAsync = promisify(execFile);

// ─── Unicode ranges ─────────────────────────────────────────────────────────

interface EmojiRange {
	name: string;
	ranges: [number, number][];
}

const CATEGORY_RANGES: EmojiRange[] = [
	{
		name: "Smileys",
		ranges: [[0x1f600, 0x1f64f]],
	},
	{
		name: "Gestures",
		ranges: [[0x1f9b0, 0x1f9ff]],
	},
	{
		name: "People",
		ranges: [
			[0x1f300, 0x1f3ff],
		],
	},
	{
		name: "Animals",
		ranges: [[0x1f400, 0x1f4ff]],
	},
	{
		name: "Food",
		ranges: [
			[0x1f32d, 0x1f37f],
		],
	},
	{
		name: "Travel",
		ranges: [[0x1f680, 0x1f6ff]],
	},
	{
		name: "Activities",
		ranges: [[0x1f3a0, 0x1f3ff]],
	},
	{
		name: "Objects",
		ranges: [
			[0x1f4a0, 0x1f5ff],
		],
	},
	{
		name: "Symbols",
		ranges: [
			[0x2600, 0x26ff],
			[0x2700, 0x27bf],
			[0x2300, 0x23ff],
			[0x2934, 0x2935],
			[0x2b05, 0x2b55],
			[0x3030, 0x303d],
			[0x3297, 0x3299],
		],
	},
	{
		name: "Flags",
		ranges: [[0x1f1e6, 0x1f1ff]],
	},
];

/** Pre-compute "All" category as union of all ranges */
function getAllRanges(): [number, number][] {
	const all: [number, number][] = [];
	for (const cat of CATEGORY_RANGES) {
		for (const r of cat.ranges) {
			all.push(r);
		}
	}
	return all;
}

const ALL_CATEGORIES: EmojiRange[] = [
	{ name: "All", ranges: getAllRanges() },
	...CATEGORY_RANGES,
];

/** Generate emoji code points from a set of ranges */
function generateEmoji(ranges: [number, number][]): string[] {
	const result: string[] = [];
	const seen = new Set<number>();
	for (const [start, end] of ranges) {
		for (let cp = start; cp <= end; cp++) {
			if (seen.has(cp)) continue;
			seen.add(cp);
			try {
				const char = String.fromCodePoint(cp);
				// Skip variation selectors and ZWJ
				if (cp >= 0xfe00 && cp <= 0xfe0f) continue;
				if (cp === 0x200d) continue;
				if (cp === 0x200b) continue;
				if (cp === 0xfeff) continue;
				result.push(char);
			} catch {
				// Invalid code point, skip
			}
		}
	}
	return result;
}

// Pre-compute emoji for each category
const CATEGORY_EMOJI: string[][] = ALL_CATEGORIES.map((cat) =>
	generateEmoji(cat.ranges),
);

// ─── Clipboard helpers ──────────────────────────────────────────────────────

type ClipboardResult = { ok: true } | { ok: false; error: string };

async function copyToClipboard(text: string): Promise<ClipboardResult> {
	const platform = os.platform();

	try {
		if (platform === "darwin") {
			// macOS
			const proc = execFile("pbcopy", [], { encoding: "utf8" });
			if (proc.stdin) {
				proc.stdin.end(text);
			}
			await new Promise<void>((resolve, reject) => {
				proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exit ${code}`))));
				proc.on("error", reject);
			});
			return { ok: true };
		}

		if (platform === "linux") {
			// Try wl-copy (Wayland) first, then xclip (X11)
			try {
				await execFileAsync("wl-copy", [text]);
				return { ok: true };
			} catch {
				try {
					await execFileAsync("xclip", ["-selection", "clipboard"], {
						input: text,
					});
					return { ok: true };
				} catch {
					try {
						await execFileAsync("xsel", ["-b", "-i"], { input: text });
						return { ok: true };
					} catch {
						return { ok: false, error: "No clipboard tool found (install wl-clipboard or xclip)" };
					}
				}
			}
		}

		if (platform === "win32") {
			const proc = execFile("clip", [], { encoding: "utf8" });
			if (proc.stdin) {
				proc.stdin.end(text);
			}
			await new Promise<void>((resolve, reject) => {
				proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`clip exit ${code}`))));
				proc.on("error", reject);
			});
			return { ok: true };
		}

		return { ok: false, error: `Unsupported platform: ${platform}` };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

// ─── Extension Factory ──────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerCommand("emoji", {
		description: "Open interactive emoji picker. Browse Unicode emoji by category, select to copy.",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Emoji picker requires interactive mode", "warning");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				// ── State ────────────────────────────────────────────────
				let categoryIndex = 0;
				let cursorIndex = 0; // flat index within current category
				const cols = 8; // emoji per row

				function currentCategory(): string {
					return ALL_CATEGORIES[categoryIndex]?.name ?? "All";
				}

				function currentEmoji(): string[] {
					return CATEGORY_EMOJI[categoryIndex] ?? [];
				}

				function totalEmoji(): number {
					return currentEmoji().length;
				}

				function totalRows(): number {
					return Math.ceil(totalEmoji() / cols);
				}

				function clampCursor() {
					if (cursorIndex >= totalEmoji() && totalEmoji() > 0) {
						cursorIndex = totalEmoji() - 1;
					}
					if (cursorIndex < 0) cursorIndex = 0;
				}

				// ── Rendering ────────────────────────────────────────────
				let cachedLines: string[] | undefined;

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					// Header
					add(theme.fg("accent", theme.bold(" ── Emoji Picker ──")));
					lines.push("");

					// Category tabs (single line)
					const tabParts: string[] = [];
					for (let i = 0; i < ALL_CATEGORIES.length; i++) {
						const name = ALL_CATEGORIES[i].name;
						if (i === categoryIndex) {
							tabParts.push(theme.fg("accent", `[${name}]`));
						} else {
							tabParts.push(theme.fg("dim", name));
						}
					}
					add(tabParts.join("  "));
					lines.push("");

					// Emoji grid
					const emoji = currentEmoji();
					if (emoji.length === 0) {
						add(theme.fg("muted", "  (no emoji in this category)"));
					} else {
						// Calculate visible range based on cursor
						const visibleRows = Math.min(8, totalRows());
						const cursorRow = Math.floor(cursorIndex / cols);
						const startRow = Math.max(
							0,
							Math.min(cursorRow - Math.floor(visibleRows / 2), totalRows() - visibleRows),
						);
						const endRow = Math.min(startRow + visibleRows, totalRows());

						for (let row = startRow; row < endRow; row++) {
							let rowText = "";
							for (let col = 0; col < cols; col++) {
								const idx = row * cols + col;
								if (idx >= emoji.length) {
									rowText += "  ";
									continue;
								}
								const isCursor = idx === cursorIndex;
								const char = emoji[idx];
								const cell = isCursor
									? theme.fg("accent", `[${char}]`)
									: ` ${char} `;
								// Ensure consistent width: each cell ≈ 3 chars wide
								rowText += cell;
							}
							add(rowText);
						}

						// Scroll indicators
						if (totalRows() > visibleRows) {
							const scrollPos = Math.round(
								(startRow / Math.max(1, totalRows() - visibleRows)) * 100,
							);
							add(
								theme.fg(
									"dim",
									`  ${cursorRow + 1}/${totalRows()} rows  ·  ${emoji.length} emoji  ·  ${scrollPos}%`,
								),
							);
						}
					}

					lines.push("");
					add(
						theme.fg(
							"dim",
							" ← → categories  ·  ↑↓←→ navigate  ·  Enter copy  ·  Esc close",
						),
					);

					cachedLines = lines;
					return lines;
				}

				// ── Input handling ───────────────────────────────────────
				function handleInput(data: string) {
					const emoji = currentEmoji();
					const rows = totalRows();

					if (matchesKey(data, Key.left)) {
						if (emoji.length > 0) {
							// Move cursor left or wrap to previous row
							cursorIndex = Math.max(0, cursorIndex - 1);
						}
						refresh();
						return;
					}

					if (matchesKey(data, Key.right)) {
						if (emoji.length > 0) {
							cursorIndex = Math.min(emoji.length - 1, cursorIndex + 1);
						}
						refresh();
						return;
					}

					if (matchesKey(data, Key.up)) {
						if (emoji.length > 0) {
							cursorIndex = Math.max(0, cursorIndex - cols);
						}
						refresh();
						return;
					}

					if (matchesKey(data, Key.down)) {
						if (emoji.length > 0) {
							cursorIndex = Math.min(emoji.length - 1, cursorIndex + cols);
						}
						refresh();
						return;
					}

					if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
						const dir = matchesKey(data, "shift+tab") ? -1 : 1;
						categoryIndex =
							(categoryIndex + dir + ALL_CATEGORIES.length) % ALL_CATEGORIES.length;
						cursorIndex = 0;
						refresh();
						return;
					}

					if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
						if (emoji.length > 0 && cursorIndex < emoji.length) {
							const selected = emoji[cursorIndex];
							// Copy to clipboard
							copyToClipboard(selected).then((result) => {
								if (result.ok) {
									ctx.ui.notify(
										`Copied ${selected} to clipboard`,
										"info",
									);
								} else {
									ctx.ui.notify(
										`Copied ${selected} (clipboard failed: ${result.error})`,
										"info",
									);
								}
							});
							// Also paste into editor
							ctx.ui.pasteToEditor(selected);
						}
						return;
					}

					if (matchesKey(data, Key.escape)) {
						done();
						return;
					}

					// Handle number keys for quick category jump
					const num = Number.parseInt(data, 10);
					if (
						!Number.isNaN(num) &&
						num >= 1 &&
						num <= ALL_CATEGORIES.length
					) {
						categoryIndex = num - 1;
						cursorIndex = 0;
						refresh();
						return;
					}

					// First-letter jump: type a letter to jump to matching category
					const letter = data.toLowerCase();
					if (/^[a-z]$/.test(letter)) {
						const startIdx = (categoryIndex + 1) % ALL_CATEGORIES.length;
						for (let i = 0; i < ALL_CATEGORIES.length; i++) {
							const idx = (startIdx + i) % ALL_CATEGORIES.length;
							const name = ALL_CATEGORIES[idx].name;
							if (name.toLowerCase().startsWith(letter)) {
								categoryIndex = idx;
								cursorIndex = 0;
								refresh();
								return;
							}
						}
					}
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});
		},
	});
}
