# Plan: Apply recommended pi@0.84.2 compatibility patches to pi-peacock

## Goal
Make pi-peacock 0.2.2 fully compatible and effective with pi-coding-agent@0.84.2, especially auto-theme selection, without breaking `/peacock` CLI. Verify by static checks + `pi -e` smoke.

## Non-Goals
- New features beyond audit fixes
- Visual redesign of TUI panel
- Changing public command names (`/peacock`, subcommands)
- Migrating storage to new SessionRepo (keep CustomEntry + disk fallback)

## Facts (path:line)

- `extensions/repo-peacock.ts:1819` `export default function(pi:ExtensionAPI)` — factory closes over `runtimeOverrides`, `toolStripeSettings`, `lastSignature`, `pendingThemeApply`, animation state
- `extensions/repo-peacock.ts:430-445` `hashString`, `pickAutoTheme(repoName)` — hash(repoName) % 12, collision on same basename
- `extensions/repo-peacock.ts:520-544` `isAutoAssignThemeEnabled`, `resolveTheme` — requires `auto && overrides.theme`, precedence confusing, fallbackTheme applied even when auto off
- `extensions/repo-peacock.ts:50-60` `OVERRIDES_DIR = path.join(os.homedir(),".pi","agent")`, `THEMES_DIR = path.resolve(EXTENSION_DIR,"..","themes")`, `getOverridesFile(repoName)` — hardcodes homedir, per-repoName file
- `extensions/repo-peacock.ts:580-610` `resolveThemeJsonColors`, `splitFgAndBgColors`, `loadBundledTheme` — bg split missing `scrollbarThumb`,`searchMatchBg`; var resolver lenient vs pi throw
- `extensions/repo-peacock.ts:212-230` `createBuiltInTools`, `registerStripedBuiltInTools` — always registers 6 built-ins, ignores `defaultTools` / active tools
- `extensions/repo-peacock.ts:557-565` `getAvailableThemeNames` — merges AUTO_THEMES + `ctx.ui.getAllThemes()`, sorts peacock first
- `extensions/repo-peacock.ts:1920-2000` `resources_discover` + `session_start` pendingThemeApply dance — redundant since package `themes` now discovered via `DefaultResourceLoader` before session_start
- `themes/peacock-*.json` (12 files, e.g. `peacock-blue.json:1-72`) — defines `vars`+`colors`, missing optional `scrollbarThumb`,`searchMatchBg`,`searchMatchText`,`thinkingMax` fallback (added in pi 0.84.2 fullscreen search)
- `package.json:20-27` `pi: { extensions: ["./extensions"], themes: ["./themes"] }` — dir entry ambiguous per docs, should be explicit file; peerDeps `"*"`
- `extensions/repo-peacock.ts:1907-1914` `InteractiveMode setTheme` — `setTheme(string)` persists to settings.json, `setTheme(Theme)` in-memory `<in-memory>`; extension correctly uses in-memory for bundled but string for fallbackTheme

## Risks
- Changing hash/input for auto-theme changes existing users' assigned colors (acceptable, document as intentional per audit)
- Changing override file key from repoName to gitRoot hash migrates storage; need migration or fallback read of old file
- `defaultTools` respect may hide stripe when user disabled tool — intentional tradeoff, document
- Theme JSON token addition must preserve validation via `ThemeJsonSchema`

## Validation Contract

**Worker must return:** changed files, done/undone checklist, commands+exit codes, evidence (build output, `pi -e` smoke), surprises, decisions needing approval

**Expected behavior after patches:**
- `overrides.theme` applies regardless of `autoAssignTheme` (manual pick works without auto)
- `autoAssignTheme=on` deterministically picks `hash(gitRoot||cwd)` % 12; two different paths with same basename get different themes and different override files
- `OVERRIDES_DIR` respects `PI_AGENT_DIR` env or `~/.pi/agent` fallback
- `loadBundledTheme` correctly splits `scrollbarThumb`/`searchMatchBg` as bg, var resolver throws or handles as pi does, no misclassified colors
- All 12 `themes/peacock-*.json` contain `scrollbarThumb`,`searchMatchBg`,`searchMatchText` (and `thinkingMax` fallback ok) and pass `ThemeJsonSchema`
- Stripe wrapper respects active tools (does not force-register disabled built-ins) — or if still registering, documents why
- `package.json` `pi.extensions` explicit `["./extensions/repo-peacock.ts"]`
- `resolveTheme` precedence: `overrides.theme` > `matchedRule.theme` > `auto ? pickAuto` > `fallbackTheme` > `undefined`

**Commands to run (from repo root):**
1. Static: `npx --yes tsc --noEmit --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext extensions/repo-peacock.ts` or project `npm run lint` if present (currently no scripts — verify file parses)
2. Smoke: `pi -e ./extensions/repo-peacock.ts --help` or `pi -e ./extensions/repo-peacock.ts --version` and check no “Theme not found” error on startup with bundled theme active
3. Manual flow: `pi -e ./extensions/repo-peacock.ts` then `/peacock` → toggle autoAssign, pick theme, verify theme persists per-repo and stripe toggles
4. Check themes load: `pi --list-themes` or getAllThemes via extension includes 12 peacock themes

**Evidence:** command outputs, file reads, screenshot/description of TUI panel

## Seam Contracts (parallel work boundaries)

Single writer `extensions/repo-peacock.ts` + 12 theme files + `package.json` + `README.md` if docs changed.

No parallel writers on same tree. If splitting, isolate:
- Theme JSON edits (12 files) — independent, can batch
- Extension TS edits — single owner
- Package/docs — single owner

Composition point: extension reads `themes/*.json` at runtime; theme token changes must be consistent with `loadBundledTheme` bg split fix.

Assumptions:
- `getColorMode()` from current theme is sufficient (or switch to `getCapabilities().trueColor`)
- Override file migration: read old `repoName` file if new hashed file missing, then write to new
- Keep `fallbackTheme` string path via `ctx.ui.setTheme(name)` (persists) — document as intentional vs in-memory

## Tasks (ordered, small)

1. Fix `hashString`/`pickAutoTheme` to use gitRoot/cwd, update `getOverridesFile` to use hashed gitRoot+repoName and respect `PI_AGENT_DIR`/`getAgentDir` pattern, add migration fallback
2. Fix `resolveTheme` precedence (decouple manual override) and `isAutoAssignThemeEnabled` usage; update `formatThemeListPreview` if needed
3. Fix `splitFgAndBgColors` to include `scrollbarThumb`,`searchMatchBg`; align `resolveVarRefs` to pi's throwing vs lenient (either import or replicate pi logic)
4. Update all 12 `themes/peacock-*.json` to include `scrollbarThumb`,`searchMatchBg`,`searchMatchText` (values referencing vars, e.g. `selectedBg`/`text`)
5. Update `registerStripedBuiltInTools` to respect active tools or check `ctx`/`pi.getAllTools` before registering; or keep but gate behind `getActiveTools`
6. Update `package.json` `pi.extensions` to `["./extensions/repo-peacock.ts"]`, keep `themes` as `["./themes"]` (or explicit list), bump peerDeps lower bound if needed
7. Clarify `fallbackTheme` docs in `README.md` if behavior changed
8. Run validation contract, capture evidence

## Open Questions (Decide gate auto-decided)

- Internal hash: use `hashString((gitRoot||cwd)+":"+repoName)` — decide: full gitRoot hash
- Override dir: `process.env.PI_AGENT_DIR ?? path.join(os.homedir(),".pi","agent")` — decide yes
- Keep `pendingThemeApply` dance but simplify comment — decide keep fallback for `pi -e` case
- Keep TUI panel using raw Component — decide no refactor to SettingsList
