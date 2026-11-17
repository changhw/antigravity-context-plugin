---
name: context
description: >-
  Displays the current conversation's token consumption grid, category breakdown,
  live/per-turn TTFT (time to first token) & streaming speed, prompt cache telemetry,
  compaction checkpoints, and tracked files — mirroring `/context` from the
  Antigravity CLI (`agy`) — and provides a one-click pill to open the live Context
  Usage panel in the auxiliary side pane. Activate when the user runs `/context`
  or asks to inspect context window usage, TTFT latency, token breakdown, or loaded
  context files.
---

# Context Usage (`/context`)

Use this skill when the user invokes `/context` or asks how their current
conversation's context window is being used.

## Steps

1.  **Run the bundled `/context` analyzer** against the current conversation ID
    and active workspace(s) (pass your `<user_information>` `Conversation ID`
    and `Active Workspaces` paths):

    ```bash
    node "<skill_dir>/scripts/context_cli.mjs" --conversation "<conversation-id>" --workspace "<workspace-path>"
    ```

    *(On Windows PowerShell `pwsh`, prefix with `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;` so Unicode grid symbols render cleanly.)*

    Replace `<skill_dir>` with the directory containing this `SKILL.md` file.

2.  **Present the `/context` report concisely in chat**:
    -   Show the formatted `/context` visual cell grid (`◉` conversation/tools,
        `⛁` system/customizations/MCP, `□` free capacity, `⊠` checkpoint buffer)
        and category token breakdown inside a fenced `text` block so columns and
        cells align cleanly.
    -   Briefly summarize any notable takeaways (e.g., prompt cache hit rate,
        largest token consumers among tool calls or tracked files, or whether
        `/compact` is recommended if active usage exceeds 70%).

3.  **Offer the live Auxiliary Side Pane pill** (when this plugin's sidecar is
    installed and enabled):
    -   Include a one-click link to open/toggle the live **Context** UI panel in
        the side pane:
        `[Context](sidecar://antigravity-context-plugin/context_panel/)`
    -   Note that `sidecar://<plugin-dir>/context_panel/` uses the plugin's
        install directory name (`antigravity-context-plugin` by default).
