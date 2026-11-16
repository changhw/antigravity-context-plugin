# `context_panel` — Antigravity Desktop `/context` Sidecar

Live Auxiliary Side Pane UI extension powering the **Context** view in
`antigravity-context-plugin`.

## Architecture

- **`sidecar.json`**: Registers `main.mjs` with `has_web_ui: true` and
  `SIDECAR_UI_ENTRYPOINT_AUX_PANE` so the panel mounts directly inside the
  Antigravity Desktop auxiliary side pane (`+` menu in conversation header or
  `sidecar://antigravity-context-plugin/context_panel/`).
- **`analyzer.mjs`**: Pure read-only context analyzer shared between the live
  sidecar panel and the `/context` slash command CLI reporter. Calibrates step
  and file token estimates directly against the exact `input_tokens`,
  `cache_read_tokens`, and `output_tokens` recorded in `transcript_full.jsonl`
  (falling back to `transcript.jsonl`).
- **`main.mjs`**: Serves `index.html`, static assets, `/api/context`, and
  `/api/conversations` via `sidecar_sdk` (`SidecarApp`), with a built-in
  `--standalone` HTTP mode for local development and automated tests.

## Local Standalone Preview

```bash
node sidecars/context_panel/main.mjs --standalone --port 8787
```

Then open `http://127.0.0.1:8787/` in any browser.
