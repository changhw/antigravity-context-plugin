#!/usr/bin/env bash
# Install or update antigravity-context-plugin for Google Antigravity Desktop.
# Copies the plugin bundle into ~/.gemini/config/plugins/antigravity-context-plugin
# without modifying ~/.gemini/config/config.json.

set -euo pipefail

PLUGIN_NAME="antigravity-context-plugin"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_ROOT="${ANTIGRAVITY_PLUGINS_DIR:-${HOME}/.gemini/config/plugins}"
DEST_DIR="${PLUGINS_ROOT}/${PLUGIN_NAME}"

if [[ "${1:-}" == "--uninstall" ]]; then
  if [[ -d "${DEST_DIR}" || -L "${DEST_DIR}" ]]; then
    rm -rf "${DEST_DIR}"
    echo "Removed ${DEST_DIR}"
  else
    echo "Plugin is not installed at ${DEST_DIR}"
  fi
  exit 0
fi

mkdir -p "${PLUGINS_ROOT}"
STAGE_DIR="$(mktemp -d "${PLUGINS_ROOT}/.${PLUGIN_NAME}.stage.XXXXXX")"
trap 'rm -rf "${STAGE_DIR}"' EXIT

cp -R "${SRC_DIR}/plugin.json" \
      "${SRC_DIR}/hooks.json" \
      "${SRC_DIR}/README.md" \
      "${SRC_DIR}/LICENSE" \
      "${SRC_DIR}/assets" \
      "${SRC_DIR}/hooks" \
      "${SRC_DIR}/sidecars" \
      "${SRC_DIR}/skills" \
      "${STAGE_DIR}/"

chmod +x "${STAGE_DIR}/hooks/record_session.mjs" \
         "${STAGE_DIR}/skills/context/scripts/context_cli.mjs"

rm -rf "${DEST_DIR}"
mv "${STAGE_DIR}" "${DEST_DIR}"
trap - EXIT

echo "Installed ${PLUGIN_NAME} -> ${DEST_DIR}"
echo ""
echo "Usage in Antigravity Desktop:"
echo "  1. Side Pane: click '+' in the conversation header -> 'Context'"
echo "     (or open sidecar://${PLUGIN_NAME}/context_panel/)"
echo "  2. Slash Command: type '/context' in any conversation"
echo "  3. Manage in UI: customization://${PLUGIN_NAME}"
