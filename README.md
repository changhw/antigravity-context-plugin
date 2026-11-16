# Antigravity Context Plugin (`/context` for Antigravity Desktop)

Brings the interactive **`/context`** Context Usage panel from the Antigravity CLI (`agy`) directly into the **Google Antigravity Desktop App** (tested on Linux `v2.32.0+`, compatible with macOS & Linux) — both as a **live Auxiliary Side Pane UI extension** and as an on-demand **`/context` chat slash command**.

```text
Context Usage · Gemini 4 Carbon (High)
227.9k / 1.0M tokens (21.7%) · Free: 820.7k (78.3%) · Cache hit: 98.4%
──────────────────────────────────────────────────────────────────────────────
  ⛁ ⛁ ⛁ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉   ◉ User messages             173  (  0.0%)
  ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉ ◉   ◉ Agent responses         22.5k  (  2.1%)
  ◉ ◉ ◉ ◉ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □   ◉ Tool calls             191.1k  ( 18.2%)
  □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □   ⛁ System prompt           5,969  (  0.6%)
  □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □   ⛁ System tools            3,850  (  0.4%)
  □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □   ⛁ Customizations          2,678  (  0.3%)
  □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □   ⛁ MCP tools                   0  (  0.0%)
  □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □   ⛁ System overhead         1,720  (  0.2%)
  □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □   □ Free space             820.7k  ( 78.3%)
  □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □ □   ⊠ Checkpoint buffer           0  (0 ckpt)
```

---

## Features

- **Live Auxiliary Side Pane (`Context`)**: Runs as a zero-dependency `sidecar_sdk` UI extension (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) alongside your active chat, automatically syncing light/dark host themes via `preload.js` and updating live as turns complete.
- **`/context` Slash Command**: Type `/context` directly in any Antigravity Desktop chat canvas to render an inline token grid & file breakdown plus a one-click pill to toggle the live side pane.
- **Proportional 20×10 Context Grid & CLI Markers**:
  - `◉` **Conversation & Tools**: User messages, Agent responses (visible replies + reasoning/thinking split), and Tool calls/outputs.
  - `⛁` **System, Customizations & MCP**: System prompt, built-in System tools, active Customizations (Rules, progressive-disclosure Skill frontmatter catalog, Plugins, Subagents), connected MCP server schemas, and System overhead.
  - `□` **Free Space**: Remaining token capacity before hitting the active model's context ceiling.
  - `⊠` **Checkpoint Buffer**: Tracks `<CONTEXT_SUMMARY>` compaction checkpoints and condensed historical turns separately so pre-compaction history never inflates active usage percentages.
- **Exact Gemini API Token Calibration**: Reconciles step and file token weights directly against per-turn `input_tokens`, `cache_read_tokens`, and `output_tokens` recorded in `transcript_full.jsonl`, surfacing real-time **prompt cache hit rates** and turn-by-turn growth charts.
- **Tracked Files Explorer**: Lists loaded **Knowledge files**, **Artifact files**, **Skill files** (`SKILL.md` & reference docs read into context), **Workspace files**, and auto-detected **System & Rule files** (`~/.gemini/GEMINI.md`, `~/.gemini/config/rules/*.md`, `AGENTS.md`, `.agents/rules/*.md`, `mcp_config.json`) — click any file to open it directly in Antigravity's file viewer pane.
- **`agy` CLI Keyboard Navigation**: Supports `↑`/`↓` (`k`/`j`), `PgUp`/`PgDn`, `Ctrl+U`/`Ctrl+D`, `g`/`Shift+G`, `1`–`4` tab switching, and `?` shortcut help.

---

## Installation

### Option 1: Direct Clone into Antigravity Global Plugins (Recommended for Desktop App)

```bash
mkdir -p ~/.gemini/config/plugins
git clone https://github.com/changhw/antigravity-context-plugin.git \
  ~/.gemini/config/plugins/antigravity-context-plugin
```

### Option 2: Clone Anywhere & Run Installer

```bash
git clone https://github.com/changhw/antigravity-context-plugin.git
cd antigravity-context-plugin
./install.sh
```

### Option 3: Antigravity CLI (`agy`)

```bash
git clone https://github.com/changhw/antigravity-context-plugin.git
agy plugin install ./antigravity-context-plugin
```

> **Note:** Discovered plugins are enabled automatically in Antigravity Desktop (`v2.32.0+`). You can toggle or inspect the plugin anytime under **Skills & Customizations → Plugins** (`customization://antigravity-context-plugin`).

---

## Usage in Antigravity Desktop

1. **Open the Live Side Pane**:
   - Click the **`+`** button in the conversation auxiliary pane header and select **Context**, **or**
   - Click a `[Context](sidecar://antigravity-context-plugin/context_panel/)` pill in chat.
2. **Run `/context` in Chat**:
   - Type **`/context`** in the chat input box and press **Enter** to get an immediate CLI-formatted breakdown and a one-click side-pane pill.
3. **Standalone CLI / Terminal Inspection**:
   ```bash
   node ~/.gemini/config/plugins/antigravity-context-plugin/skills/context/scripts/context_cli.mjs
   ```

### Keyboard Shortcuts (Inside the Context Panel)

| Key / Shortcut | Action |
| :--- | :--- |
| `↑` / `↓` (or `k` / `j`) | Scroll up or down by one line |
| `PgUp` / `PgDn` | Scroll up or down by one page |
| `Ctrl + U` / `Ctrl + D` | Scroll up or down by half a page |
| `g` / `Shift + G` | Jump to the top or bottom of the panel |
| `1` – `4` (or `←` / `→` on tabs) | Switch between Overview, Tracked Files, Turns & Tools, and CLI / JSON |
| `?` / `Esc` | Toggle / close shortcut help or clear pinned category filter |

---

## Repository Layout

```text
antigravity-context-plugin/
├── plugin.json                        # Antigravity plugin manifest
├── hooks.json                         # Non-blocking SessionStart/PreInvocation metadata hook
├── install.sh                         # Local installer / uninstaller
├── assets/
│   └── logo.svg                       # Plugin icon
├── hooks/
│   └── record_session.mjs             # Records active modelName & workspacePaths to PLUGIN_DATA
├── sidecars/
│   └── context_panel/
│       ├── sidecar.json               # Aux Pane UI extension config (SIDECAR_UI_ENTRYPOINT_AUX_PANE)
│       ├── package.json               # ESM configuration
│       ├── main.mjs                   # SidecarApp server + standalone HTTP preview mode
│       ├── analyzer.mjs               # Gemini-calibrated token, checkpoint & tracked-file engine
│       ├── index.html                 # Host-theme-synced Aux Pane markup
│       ├── styles.css                 # Light/dark adaptive styles
│       └── app.js                     # Live polling UI & CLI keyboard navigation
├── skills/
│   └── context/
│       ├── SKILL.md                   # /context slash command workflow
│       └── scripts/
│           └── context_cli.mjs        # Terminal / JSON context reporter
└── test/
    └── analyzer.test.mjs              # Zero-dependency automated test suite (node --test)
```

---

## Development & Testing

Run the automated test suite (requires Node.js 18+; zero npm packages needed):

```bash
node --test test/analyzer.test.mjs
```

Preview the UI standalone in any browser:

```bash
node sidecars/context_panel/main.mjs --standalone --port 8787
```

---

## License

[MIT](./LICENSE)
