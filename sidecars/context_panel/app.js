/*
 * Antigravity Context Usage (/context) frontend.
 *
 * Polls /api/context with ETag caching, syncs host light/dark theme tokens
 * from preload.js, renders the proportional 20x10 context cell grid, category
 * breakdown, checkpoints, tracked files, and turn-by-turn cache telemetry, and
 * supports agy CLI /context keyboard navigation (j/k, PgUp/PgDn, Ctrl+U/D, g/G).
 */
(() => {
  const POLL_MS = 1500;
  const ACTIVE_POLL_MS = 500;
  const IDLE_POLL_MS = 3000;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  const state = {
    view: 'loading', // loading | panel | empty
    tab: params.get('tab') || 'overview',
    selectedConv: params.get('conversationId') || '',
    limitOverride: Number(params.get('limit')) || 0,
    etag: '',
    report: null,
    reportReceivedAtMs: 0,
    conversations: [],
    workspaces: [],
    hoveredCategory: null,
    pinnedCategory: null,
    fileFilterKind: 'all',
    rawMode: 'cli',
    lastOk: 0,
  };

  // ---------- Host theme sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f8fa)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const theme = lum < 0.5 ? 'dark' : 'light';
    if (document.documentElement.dataset.theme !== theme) {
      document.documentElement.dataset.theme = theme;
    }
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });

  // ---------- Helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v === 1_048_576) return '1.0M';
    if (v === 2_097_152) return '2.0M';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toLocaleString('en-US');
  }

  function fmtExact(n) {
    return (Number(n) || 0).toLocaleString('en-US');
  }

  function fmtMs(ms, decimals = 2) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(decimals)}s`;
  }

  function ttftToneClass(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    if (ms <= 2500) return 'fast';
    if (ms <= 6000) return 'warn';
    return 'slow';
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard fallback inside sandboxed iframe
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }

  async function getJson(path) {
    const fetcher = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await fetcher(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  async function refreshWorkspaces() {
    try {
      if (typeof window.sidecar?.getWorkspaceUris === 'function') {
        const uris = await window.sidecar.getWorkspaceUris();
        if (Array.isArray(uris)) state.workspaces = uris.filter(Boolean);
      }
    } catch {
      // Ignore outside host iframe
    }
  }

  function activeHostConv() {
    return state.selectedConv || window.sidecar?.conversationId || '';
  }

  function openFileOrCopy(uri, filePath) {
    if (uri && window.sidecar?.ui?.toggleAuxPane) {
      window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
      return;
    }
    if (filePath) {
      copyText(filePath).then((ok) => {
        toast(ok ? `Copied path: ${filePath}` : filePath);
      });
    }
  }

  // ---------- View & Tab switching ----------
  function showView(v) {
    if (state.view === v) return;
    state.view = v;
    $('loading').classList.toggle('hidden', v !== 'loading');
    $('panel').classList.toggle('hidden', v !== 'panel');
    $('empty').classList.toggle('hidden', v !== 'empty');
  }

  const TABS = ['overview', 'files', 'turns', 'raw'];
  function selectTab(tab, focus = false) {
    if (!TABS.includes(tab)) tab = 'overview';
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
      btn.tabIndex = active ? 0 : -1;
      if (active && focus) btn.focus();
    });
    document.querySelectorAll('.tab-body').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `tab-${tab}`);
    });
    if (state.report) {
      if (tab === 'turns') renderTurnsAndTools();
      if (tab === 'files') renderFilesExplorer();
      if (tab === 'raw') renderRaw();
    }
  }

  // ---------- Rendering ----------
  function activeHighlightId() {
    return state.hoveredCategory || state.pinnedCategory || null;
  }

  function applyHighlightVisuals() {
    const hi = activeHighlightId();
    const grid = $('cell-grid');
    const bar = $('stacked-bar');
    grid.classList.toggle('dimmed', Boolean(hi));
    bar.classList.toggle('dimmed', Boolean(hi));

    grid.querySelectorAll('.cell').forEach((c) => {
      c.classList.toggle('hi', Boolean(hi && c.dataset.cat === hi));
    });
    bar.querySelectorAll('.stacked-seg').forEach((s) => {
      s.classList.toggle('active', Boolean(hi && s.dataset.cat === hi));
    });
    $('breakdown-rows').querySelectorAll('.b-row').forEach((r) => {
      r.classList.toggle('selected', Boolean(state.pinnedCategory && r.dataset.cat === state.pinnedCategory));
    });
    $('clear-highlight').classList.toggle('hidden', !state.pinnedCategory);

    if (hi && state.report) {
      const allRows = [...state.report.breakdown, state.report.freeSpace, state.report.checkpoints.row];
      const match = allRows.find((r) => r.id === hi);
      if (match) {
        const pct = typeof match.percent === 'number' ? ` (${match.percent.toFixed(1)}%)` : '';
        $('grid-inspector').textContent = `${match.symbol} ${match.label} · ${fmtExact(match.tokens)} tok${pct}`;
        return;
      }
    }
    $('grid-inspector').textContent = 'Hover or click a cell or category row to inspect';
  }

  function renderHeader() {
    const r = state.report;
    const { summary, model } = r;
    const title = r.title || `Conversation ${r.conversationId.slice(0, 8)}`;
    $('conv-title').textContent = title;
    $('conv-title').title = `${title}\nID: ${r.conversationId}\n${r.transcriptPath || ''}`;

    $('model-badge').textContent = model.name;
    $('model-badge').title = `Active model: ${model.name} · Window: ${fmtExact(model.contextLimit)} tokens`;

    $('kpi-used').textContent = fmtTok(summary.totalActiveTokens);
    $('kpi-used').title = `${fmtExact(summary.totalActiveTokens)} active tokens`;
    $('kpi-limit').textContent = fmtTok(summary.contextLimit);
    $('kpi-limit').title = `${fmtExact(summary.contextLimit)} token limit`;
    $('kpi-pct').textContent = `(${summary.usagePercent.toFixed(1)}%)`;

    const cacheBadge = $('kpi-cache');
    if (summary.modelTurns > 0 && summary.cacheHitPercent > 0) {
      cacheBadge.textContent = `⚡ ${summary.cacheHitPercent.toFixed(1)}% cached`;
      cacheBadge.classList.remove('hidden');
    } else {
      cacheBadge.classList.add('hidden');
    }

    renderLiveTtftIndicators();

    // Stacked proportional bar
    const segs = r.breakdown
      .filter((b) => b.tokens > 0)
      .map((b) => {
        const w = Math.max(0.4, b.percent);
        return `<span class="stacked-seg bg-${esc(b.colorKey)}" data-cat="${esc(b.id)}" style="width:${w.toFixed(2)}%" title="${esc(`${b.label}: ${fmtExact(b.tokens)} tok (${b.percent.toFixed(1)}%)`)}"></span>`;
      })
      .join('');
    $('stacked-bar').innerHTML = segs;

    // Tab counts
    const tf = r.trackedFiles;
    const totalFiles =
      tf.knowledge.length + tf.artifacts.length + tf.skills.length + tf.workspace.length + tf.system.length;
    $('tab-count-files').textContent = totalFiles ? String(totalFiles) : '';
    $('tab-count-turns').textContent = summary.modelTurns ? String(summary.modelTurns) : '';

    // High context usage hint banner
    const banner = $('compact-banner');
    if (summary.usagePercent >= 80) {
      banner.className = 'alert-banner high';
      banner.innerHTML = `Context window is <strong>${summary.usagePercent.toFixed(1)}%</strong> full (${fmtTok(summary.freeSpaceTokens)} free). Run <code>/compact</code> in chat to condense older turns into a checkpoint.`;
    } else if (summary.usagePercent >= 65) {
      banner.className = 'alert-banner';
      banner.innerHTML = `Context usage is <strong>${summary.usagePercent.toFixed(1)}%</strong>. Consider <code>/compact</code> before starting large multi-file reads.`;
    } else {
      banner.className = 'alert-banner hidden';
      banner.textContent = '';
    }
  }

  function renderConversationsDropdown() {
    const sel = $('conv-select');
    const hostConv = window.sidecar?.conversationId || '';
    const opts = [];
    opts.push(
      `<option value="">${hostConv ? 'Current pane conversation' : 'Most recent conversation'}</option>`
    );
    for (const c of state.conversations) {
      const short = c.conversationId.slice(0, 8);
      const label = c.title ? `${c.title} (${short})` : `${short} · ${fmtTok(c.latestTokens)} tok`;
      opts.push(`<option value="${esc(c.conversationId)}">${esc(label)}</option>`);
    }
    const html = opts.join('');
    if (sel.innerHTML !== html) sel.innerHTML = html;
    sel.value = state.selectedConv;
  }

  function renderOverview() {
    const r = state.report;
    const { grid, breakdown, freeSpace, checkpoints, summary, trackedFiles } = r;

    $('grid-scale-label').textContent = `${grid.cols}×${grid.rows} · ~${fmtTok(grid.tokensPerCell)}/cell`;

    // 20x10 proportional cell grid
    $('cell-grid').innerHTML = grid.cells
      .map(
        (cell, idx) =>
          `<span class="cell c-${esc(cell.colorKey)}" role="gridcell" data-cat="${esc(cell.id)}" data-idx="${idx}" title="${esc(`${cell.symbol} ${cell.label}: ${fmtExact(cell.tokens)} tok (${cell.percent.toFixed(1)}%)`)}">${esc(cell.symbol)}</span>`
      )
      .join('');

    // Breakdown rows
    const rowHtml = (row, showPct = true, extraSub = '') => {
      const rightCol = showPct
        ? `${row.percent.toFixed(1)}%`
        : `${checkpoints.count} ckpt`;
      const isSelected = state.pinnedCategory === row.id;
      return `<div class="b-row ${isSelected ? 'selected' : ''}" data-cat="${esc(row.id)}" title="${esc(row.description || '')}">
        <span class="b-sym c-${esc(row.colorKey)}">${esc(row.symbol)}</span>
        <span class="b-label">${esc(row.label)}</span>
        <span class="b-tok">${esc(fmtTok(row.tokens))}</span>
        <span class="b-pct">${esc(rightCol)}</span>
        ${extraSub ? `<div class="b-sub">${extraSub}</div>` : ''}
      </div>`;
    };

    const topToolsHint =
      state.pinnedCategory === 'tool_calls' && r.tools.length
        ? esc(
            'Top: ' +
              r.tools
                .slice(0, 3)
                .map((t) => `${t.name} (${fmtTok(t.totalTokens)})`)
                .join(' · ')
          )
        : '';

    const customHint =
      state.pinnedCategory === 'customizations'
        ? esc(
            `Rules ${fmtTok(r.customizations.rulesTokens)} · Skills catalog ${fmtTok(r.customizations.skillCatalogTokens)} (${r.trackedFiles.catalogSkills.length} skills)`
          )
        : '';

    $('breakdown-rows').innerHTML =
      breakdown
        .map((b) =>
          rowHtml(
            b,
            true,
            b.id === 'tool_calls' ? topToolsHint : b.id === 'customizations' ? customHint : ''
          )
        )
        .join('') +
      `<div class="b-divider"></div>` +
      rowHtml(freeSpace, true) +
      rowHtml(checkpoints.row, false);

    // Checkpoints & Cache Telemetry card
    $('turns-summary-badge').textContent = `${summary.modelTurns} model turn${summary.modelTurns === 1 ? '' : 's'} · ${summary.totalSteps} steps`;

    const ckptStatus = checkpoints.count
      ? `<div class="ckpt-status-row"><span class="c-checkpoint">⊠</span><div><strong>Active checkpoint at step #${checkpoints.activeCheckpoint.stepIndex}</strong> · ${checkpoints.count} historical checkpoint${checkpoints.count === 1 ? '' : 's'} compacted (${checkpoints.compactedStepCount} earlier steps, ~${fmtTok(checkpoints.historicalCompactedTokens)} tokens held outside active window).</div></div>`
      : `<div class="ckpt-status-row"><span class="c-checkpoint">⊠</span><div><strong>No compaction checkpoints yet</strong> — all ${summary.totalSteps} conversation steps are live in context. Type <code>/compact</code> in chat anytime to summarize older turns.</div></div>`;

    const cacheTotal = summary.latestCacheReadTokens + summary.latestUncachedInputTokens;
    const cacheMeter =
      cacheTotal > 0
        ? `<div class="cache-meter">
            <div class="cache-meter-top">
              <span>Latest turn prompt cache: <strong>${fmtTok(summary.latestCacheReadTokens)}</strong> cached + <strong>${fmtTok(summary.latestUncachedInputTokens)}</strong> fresh</span>
              <span><strong>${summary.cacheHitPercent.toFixed(1)}%</strong> hit · Σ out ${fmtTok(summary.cumulativeOutputTokens)}</span>
            </div>
            <div class="cache-bar"><div class="cache-bar-fill" style="width:${Math.min(100, summary.cacheHitPercent).toFixed(1)}%"></div></div>
          </div>`
        : '';

    const ttftStats = r.ttft?.stats || {};
    const speedVal = r.ttft?.latestOutputTokPerSec
      ? `${r.ttft.latestOutputTokPerSec} tok/s`
      : r.ttft?.avgOutputTokPerSec
        ? `${r.ttft.avgOutputTokPerSec} tok/s`
        : '—';
    const prefillSub = r.ttft?.latestPrefillTokPerSec
      ? `prefill ${fmtTok(r.ttft.latestPrefillTokPerSec)}/s`
      : ttftStats.count
        ? `${ttftStats.count} turn${ttftStats.count === 1 ? '' : 's'} measured`
        : 'live on active turns';

    const ttftGrid = `<div class="ttft-metrics-grid" data-testid="ctx-ttft-grid">
      <div class="ttft-tile">
        <span id="ttft-tile-primary-label" class="ttft-tile-label">Live / Latest TTFT</span>
        <span id="ttft-tile-primary-val" class="ttft-tile-val">—</span>
        <span id="ttft-tile-primary-sub" class="ttft-tile-sub">${esc(prefillSub)}</span>
      </div>
      <div class="ttft-tile">
        <span class="ttft-tile-label">Median (P50)</span>
        <span class="ttft-tile-val">${esc(fmtMs(ttftStats.p50Ms))}</span>
        <span class="ttft-tile-sub">${ttftStats.minMs != null ? esc(`min ${fmtMs(ttftStats.minMs)}`) : '—'}</span>
      </div>
      <div class="ttft-tile">
        <span class="ttft-tile-label">P95 TTFT</span>
        <span class="ttft-tile-val">${esc(fmtMs(ttftStats.p95Ms))}</span>
        <span class="ttft-tile-sub">${ttftStats.maxMs != null ? esc(`max ${fmtMs(ttftStats.maxMs)}`) : '—'}</span>
      </div>
      <div class="ttft-tile">
        <span class="ttft-tile-label">Stream Speed</span>
        <span class="ttft-tile-val">${esc(speedVal)}</span>
        <span class="ttft-tile-sub">${r.ttft?.latestStreamingMs != null ? esc(`stream ${fmtMs(r.ttft.latestStreamingMs, 1)}`) : 'output rate'}</span>
      </div>
    </div>`;

    $('checkpoints-body').innerHTML = ttftGrid + ckptStatus + cacheMeter;
    renderLiveTtftIndicators();

    // Overview Tracked Files sections (matching agy CLI /context)
    const groups = [
      ['Knowledge files', trackedFiles.knowledge, false],
      ['Artifact files', trackedFiles.artifacts, false],
      ['Skill files (loaded)', trackedFiles.skills, false],
      ['Workspace files (in context)', trackedFiles.workspace, false],
      ['System & Rule files', trackedFiles.system, true],
    ];

    $('overview-files').innerHTML = groups
      .map(([heading, items, showFullPath]) => {
        const head = `<div class="file-group-head"><span>${esc(heading)}</span><span>${items.length}</span></div>`;
        if (!items.length) {
          return `<div>${head}<div class="file-empty-inline">(none)</div></div>`;
        }
        const rows = items
          .slice(0, 8)
          .map((f) => renderFileRow(f, showFullPath))
          .join('');
        const more =
          items.length > 8
            ? `<div class="file-empty-inline">… and ${items.length - 8} more (see Tracked Files tab)</div>`
            : '';
        return `<div>${head}<div class="file-rows">${rows}</div>${more}</div>`;
      })
      .join('');

    applyHighlightVisuals();
  }

  function renderFileRow(f, showFullPath = false) {
    const label = showFullPath ? f.path : f.name || f.path;
    const badgeParts = [];
    if (f.reads) badgeParts.push(`${f.reads}r`);
    if (f.writes) badgeParts.push(`${f.writes}w`);
    if (f.kind) badgeParts.push(f.kind);
    const badge = badgeParts.length ? `<span class="file-badge">${esc(badgeParts.join(' · '))}</span>` : '';
    const clickable = Boolean(f.uri || f.path);
    return `<div class="file-row ${clickable ? 'clickable' : ''}" data-uri="${esc(f.uri || '')}" data-path="${esc(f.path || '')}" title="${esc(`${f.path}\nClick to open or copy path`)}">
      <span class="file-name">${esc(label)}</span>
      ${badge}
      <span class="file-tok">${esc(fmtTok(f.tokens))} tok</span>
    </div>`;
  }

  function renderFilesExplorer() {
    const r = state.report;
    if (!r) return;
    const tf = r.trackedFiles;
    const categories = [
      ['all', 'All active'],
      ['artifacts', `Artifacts (${tf.artifacts.length})`],
      ['skills', `Loaded Skills (${tf.skills.length})`],
      ['workspace', `Workspace (${tf.workspace.length})`],
      ['system', `System & Rules (${tf.system.length})`],
      ['knowledge', `Knowledge (${tf.knowledge.length})`],
      ['catalog', `Skill Catalog (${tf.catalogSkills.length})`],
    ];

    $('file-kind-chips').innerHTML = categories
      .map(
        ([id, label]) =>
          `<button type="button" class="filter-chip ${state.fileFilterKind === id ? 'on' : ''}" data-fkind="${esc(id)}">${esc(label)}</button>`
      )
      .join('');

    const q = ($('file-search').value || '').trim().toLowerCase();
    const sections = [];
    const want = (k) => state.fileFilterKind === 'all' || state.fileFilterKind === k;

    if (want('knowledge')) sections.push(['Knowledge files', tf.knowledge, false]);
    if (want('artifacts')) sections.push(['Artifact files', tf.artifacts, false]);
    if (want('skills')) sections.push(['Skill files loaded in context', tf.skills, false]);
    if (want('workspace')) sections.push(['Workspace & read files', tf.workspace, false]);
    if (want('system')) sections.push(['Auto-detected System & Rule files', tf.system, true]);
    if (state.fileFilterKind === 'catalog') {
      const mapped = tf.catalogSkills.map((s) => ({
        path: s.path,
        name: `${s.name} (${s.scope})`,
        tokens: s.catalogTokens,
        kind: `full: ${fmtTok(s.fullFileTokens)}`,
        uri: s.uri,
      }));
      sections.push(['Progressive-Disclosure Skill Catalog (frontmatter in system prompt)', mapped, false]);
    }

    const html = sections
      .map(([title, list, fullPath]) => {
        const filtered = q
          ? list.filter((f) => `${f.name || ''} ${f.path || ''}`.toLowerCase().includes(q))
          : list;
        if (!filtered.length && q) return '';
        return `<div class="card">
          <div class="card-head">
            <span class="card-title">${esc(title)}</span>
            <span class="muted-note">${filtered.length} file${filtered.length === 1 ? '' : 's'}</span>
          </div>
          ${
            filtered.length
              ? `<div class="file-rows">${filtered.map((f) => renderFileRow(f, fullPath)).join('')}</div>`
              : `<div class="file-empty-inline">No files in this category.</div>`
          }
        </div>`;
      })
      .filter(Boolean)
      .join('');

    $('files-list').innerHTML = html || `<div class="card"><div class="file-empty-inline">No tracked files match "${esc(q)}".</div></div>`;
  }

  function renderLiveTtftIndicators() {
    const r = state.report;
    const badge = $('kpi-ttft');
    if (!r || !badge) return;
    const ttft = r.ttft || {};
    const live = ttft.live || { phase: 'idle' };
    const stats = ttft.stats || {};
    const clientDeltaMs = state.reportReceivedAtMs > 0 ? Math.max(0, Date.now() - state.reportReceivedAtMs) : 0;

    const tileLabel = $('ttft-tile-primary-label');
    const tileVal = $('ttft-tile-primary-val');
    const tileSub = $('ttft-tile-primary-sub');

    if (live.phase === 'waiting_first_token') {
      const elapsed = (Number(live.elapsedMs) || 0) + clientDeltaMs;
      const text = fmtMs(elapsed, 1);
      badge.className = 'kpi-ttft-badge prefill';
      badge.textContent = `⏳ TTFT ${text}…`;
      badge.title = `Waiting for 1st token (prefill in progress: ${text})`;
      badge.classList.remove('hidden');
      if (tileLabel) tileLabel.textContent = 'Prefill (Live TTFT)';
      if (tileVal) tileVal.textContent = `${text}…`;
      if (tileSub) tileSub.textContent = 'waiting for 1st token';
      return;
    }

    if (live.phase === 'streaming') {
      const streamElapsed = (Number(live.streamingElapsedMs) || 0) + clientDeltaMs;
      const lockedTtft = fmtMs(live.ttftMs, 2);
      badge.className = 'kpi-ttft-badge streaming';
      badge.textContent = `⚡ TTFT ${lockedTtft} · ${fmtMs(streamElapsed, 1)}`;
      badge.title = `First token received in ${lockedTtft}; response currently streaming (${fmtMs(streamElapsed, 1)} elapsed)`;
      badge.classList.remove('hidden');
      if (tileLabel) tileLabel.textContent = 'Live Turn TTFT';
      if (tileVal) tileVal.textContent = lockedTtft;
      if (tileSub) tileSub.textContent = `streaming ${fmtMs(streamElapsed, 1)}…`;
      return;
    }

    if (stats.count > 0 && stats.latestMs != null) {
      const tone = ttftToneClass(stats.latestMs);
      const speedSuffix = ttft.latestOutputTokPerSec ? ` · ${ttft.latestOutputTokPerSec} tok/s` : '';
      badge.className = `kpi-ttft-badge ${tone}`.trim();
      badge.textContent = `⏱ TTFT ${fmtMs(stats.latestMs)}${speedSuffix}`;
      badge.title = `Latest TTFT: ${fmtMs(stats.latestMs)} · Median (P50): ${fmtMs(stats.p50Ms)} · P95: ${fmtMs(stats.p95Ms)} (${stats.count} turns)`;
      badge.classList.remove('hidden');
      if (tileLabel) tileLabel.textContent = 'Latest TTFT';
      if (tileVal) tileVal.textContent = fmtMs(stats.latestMs);
      return;
    }

    badge.className = 'kpi-ttft-badge';
    badge.textContent = '⏱ TTFT live';
    badge.title = 'Live TTFT stopwatch activates automatically when the model is called';
    badge.classList.remove('hidden');
    if (tileLabel) tileLabel.textContent = 'Live TTFT';
    if (tileVal) tileVal.textContent = 'Idle';
  }

  function renderTurnsAndTools() {
    const r = state.report;
    if (!r) return;
    const { turns, tools, summary } = r;

    // 1. SVG Turn-by-turn TTFT & Streaming Latency chart
    const measuredTurns = turns.filter((t) => typeof t.ttftMs === 'number' && Number.isFinite(t.ttftMs));
    if (!measuredTurns.length) {
      $('ttft-chart-meta').textContent = r.ttft?.live?.phase !== 'idle' ? 'Measuring live turn…' : 'Awaiting turn telemetry';
      $('ttft-chart-wrap').innerHTML = `<div class="file-empty-inline">Per-turn TTFT and streaming durations appear here automatically as Language Server generator telemetry is recorded.</div>`;
    } else {
      const maxLatMs = Math.max(
        ...measuredTurns.map((t) => (t.ttftMs || 0) + (t.streamingMs || 0)),
        500
      );
      $('ttft-chart-meta').textContent = `P50 TTFT: ${fmtMs(r.ttft?.stats?.p50Ms)} · Peak total: ${fmtMs(maxLatMs, 1)}`;
      const W = Math.max(360, turns.length * 22 + 48);
      const H = 144;
      const padL = 44;
      const padR = 10;
      const padT = 12;
      const padB = 24;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const barGap = 3;
      const barW = Math.max(6, Math.min(26, plotW / turns.length - barGap));

      const latBars = turns
        .map((t, idx) => {
          const x = padL + idx * ((plotW - barW) / Math.max(1, turns.length - 1 || 1));
          if (typeof t.ttftMs !== 'number') {
            return `<rect x="${x.toFixed(1)}" y="${(padT + plotH - 2).toFixed(1)}" width="${barW.toFixed(1)}" height="2" fill="var(--ctx-line)"><title>Turn #${t.turnNumber}: historical turn (no TTFT metadata)</title></rect>`;
          }
          const ttftH = (t.ttftMs / maxLatMs) * plotH;
          const streamH = ((t.streamingMs || 0) / maxLatMs) * plotH;
          const yTtft = padT + plotH - ttftH;
          const yStream = yTtft - streamH;
          const speedLine = t.outputTokPerSec ? `\nOutput speed: ${t.outputTokPerSec} tok/s` : '';
          const prefillLine = t.prefillTokPerSec ? `\nPrefill rate: ${fmtTok(t.prefillTokPerSec)} tok/s` : '';
          const tip = `Turn #${t.turnNumber} (step ${t.stepIndex})\nTTFT: ${fmtMs(t.ttftMs)}\nStreaming: ${fmtMs(t.streamingMs)}${speedLine}${prefillLine}\nInput: ${fmtExact(t.totalInputTokens)} tok (${(t.cacheHitRatio * 100).toFixed(1)}% cached)`;
          return `<g>
            <title>${esc(tip)}</title>
            ${streamH > 0 ? `<rect x="${x.toFixed(1)}" y="${yStream.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, streamH).toFixed(1)}" rx="2" fill="var(--cat-agent)" opacity="0.78"/>` : ''}
            <rect x="${x.toFixed(1)}" y="${yTtft.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1.5, ttftH).toFixed(1)}" rx="2" fill="var(--cat-tools)"/>
          </g>`;
        })
        .join('');

      $('ttft-chart-wrap').innerHTML = `
        <svg class="turns-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="TTFT and streaming duration per turn">
          <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="var(--ctx-line)"/>
          <line x1="${padL}" y1="${padT + plotH / 2}" x2="${W - padR}" y2="${padT + plotH / 2}" stroke="var(--ctx-line)" stroke-dasharray="2 3"/>
          <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--ctx-line)"/>
          <text x="${padL - 5}" y="${padT + 8}" text-anchor="end" font-size="10" fill="var(--ctx-muted)">${esc(fmtMs(maxLatMs, 1))}</text>
          <text x="${padL - 5}" y="${padT + plotH / 2 + 3}" text-anchor="end" font-size="10" fill="var(--ctx-muted)">${esc(fmtMs(Math.round(maxLatMs / 2), 1))}</text>
          <text x="${padL - 5}" y="${padT + plotH}" text-anchor="end" font-size="10" fill="var(--ctx-muted)">0ms</text>
          ${latBars}
          <text x="${padL}" y="${H - 6}" font-size="10" fill="var(--ctx-muted)">Turn 1</text>
          <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="10" fill="var(--ctx-muted)">Turn ${turns.length}</text>
        </svg>
        <div class="grid-legend">
          <span><b style="color:var(--cat-tools)">■</b> TTFT (time to 1st token)</span>
          <span><b style="color:var(--cat-agent)">■</b> Streaming duration</span>
        </div>`;
    }

    // 2. SVG Turn-by-turn stacked bar chart (cached vs uncached input tokens)
    if (!turns.length) {
      $('chart-meta').textContent = '0 turns';
      $('turns-chart-wrap').innerHTML = `<div class="file-empty-inline">Waiting for first model turn…</div>`;
    } else {
      const maxTok = Math.max(...turns.map((t) => t.totalInputTokens + t.outputTokens), 1000);
      $('chart-meta').textContent = `Peak: ${fmtTok(maxTok)} tok`;
      const W = Math.max(360, turns.length * 22 + 48);
      const H = 150;
      const padL = 42;
      const padR = 10;
      const padT = 12;
      const padB = 24;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const barGap = 3;
      const barW = Math.max(6, Math.min(26, plotW / turns.length - barGap));

      const bars = turns
        .map((t, idx) => {
          const x = padL + idx * ((plotW - barW) / Math.max(1, turns.length - 1 || 1));
          const cacheH = (t.cacheReadTokens / maxTok) * plotH;
          const freshH = (t.uncachedInputTokens / maxTok) * plotH;
          const yCache = padT + plotH - cacheH;
          const yFresh = yCache - freshH;
          const tip = `Turn #${t.turnNumber} (step ${t.stepIndex})\nTotal in: ${fmtExact(t.totalInputTokens)} tok\nCached: ${fmtExact(t.cacheReadTokens)} (${(t.cacheHitRatio * 100).toFixed(1)}%)\nUncached: ${fmtExact(t.uncachedInputTokens)}\nOutput: ${fmtExact(t.outputTokens)}`;
          const cpMark = t.afterCompaction
            ? `<line x1="${x - 2}" y1="${padT}" x2="${x - 2}" y2="${padT + plotH}" stroke="var(--cat-checkpoint)" stroke-dasharray="3 2" stroke-width="1.5"/>`
            : '';
          return `${cpMark}<g>
            <title>${esc(tip)}</title>
            <rect x="${x.toFixed(1)}" y="${yCache.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, cacheH).toFixed(1)}" rx="2" fill="var(--cat-system)" opacity="0.85"/>
            <rect x="${x.toFixed(1)}" y="${yFresh.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, freshH).toFixed(1)}" rx="2" fill="var(--cat-user)"/>
          </g>`;
        })
        .join('');

      $('turns-chart-wrap').innerHTML = `
        <svg class="turns-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Context tokens per model turn">
          <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="var(--ctx-line)"/>
          <line x1="${padL}" y1="${padT + plotH / 2}" x2="${W - padR}" y2="${padT + plotH / 2}" stroke="var(--ctx-line)" stroke-dasharray="2 3"/>
          <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" stroke="var(--ctx-line)"/>
          <text x="${padL - 5}" y="${padT + 8}" text-anchor="end" font-size="10" fill="var(--ctx-muted)">${esc(fmtTok(maxTok))}</text>
          <text x="${padL - 5}" y="${padT + plotH / 2 + 3}" text-anchor="end" font-size="10" fill="var(--ctx-muted)">${esc(fmtTok(Math.round(maxTok / 2)))}</text>
          <text x="${padL - 5}" y="${padT + plotH}" text-anchor="end" font-size="10" fill="var(--ctx-muted)">0</text>
          ${bars}
          <text x="${padL}" y="${H - 6}" font-size="10" fill="var(--ctx-muted)">Turn 1</text>
          <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="10" fill="var(--ctx-muted)">Turn ${turns.length}</text>
        </svg>
        <div class="grid-legend">
          <span><b style="color:var(--cat-system)">■</b> Cached input</span>
          <span><b style="color:var(--cat-user)">■</b> Uncached input</span>
          <span><b style="color:var(--cat-checkpoint)">┆</b> Compaction</span>
        </div>`;
    }

    // Tool Token Leaderboard
    const totalToolTok = Math.max(1, summary.totalActiveTokens);
    $('tools-meta').textContent = `${tools.length} tool type${tools.length === 1 ? '' : 's'}`;
    if (!tools.length) {
      $('tools-list').innerHTML = `<div class="file-empty-inline">No tool calls recorded in active context.</div>`;
    } else {
      const topMax = Math.max(1, tools[0].totalTokens);
      $('tools-list').innerHTML = tools
        .map((t) => {
          const pctWindow = ((t.totalTokens / Math.max(1, summary.contextLimit)) * 100).toFixed(1);
          const barPct = (t.totalTokens / topMax) * 100;
          return `<div class="tool-row" title="${esc(`Args: ${fmtExact(t.argTokens)} tok · Outputs: ${fmtExact(t.outputTokens)} tok`)}">
            <div class="tool-row-top">
              <span class="tool-name">${esc(t.name)}</span>
              <span class="tool-stats">${t.calls} call${t.calls === 1 ? '' : 's'} · ${esc(fmtTok(t.totalTokens))} tok (${pctWindow}%)</span>
            </div>
            <div class="tool-bar"><div class="tool-bar-fill" style="width:${barPct.toFixed(1)}%"></div></div>
          </div>`;
        })
        .join('');
    }
  }

  function renderRaw() {
    const r = state.report;
    if (!r) return;
    document.querySelectorAll('.seg-btn').forEach((b) => {
      const on = b.dataset.rawMode === state.rawMode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    if (state.rawMode === 'cli') {
      $('raw-output').textContent = r.cliText || '';
    } else {
      const { grid, cliText, ...rest } = r;
      $('raw-output').textContent = JSON.stringify(rest, null, 2);
    }
  }

  function renderAll() {
    renderHeader();
    renderOverview();
    if (state.tab === 'files') renderFilesExplorer();
    if (state.tab === 'turns') renderTurnsAndTools();
    if (state.tab === 'raw') renderRaw();
  }

  // ---------- Live polling ----------
  function setLiveStatus(ok) {
    const el = $('live');
    el.classList.toggle('stale', !ok);
    $('live-label').textContent = ok ? 'Live' : 'Reconnecting';
  }

  async function poll() {
    let delay = POLL_MS;
    try {
      await refreshWorkspaces();
      const conv = activeHostConv();
      const q = new URLSearchParams();
      if (conv) q.set('conversationId', conv);
      if (state.workspaces.length) q.set('workspaces', JSON.stringify(state.workspaces));
      if (state.limitOverride > 0) q.set('limit', String(state.limitOverride));
      if (state.etag) q.set('etag', state.etag);

      const [ctxRes, convListRes] = await Promise.all([
        getJson(`/api/context?${q}`),
        getJson('/api/conversations'),
      ]);

      state.lastOk = Date.now();
      if (Array.isArray(convListRes?.conversations)) {
        state.conversations = convListRes.conversations;
        renderConversationsDropdown();
      }

      if (!ctxRes.found) {
        state.report = null;
        state.etag = '';
        showView('empty');
        delay = IDLE_POLL_MS;
      } else {
        if (!ctxRes.unchanged) {
          state.etag = ctxRes.etag || '';
          state.report = ctxRes;
          state.reportReceivedAtMs = Date.now();
          renderAll();
        }
        if (state.report?.ttft?.live?.phase && state.report.ttft.live.phase !== 'idle') {
          delay = ACTIVE_POLL_MS;
        }
        showView('panel');
      }
    } catch (err) {
      console.warn('[context_panel] poll error:', err);
    } finally {
      setLiveStatus(Date.now() - state.lastOk <= POLL_MS * 4);
      setTimeout(poll, delay);
    }
  }

  // ---------- Event Listeners & CLI Keyboard Navigation ----------
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  });

  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const idx = TABS.indexOf(state.tab);
    let next = null;
    if (e.key === 'ArrowRight') next = TABS[(idx + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(idx - 1 + TABS.length) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (!next) return;
    e.preventDefault();
    selectTab(next, true);
  });

  $('conv-select').addEventListener('change', (e) => {
    state.selectedConv = e.target.value || '';
    state.etag = '';
    poll();
  });

  $('limit-select').addEventListener('change', (e) => {
    state.limitOverride = Number(e.target.value) || 0;
    state.etag = '';
    poll();
  });

  // Grid & Breakdown hover / click highlighting
  $('cell-grid').addEventListener('mouseover', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    state.hoveredCategory = cell.dataset.cat;
    applyHighlightVisuals();
  });
  $('cell-grid').addEventListener('mouseleave', () => {
    state.hoveredCategory = null;
    applyHighlightVisuals();
  });
  $('cell-grid').addEventListener('click', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell) return;
    state.pinnedCategory = state.pinnedCategory === cell.dataset.cat ? null : cell.dataset.cat;
    renderOverview();
  });

  $('breakdown-rows').addEventListener('mouseover', (e) => {
    const row = e.target.closest('.b-row');
    if (!row) return;
    state.hoveredCategory = row.dataset.cat;
    applyHighlightVisuals();
  });
  $('breakdown-rows').addEventListener('mouseleave', () => {
    state.hoveredCategory = null;
    applyHighlightVisuals();
  });
  $('breakdown-rows').addEventListener('click', (e) => {
    const row = e.target.closest('.b-row');
    if (!row) return;
    state.pinnedCategory = state.pinnedCategory === row.dataset.cat ? null : row.dataset.cat;
    renderOverview();
  });

  $('clear-highlight').addEventListener('click', () => {
    state.pinnedCategory = null;
    renderOverview();
  });

  $('jump-files-tab').addEventListener('click', () => selectTab('files'));

  // File clicks (open in Aux Pane or copy path)
  document.addEventListener('click', (e) => {
    const fileRow = e.target.closest('.file-row.clickable');
    if (fileRow) {
      openFileOrCopy(fileRow.dataset.uri, fileRow.dataset.path);
    }
  });

  $('file-search').addEventListener('input', () => renderFilesExplorer());
  $('file-kind-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-fkind]');
    if (!chip) return;
    state.fileFilterKind = chip.dataset.fkind;
    renderFilesExplorer();
  });

  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.rawMode = btn.dataset.rawMode;
      renderRaw();
    });
  });

  $('raw-copy').addEventListener('click', async () => {
    const ok = await copyText($('raw-output').textContent || '');
    toast(ok ? 'Copied to clipboard' : 'Copy failed');
  });

  $('help-btn').addEventListener('click', () => {
    $('shortcuts-card').classList.toggle('hidden');
  });
  $('shortcuts-close').addEventListener('click', () => {
    $('shortcuts-card').classList.add('hidden');
  });

  // agy CLI `/context` keyboard navigation controls:
  //   ↑/↓ or k/j (line), PgUp/PgDn (page), Ctrl+U/Ctrl+D (half-page), g/G (top/bottom)
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;

    if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      $('shortcuts-card').classList.toggle('hidden');
      return;
    }
    if (e.key === 'Escape') {
      if (!$('shortcuts-card').classList.contains('hidden')) {
        $('shortcuts-card').classList.add('hidden');
        return;
      }
      if (state.pinnedCategory) {
        state.pinnedCategory = null;
        renderOverview();
        return;
      }
    }
    if (e.ctrlKey && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      window.scrollBy({ top: Math.round(window.innerHeight * 0.5), behavior: 'smooth' });
      return;
    }
    if (e.ctrlKey && (e.key === 'u' || e.key === 'U')) {
      e.preventDefault();
      window.scrollBy({ top: -Math.round(window.innerHeight * 0.5), behavior: 'smooth' });
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'j' || (!e.target.closest('[role="tab"]') && e.key === 'ArrowDown')) {
      e.preventDefault();
      window.scrollBy({ top: 40, behavior: 'auto' });
    } else if (e.key === 'k' || (!e.target.closest('[role="tab"]') && e.key === 'ArrowUp')) {
      e.preventDefault();
      window.scrollBy({ top: -40, behavior: 'auto' });
    } else if (e.key === 'g') {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (e.key === 'G') {
      e.preventDefault();
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    } else if (e.key >= '1' && e.key <= '4') {
      selectTab(TABS[Number(e.key) - 1]);
    }
  });

  // Smooth 100ms live stopwatch ticker during active prefill / streaming phases
  setInterval(() => {
    const phase = state.report?.ttft?.live?.phase;
    if (phase === 'waiting_first_token' || phase === 'streaming') {
      renderLiveTtftIndicators();
    }
  }, 100);

  // Initialize
  if (state.limitOverride > 0) {
    $('limit-select').value = String(state.limitOverride);
  }
  selectTab(state.tab);
  poll();
})();
