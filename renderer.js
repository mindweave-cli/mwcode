  document.getElementById('btn-close').addEventListener('click', () => window.mw?.close());
  document.getElementById('btn-min').addEventListener('click', () => window.mw?.minimize());
  document.getElementById('btn-max').addEventListener('click', () => window.mw?.maximize());

  // The inline diff card in the transcript: an expandable tool block like everything else.
  const diffcard = document.querySelector('.diffcard');
  const diffcardWrap = document.querySelector('.diffcard-wrap');
  if (diffcard) {
    diffcard.addEventListener('click', () => {
      diffcardWrap.classList.toggle('collapsed');
    });
  }

  // ── Settings modal ────────────────────────────────────────────────────
  const settingsOverlay = document.getElementById('settings-overlay');

  document.getElementById('open-settings').addEventListener('click', () => {
    settingsOverlay.hidden = false;
    refreshProviderList();
  });
  document.getElementById('settings-close').addEventListener('click', () => {
    settingsOverlay.hidden = true;
  });
  settingsOverlay.addEventListener('click', (e) => {
    if (e.target === settingsOverlay) settingsOverlay.hidden = true;
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || settingsOverlay.hidden) return;
    // Something open ON TOP of Settings (the notes editor, a confirm) takes the Escape.
    if (!document.getElementById('att-viewer').hidden || !document.getElementById('confirm-overlay').hidden) return;
    settingsOverlay.hidden = true;
  });

  // Smooth wheel scroll — the browser's default wheel scroll jumps by a fixed
  // step per notch; this eases toward the accumulated target instead. High
  // lerp factor on purpose: fast to catch up, not a slow glide, so a fast
  // scroll still feels immediate. Returns a controller so a caller (the chat
  // body's own auto-scroll-to-bottom) can drive the SAME target/raf state
  // instead of fighting it with a second, uncoordinated scrollTop write.
  function smoothScrollify(el, onUserScroll) {
    let target = el.scrollTop;
    let raf = null;
    // Pinned = chase the LIVE bottom every frame. Content keeps growing while
    // the animation runs (a streaming reply, a result filling in), and a target
    // fixed at the moment of the call used to stop short of it.
    let pinned = false;
    // The last position WE wrote. A scroll event that doesn't match it came
    // from the user (scrollbar drag, keyboard, middle-click), not from us.
    let lastSet = el.scrollTop;
    function write(v) {
      // Whole pixels: a scroll that stops on a fraction blurs every row of text and every dot.
      el.scrollTop = Math.round(v);
      lastSet = el.scrollTop;
    }
    function step() {
      if (pinned) target = el.scrollHeight - el.clientHeight;
      const current = el.scrollTop;
      const diff = target - current;
      if (Math.abs(diff) < 0.5) {
        write(target);
        raf = null;
        return;
      }
      write(current + diff * 0.42);
      raf = requestAnimationFrame(step);
    }
    function scrollTo(pos, opts = {}) {
      pinned = !!opts.pin;
      const max = el.scrollHeight - el.clientHeight;
      target = Math.min(max, Math.max(0, pos));
      if (opts.instant) {
        if (raf) cancelAnimationFrame(raf);
        raf = null;
        write(target);
        return;
      }
      if (!raf) raf = requestAnimationFrame(step);
    }
    // Only the reader's own input takes the scroll over. The browser also moves it by itself (rows off
    // screen settling their height, anchoring): those must not cancel a scroll this is running.
    let lastInputAt = 0;
    const input = () => { lastInputAt = performance.now(); };
    el.addEventListener('pointerdown', input, { passive: true });
    el.addEventListener('touchstart', input, { passive: true });
    window.addEventListener('keydown', (e) => { if (/^(Page|Arrow|Home|End| )/.test(e.key) || e.key === ' ') input(); }, true);
    el.addEventListener('scroll', () => {
      if (Math.abs(el.scrollTop - lastSet) <= 1) return;
      if (performance.now() - lastInputAt > 400) { lastSet = el.scrollTop; return; }
      if (raf) cancelAnimationFrame(raf);
      raf = null;
      pinned = false;
      target = lastSet = el.scrollTop;
      onUserScroll?.(target, el.scrollHeight - el.clientHeight);
    });
    el.addEventListener('wheel', (e) => {
      // A list with its own scroll inside (a test's steps) scrolls itself while the
      // pointer is over it; the page stays where it is.
      const inner = e.target.closest?.('.lt-steps');
      if (inner && inner !== el && el.contains(inner) && inner.scrollHeight > inner.clientHeight) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max <= 0) return;
      e.preventDefault();
      pinned = false;
      scrollTo(target + e.deltaY);
      // Reports where the user's OWN scroll is actually headed (the target,
      // not the current mid-animation position) — the caller uses this to
      // decide whether new content should keep following, without re-deriving
      // "near the bottom" from geometry that a just-appended block has
      // already skewed (that was the actual bug: checking proximity AFTER
      // the DOM grew read as "you scrolled away" when you hadn't).
      onUserScroll?.(target, max);
    }, { passive: false });
    return {
      scrollTo,
      isNearBottom(threshold = 96) {
        return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      },
    };
  }
  // Not forEach(smoothScrollify): forEach would pass the index as its onUserScroll.
  document.querySelectorAll('.settings-panel').forEach((panel) => smoothScrollify(panel));

  document.querySelectorAll('.settings-nav button').forEach((navBtn) => {
    navBtn.addEventListener('click', () => {
      document.querySelectorAll('.settings-nav button').forEach((b) => b.classList.remove('active'));
      navBtn.classList.add('active');
      document.querySelectorAll('.settings-panel').forEach((p) => p.classList.remove('active'));
      document.getElementById(`panel-${navBtn.dataset.panel}`).classList.add('active');
    });
  });

  function wireSwitch(sw) {
    sw.addEventListener('click', () => sw.classList.toggle('on'));
  }
  document.querySelectorAll('.sw').forEach(wireSwitch);

  // Chat view: a tool call is collapsed by default, click its header to
  // reveal the result. Open by default — closing is the opt-out for a turn
  // that's gotten long.
  function wireToolToggle(tool) {
    tool.querySelector('.tool-head').addEventListener('click', () => {
      tool.classList.toggle('collapsed');
    });
  }
  document.querySelectorAll('.tool').forEach(wireToolToggle);

  // Truncated long content ("Show N more lines") — a long written/edited
  // file previews at a fixed height with a fade instead of dumping the
  // whole thing inline; this button reveals the rest in place.
  // One toggle for every "Show more / Show less". Opening grows to the measured height in a short
  // animation (or at once when it is very tall: animating a huge height stutters on a slow machine).
  // Closing is instant and keeps the button exactly where it was on screen, so nothing jumps away
  // from under the pointer when you collapse a long diff you had scrolled into.
  const TRUNC_ANIMATE_MAX = 900; // px of growth still worth animating
  // After opening, bring the "Show less" button into view (with a little room under it), so closing
  // again needs no scrolling. Never scroll the start of what was opened off the top: when the whole
  // block does not fit, its beginning stays in view and the button is a short scroll away.
  // How far to scroll (measured now, from the final layout), and in what, or null when nothing needs to move.
  function revealAfterOpen(trunc, btn, grew) {
    const scroller = trunc.closest('.chat-body, .agent-scroll, .settings-panel');
    if (!scroller || grew <= 0) return null;
    const view = scroller.getBoundingClientRect();
    const btnBottom = btn.getBoundingClientRect().bottom + 16; // where it ends up: the growth is already laid out
    const overshoot = btnBottom - view.bottom;
    if (overshoot <= 0) return null;
    const blockTop = trunc.getBoundingClientRect().top - view.top;
    const by = Math.max(0, Math.min(overshoot, blockTop - 8));
    return by ? { scroller, by } : null;
  }
  // Opening is ONE motion: the block grows and the view follows it in the same frames, on the same curve,
  // so it reads as a single unfold rather than "open, then scroll". Scrolling with the wheel mid-way hands
  // the view back to the reader; the block still finishes opening.
  function unfold(trunc, body, from, to, rv) {
    const grew = to - from;
    const dur = Math.min(320, 200 + grew * 0.12);
    const start = rv ? rv.scroller.scrollTop : 0;
    let readerTook = false;
    if (rv) rv.scroller.addEventListener('wheel', () => { readerTook = true; }, { once: true, passive: true });
    const ease = (t) => 1 - Math.pow(1 - t, 3);
    const t0 = performance.now();
    body.style.maxHeight = from + 'px';
    const frame = (now) => {
      const t = Math.max(0, Math.min(1, (now - t0) / dur));
      const e = ease(t);
      body.style.maxHeight = (from + grew * e) + 'px';
      if (rv && !readerTook) rv.scroller.scrollTop = start + rv.by * e;
      if (t < 1) trunc._unfold = requestAnimationFrame(frame);
      else { body.style.maxHeight = ''; trunc._unfold = null; }
    };
    trunc._unfold = requestAnimationFrame(frame);
  }
  function toggleTrunc(trunc, label, moreText) {
    const body = trunc.querySelector('.trunc-body');
    const btn = trunc.querySelector('.trunc-more');
    const opening = !trunc.classList.contains('open');
    if (!body) { trunc.classList.toggle('open', opening); return; }
    body.getAnimations().forEach((a) => a.cancel());
    if (trunc._unfold) { cancelAnimationFrame(trunc._unfold); trunc._unfold = null; body.style.maxHeight = ''; }
    if (opening) {
      const from = body.offsetHeight;
      trunc.classList.add('open');
      label.textContent = 'Show less';
      const to = body.scrollHeight;
      const rv = revealAfterOpen(trunc, btn, to - from); // measured now, from the final layout
      if (to - from > 0 && to - from <= TRUNC_ANIMATE_MAX) unfold(trunc, body, from, to, rv);
      else if (rv) rv.scroller.scrollBy({ top: rv.by, behavior: 'smooth' });
      return;
    }
    const before = btn.getBoundingClientRect().top;
    trunc.classList.remove('open');
    label.textContent = moreText;
    const scroller = trunc.closest('.chat-body, .agent-scroll, .settings-panel');
    const moved = btn.getBoundingClientRect().top - before;
    if (scroller && moved) scroller.scrollTop += moved;
  }
  document.querySelectorAll('.trunc').forEach((trunc) => {
    const btn = trunc.querySelector('.trunc-more');
    const label = btn.querySelector('.trunc-more-label');
    const moreText = label.textContent;
    btn.addEventListener('click', () => toggleTrunc(trunc, label, moreText));
  });


  // ── Providers — the real registry (drivers/registry.ts), not a fixed six ──
  // Every provider mwcode ships with, with whether a key is actually on file
  // and the models it currently offers (discovered providers like OpenRouter
  // refreshed on open, same TTL the CLI's picker uses).
  const providerList = document.getElementById('provider-list');
  const providerSearch = document.getElementById('provider-search');
  const providerEmpty = document.getElementById('provider-empty');
  const providerIcon = '<path d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0V5Z" stroke="currentColor" stroke-width="1.15" fill="none" stroke-linejoin="round"/>';

  // A runtime on this machine (Ollama): no key to enter. It is connected while it runs with a model
  // that takes tools pulled, and every look at this list asks it again (main.js refreshes the lists).
  function localProviderRow(p) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const names = p.models.map((m) => m.label);
    row.dataset.search = `${p.label} local ${names.join(' ')}`.toLowerCase();
    const desc = p.connected
      ? `On this machine, no key: ${names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2} more`}`
      : 'Models on your own computer, no key. Install it, pull a model that uses tools (ollama pull qwen3:8b), and keep it running.';
    row.innerHTML = `
      <div class="settings-row-main">
        <div class="settings-row-icon"><svg viewBox="0 0 16 16">${providerIcon}</svg></div>
        <div class="settings-row-label"><span class="t"></span><span class="d"></span></div>
      </div>
      <div class="settings-row-actions">
        <span class="settings-badge ${p.connected ? 'ok' : 'off'}">${p.connected ? 'Running' : 'Not running'}</span>
        ${p.connected ? '' : '<button class="settings-btn" data-act="get">Get Ollama</button>'}
        <button class="settings-btn ghost" data-act="check">Check again</button>
      </div>
    `;
    row.querySelector('.t').textContent = p.label;
    row.querySelector('.d').textContent = desc;
    row.querySelector('[data-act="get"]')?.addEventListener('click', () => window.mw.openExternal(p.keysUrl));
    row.querySelector('[data-act="check"]').addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      renderProviderList(await window.mw.listProviders());
    });
    return row;
  }

  function renderProviderList(providers) {
    providerList.querySelectorAll('.settings-row').forEach((row) => row.remove());
    const sorted = [...providers].sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    sorted.forEach((p) => {
      if (p.local) { providerList.insertBefore(localProviderRow(p), providerEmpty); return; }
      const row = document.createElement('div');
      row.className = 'settings-row';
      const modelNames = p.models.map((m) => m.label).join(', ');
      row.dataset.search = `${p.label} ${modelNames}`.toLowerCase();
      const preview =
        p.models.length === 0
          ? 'No models listed'
          : p.models.length <= 4
            ? modelNames
            : `${p.models.slice(0, 3).map((m) => m.label).join(', ')} +${p.models.length - 3} more`;
      row.innerHTML = `
        <div class="settings-row-main">
          <div class="settings-row-icon"><svg viewBox="0 0 16 16">${providerIcon}</svg></div>
          <div class="settings-row-label"><span class="t">${p.label}</span><span class="d">${preview}</span></div>
        </div>
        <div class="settings-row-actions">
          <span class="settings-badge ${p.connected ? 'ok' : 'off'}">${p.connected ? 'Connected' : 'Not connected'}</span>
          <button class="settings-btn ${p.connected ? 'ghost' : ''}">${p.connected ? 'Manage' : 'Connect'}</button>
        </div>
      `;
      // A provider with a detail screen opens it: from the row, and from Connect,
      // which there has a real key field.
      const hasDetail = !!window.PROVIDER_INFO?.[p.id];
      if (hasDetail) {
        row.classList.add('has-detail');
        row.querySelector('.settings-row-actions').insertAdjacentHTML('beforeend',
          '<svg class="row-chev" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>');
        row.addEventListener('click', (e) => {
          if (e.target.closest('.settings-btn') && p.connected) return;
          openProviderDetail(p.id);
        });
      }
      row.querySelector('.settings-btn').addEventListener('click', () => {
        if (hasDetail && !p.connected) return; // the row's click opens the detail screen
        if (hasDetail && p.connected) { openKeyManager(p.id, 'list'); return; }
        if (p.connected) {
          confirmAction(`Remove the saved key for ${p.label}?`, async () => {
            const list = await window.mw.clearProviderKey(p.apiKeyEnv);
            renderProviderList(list);
          });
        } else {
          const key = window.prompt(`API key for ${p.label}\n\nGet one at ${p.keysUrl}`);
          if (!key || !key.trim()) return;
          window.mw.setProviderKey(p.apiKeyEnv, key.trim()).then(renderProviderList);
        }
      });
      providerList.insertBefore(row, providerEmpty);
    });
    providerSearch.dispatchEvent(new Event('input'));
  }

  function refreshProviderList() {
    window.mw.listProviders?.().then(renderProviderList);
  }

  // ── Provider detail: a screen inside the Providers panel ──────────────
  // Opened by clicking a provider that has an entry in providerInfo.js. The
  // models and prices come from the engine (providerDetail); the about text,
  // links and disclosure come from providerInfo.js.
  const providersListView = document.getElementById('providers-list-view');
  const providerDetailEl = document.getElementById('provider-detail');
  const EXT_SVG = '<svg viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5H9.5V7.5M9.2 2.8L3 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Two decimals, but never rounded to nothing: $0.003 stays $0.003, not $0.00.
  // null means the provider has no separate rate for it.
  function fmtPrice(n) {
    if (n === null || n === undefined) return '—';
    if (n === 0) return 'Free';
    let out = n.toFixed(4).replace(/0+$/, '');
    if ((out.split('.')[1] ?? '').length < 2) out = n.toFixed(2);
    return `$${out}`;
  }

  function showProviderList() {
    providerDetailEl.hidden = true;
    providerDetailEl.innerHTML = '';
    providersListView.hidden = false;
  }

  async function openProviderDetail(id) {
    const info = window.PROVIDER_INFO?.[id];
    const d = await window.mw.providerDetail(id);
    if (!info || !d) return;
    providersListView.hidden = true;
    providerDetailEl.hidden = false;
    renderProviderDetail(d, info);
    providerDetailEl.closest('.settings-panel').scrollTop = 0;
  }

  function renderProviderDetail(d, info) {
    // A capability every model has is said once above the table, not on every row.
    const allThink = d.models.length > 0 && d.models.every((m) => m.thinks);
    const allImages = d.models.length > 0 && d.models.every((m) => m.acceptsImages);
    const shared = [allThink && 'thinking', allImages && 'image input'].filter(Boolean);
    // No model bills cache writes separately: drop the column rather than fill it with dashes.
    const hasWrite = d.models.some((m) => m.price.cacheWrite !== null);
    const notes = info.modelNotes ?? {};
    const rows = d.models.map((m, i) => `
      <div class="pd-model" data-search="${escapeHtml(`${m.label} ${m.id}`.toLowerCase())}" data-order="${i}" data-price="${m.price.input + m.price.output}">
        <div class="pd-model-name">
          <span class="n">${escapeHtml(m.label)}</span>
          <span class="id">${escapeHtml(m.id)}</span>
          <span class="tags">${m.thinks && !allThink ? '<span class="pd-tag">Thinking</span>' : ''}${m.acceptsImages && !allImages ? '<span class="pd-tag">Images</span>' : ''}</span>
          ${notes[m.id] ? `<span class="pd-model-note">${escapeHtml(notes[m.id])}</span>` : ''}
        </div>
        <span class="pd-num">${fmtPrice(m.price.input)}</span>
        <span class="pd-num">${fmtPrice(m.price.output)}</span>
        <span class="pd-num dim">${fmtPrice(m.price.cacheRead)}</span>
        ${hasWrite ? `<span class="pd-num dim">${fmtPrice(m.price.cacheWrite)}</span>` : ''}
      </div>`).join('');
    // Who bills you and whom Mindweave is independent of: the company, not the model name.
    const company = escapeHtml(info.company ?? d.label);
    const checked = info.pricesCheckedAt
      ? `Prices are ${company}'s published API list prices, last checked ${escapeHtml(info.pricesCheckedAt)}.`
      : `Prices come from ${escapeHtml(d.label)}'s live catalogue.`;

    providerDetailEl.innerHTML = `
      <button class="pd-back" id="pd-back"><svg viewBox="0 0 12 12" fill="none"><path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>Providers</button>

      <div class="pd-head">
        <div class="pd-mark">${escapeHtml(info.mark)}</div>
        <div class="pd-title">
          <h3>${escapeHtml(d.label)}</h3>
          <span>${escapeHtml(info.tagline)}</span>
        </div>
        <span class="settings-badge ${d.connected ? 'ok' : 'off'}">${d.connected ? 'Connected' : 'Not connected'}</span>
      </div>
      <p class="pd-about">${escapeHtml(info.about)}</p>

      <div class="pd-connect ${d.connected ? 'is-on' : ''}" id="pd-connect">
        ${d.connected ? `
          <div class="pd-connect-text"><span class="t">Connected</span><span class="d">Add more keys, choose the default, switch keys off, or let Mindweave move to the next key when one runs out.</span></div>
          <button class="settings-btn" id="pd-manage">Manage keys</button>
        ` : `
          <div class="pd-connect-text"><span class="t">Connect ${escapeHtml(d.label)}</span><span class="d">Paste an API key from your ${company} account. It stays on this computer.</span></div>
          <div class="pd-key">
            <input type="password" id="pd-key-input" placeholder="API key" spellcheck="false" autocomplete="off">
            <button class="settings-btn" id="pd-save" disabled>Connect</button>
          </div>
          <button class="pd-link" data-url="${escapeHtml(d.keysUrl)}">Get an API key ${EXT_SVG}</button>
        `}
      </div>

      <div class="pd-section">
        <div class="pd-section-head">
          <span class="settings-group">Models through the API</span>
          <span class="pd-unit">${shared.length ? `All support ${shared.join(' and ')} · ` : ''}USD per 1M tokens</span>
        </div>
        ${d.models.length > 12 ? `
          <div class="pd-tools">
            <div class="settings-search pd-filter">
              <svg viewBox="0 0 14 14"><circle cx="6" cy="6" r="4.2" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M9.2 9.2L12.5 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
              <input type="text" id="pd-filter" placeholder="Filter ${d.models.length} models…" spellcheck="false">
            </div>
            <div class="pd-sort-wrap">
              <button class="pd-sort-btn" id="pd-sort-btn" aria-haspopup="menu" title="Sort models">
                <svg viewBox="0 0 16 16" fill="none"><path d="M5 3v10M5 13l-2.5-2.5M5 13l2.5-2.5M11 13V3M11 3L8.5 5.5M11 3l2.5 2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span id="pd-sort-label">Default order</span>
                <svg class="chev" viewBox="0 0 10 10" fill="none"><path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <div class="pd-sort-menu" id="pd-sort" role="menu" hidden>
                <div class="pd-sort-head" title="Input + output price per 1M tokens">Sort by price</div>
                <button data-sort="default" class="active" role="menuitemradio">Default order</button>
                <button data-sort="asc" role="menuitemradio">Lowest price first</button>
                <button data-sort="desc" role="menuitemradio">Highest price first</button>
              </div>
            </div>
          </div>` : ''}
        <div class="pd-table ${hasWrite ? '' : 'no-write'}">
          <div class="pd-model pd-th">
            <span>Model</span><span class="pd-num">Input</span><span class="pd-num">Output</span><span class="pd-num">Cache read</span>${hasWrite ? '<span class="pd-num">Cache write</span>' : ''}
          </div>
          ${rows || `<div class="pd-empty">${d.connected ? 'No models are listed right now.' : `Connect a key to load ${escapeHtml(d.label)}'s current model list.`}</div>`}
        </div>
        ${info.priceNotes?.length ? `<ul class="pd-notes">${info.priceNotes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
      </div>

      <div class="pd-links">
        ${info.links.map((l) => `<button class="pd-link" data-url="${escapeHtml(l.url)}">${escapeHtml(l.label)} ${EXT_SVG}</button>`).join('')}
      </div>

      <p class="pd-disclosure">
        ${checked}
        They can change at any time, and ${company}'s pricing page is the authority.
        The Thinking and Images labels show what works through Mindweave.
        Usage is billed by ${company} directly to your own API key;
        Mindweave never charges you and never sees your bill.
        Mindweave is independent and is not affiliated with or endorsed by ${company}.
        ${escapeHtml(info.trademark)}
      </p>
    `;

    providerDetailEl.querySelector('#pd-back').addEventListener('click', showProviderList);
    // Sort: the provider's own order, or by input + output price. Ties keep that order.
    const sortBtn = providerDetailEl.querySelector('#pd-sort-btn');
    const sortMenu = providerDetailEl.querySelector('#pd-sort');
    sortBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      sortMenu.hidden = !sortMenu.hidden;
      sortBtn.classList.toggle('open', !sortMenu.hidden);
    });
    // A click anywhere else on the screen closes it. A property, not a listener, so
    // reopening the screen replaces it instead of stacking another.
    providerDetailEl.onclick = () => {
      if (sortMenu && !sortMenu.hidden) { sortMenu.hidden = true; sortBtn.classList.remove('open'); }
    };
    providerDetailEl.querySelectorAll('#pd-sort button').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        sortMenu.hidden = true;
        sortBtn.classList.remove('open');
        sortBtn.classList.toggle('sorted', b.dataset.sort !== 'default');
        providerDetailEl.querySelector('#pd-sort-label').textContent = b.textContent;
        providerDetailEl.querySelectorAll('#pd-sort button').forEach((x) => x.classList.toggle('active', x === b));
        const table = providerDetailEl.querySelector('.pd-table');
        const byOrder = (x, y) => x.dataset.order - y.dataset.order;
        const sorted = [...table.querySelectorAll('.pd-model[data-order]')].sort((x, y) =>
          b.dataset.sort === 'asc' ? x.dataset.price - y.dataset.price || byOrder(x, y)
            : b.dataset.sort === 'desc' ? y.dataset.price - x.dataset.price || byOrder(x, y)
              : byOrder(x, y));
        table.append(...sorted);
      });
    });
    providerDetailEl.querySelector('#pd-filter')?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      providerDetailEl.querySelectorAll('.pd-model[data-search]').forEach((row) => {
        row.hidden = !!q && !row.dataset.search.includes(q);
      });
    });
    providerDetailEl.querySelectorAll('.pd-link').forEach((b) => {
      b.addEventListener('click', () => window.mw.openExternal(b.dataset.url));
    });
    const input = providerDetailEl.querySelector('#pd-key-input');
    const save = providerDetailEl.querySelector('#pd-save');
    if (input) {
      input.addEventListener('input', () => { save.disabled = !input.value.trim(); });
      const connect = async () => {
        const key = input.value.trim();
        if (!key) return;
        const list = await window.mw.setProviderKey(d.apiKeyEnv, key);
        renderProviderList(list);
        openProviderDetail(d.id);
      };
      save.addEventListener('click', connect);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
    }
    providerDetailEl.querySelector('#pd-manage')?.addEventListener('click', () => openKeyManager(d.id));
  }


  // ── Manage keys: a screen inside a provider's detail screen ──────────
  // Every key the provider has, which one is in use and which is the default,
  // names, switching keys off, and moving on automatically when one is refused.
  // Each action goes to the engine and the screen redraws from the view it
  // returns, so it can never show a state that isn't what's stored.
  const KEY_SVG = '<svg viewBox="0 0 16 16" fill="none"><circle cx="5.5" cy="10.5" r="3" stroke="currentColor" stroke-width="1.2"/><path d="M7.7 8.3L13 3M11 5l1.6 1.6M9.6 6.4l1.2 1.2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
  const DOTS_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="12.5" cy="8" r="1.3"/></svg>';
  const FAILURE_TEXT = { 'no-credit': 'Out of credit', 'rate-limited': 'Rate limited', rejected: 'Rejected' };
  let keyEditing = null; // { slot, kind: 'rename' | 'replace' } | { kind: 'add' }
  // Where Back goes: the screen Manage was opened from ('list' or 'detail').
  let keyManagerFrom = 'detail';

  function agoShort(ms) {
    const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  }

  async function openKeyManager(id, from = 'detail') {
    keyEditing = null;
    keyManagerFrom = from;
    const view = await window.mw.providerKeys(id);
    providersListView.hidden = true;
    providerDetailEl.hidden = false;
    renderKeyManager(view);
    providerDetailEl.closest('.settings-panel').scrollTop = 0;
  }

  async function keyAct(view, action, args) {
    const { result, view: next, providers } = await window.mw.keyAction(view.providerId, action, args);
    renderProviderList(providers);
    keyEditing = result.ok ? null : keyEditing;
    renderKeyManager(next, result.ok ? null : result.error);
  }

  function renderKeyManager(view, error = null) {
    const info = window.PROVIDER_INFO?.[view.providerId] ?? {};
    const company = escapeHtml(info.company ?? view.label);
    const on = view.keys.filter((k) => !k.disabled).length;
    const rows = view.keys.map((k) => {
      const name = k.label || `Key ${k.slot}`;
      const editing = keyEditing && keyEditing.slot === k.slot ? keyEditing.kind : null;
      const badges = [
        k.live ? '<span class="km-badge live">In use</span>' : '',
        k.isDefault ? '<span class="km-badge def">Default</span>' : '',
        k.disabled ? '<span class="km-badge off">Off</span>' : '',
        k.failure ? `<span class="km-badge bad" title="HTTP ${k.failure.status}">${FAILURE_TEXT[k.failure.reason]} · ${agoShort(k.failure.at)}</span>` : '',
      ].join('');
      return `
        <div class="km-key ${k.disabled ? 'is-off' : ''} ${k.live ? 'is-live' : ''}" data-slot="${k.slot}">
          <div class="km-key-main">
            <span class="km-key-ico">${KEY_SVG}</span>
            <div class="km-key-text">
              <span class="n">${escapeHtml(name)}<span class="hint">${escapeHtml(k.hint)}</span></span>
              <span class="km-badges">${badges}</span>
            </div>
            <div class="sw ${k.disabled ? '' : 'on'} km-toggle" role="switch" aria-checked="${!k.disabled}" title="${k.disabled ? 'Turn this key on' : 'Turn this key off'}"></div>
            <div class="km-more-wrap">
              <button class="km-more" aria-label="More actions" aria-haspopup="menu">${DOTS_SVG}</button>
              <div class="km-menu" role="menu" hidden>
                <button data-act="use" ${k.live || k.disabled ? 'disabled' : ''}>Use this key now</button>
                <button data-act="makeDefault" ${k.isDefault ? 'disabled' : ''}>Make default</button>
                <div class="km-menu-sep"></div>
                <button data-act="rename">Rename</button>
                <button data-act="replace">Replace key…</button>
                <div class="km-menu-sep"></div>
                <button data-act="remove" class="danger">Remove</button>
              </div>
            </div>
          </div>
          ${editing === 'rename' ? `
            <div class="km-edit">
              <input type="text" class="km-input" id="km-edit-input" maxlength="40" placeholder="Name, e.g. Work or Personal" value="${escapeHtml(k.label)}" spellcheck="false">
              <button class="settings-btn ghost" data-edit="cancel">Cancel</button>
              <button class="settings-btn" data-edit="save">Save</button>
            </div>` : ''}
          ${editing === 'replace' ? `
            <div class="km-edit">
              <input type="password" class="km-input mono" id="km-edit-input" placeholder="Paste the new key" spellcheck="false" autocomplete="off">
              <button class="settings-btn ghost" data-edit="cancel">Cancel</button>
              <button class="settings-btn" data-edit="save">Replace</button>
            </div>` : ''}
        </div>`;
    }).join('');

    providerDetailEl.innerHTML = `
      <button class="pd-back" id="km-back"><svg viewBox="0 0 12 12" fill="none"><path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>${keyManagerFrom === 'list' ? 'Providers' : escapeHtml(view.label)}</button>
      <div class="km-head">
        <div>
          <h3>API keys</h3>
          <span>${escapeHtml(view.label)} · ${view.keys.length} of ${view.maxKeys} saved${view.keys.length ? ` · ${on} on` : ''}</span>
        </div>
        <button class="settings-btn" id="km-add-btn" ${view.keys.length >= view.maxKeys ? 'disabled' : ''}>+ Add key</button>
      </div>

      ${error ? `<div class="km-error">${escapeHtml(error)}</div>` : ''}

      ${keyEditing?.kind === 'add' ? `
        <div class="km-add">
          <div class="km-add-title">Add a key</div>
          <input type="password" class="km-input mono" id="km-add-key" placeholder="Paste an API key from your ${company} account" spellcheck="false" autocomplete="off">
          <div class="km-add-row">
            <input type="text" class="km-input" id="km-add-label" maxlength="40" placeholder="Name (optional), e.g. Work" spellcheck="false">
            <button class="settings-btn ghost" id="km-add-cancel">Cancel</button>
            <button class="settings-btn" id="km-add-save">Add key</button>
          </div>
          <button class="pd-link" data-url="${escapeHtml(view.keysUrl)}">Get an API key ${EXT_SVG}</button>
        </div>` : ''}

      <div class="km-list">
        ${rows || `<div class="km-empty">No keys saved for ${escapeHtml(view.label)} yet.</div>`}
      </div>

      <div class="km-auto">
        <div class="km-auto-text">
          <span class="t">Switch keys automatically</span>
          <span class="d">If the key in use runs out of credit, hits its rate limit or is rejected, carry on with the next key that's on, without stopping the task.${view.keys.length < 2 ? ' Needs two or more keys.' : ''}</span>
        </div>
        <div class="sw ${view.autoSwitch ? 'on' : ''}" id="km-auto" role="switch" aria-checked="${view.autoSwitch}"></div>
      </div>

      <p class="pd-disclosure">
        Keys are stored only on this computer, in ~/.mindweave/.env, and only their last four characters are ever shown.
        The default key is the one used each time Mindweave starts; "Use this key now" switches without changing the default.
        A key that is off stays saved but is never sent.
      </p>
    `;

    const $ = (sel) => providerDetailEl.querySelector(sel);
    $('#km-back').addEventListener('click', () => (keyManagerFrom === 'list' ? showProviderList() : openProviderDetail(view.providerId)));
    providerDetailEl.querySelectorAll('.pd-link').forEach((b) => b.addEventListener('click', () => window.mw.openExternal(b.dataset.url)));
    $('#km-add-btn').addEventListener('click', () => { keyEditing = { kind: 'add' }; renderKeyManager(view); $('#km-add-key')?.focus(); });
    $('#km-auto').addEventListener('click', () => keyAct(view, 'autoSwitch', { on: !view.autoSwitch }));

    if (keyEditing?.kind === 'add') {
      const add = () => keyAct(view, 'add', { value: $('#km-add-key').value, label: $('#km-add-label').value });
      $('#km-add-save').addEventListener('click', add);
      $('#km-add-cancel').addEventListener('click', () => { keyEditing = null; renderKeyManager(view); });
      [$('#km-add-key'), $('#km-add-label')].forEach((i) => i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') add();
        if (e.key === 'Escape') { e.stopPropagation(); keyEditing = null; renderKeyManager(view); }
      }));
    }

    // Close any open ⋯ menu on a click elsewhere. A property, so re-renders replace it.
    providerDetailEl.onclick = () => providerDetailEl.querySelectorAll('.km-menu').forEach((m) => { m.hidden = true; });

    providerDetailEl.querySelectorAll('.km-key').forEach((row) => {
      const slot = Number(row.dataset.slot);
      const k = view.keys.find((x) => x.slot === slot);
      row.querySelector('.km-toggle').addEventListener('click', () => keyAct(view, k.disabled ? 'enable' : 'disable', { slot }));
      const menu = row.querySelector('.km-menu');
      row.querySelector('.km-more').addEventListener('click', (e) => {
        e.stopPropagation();
        const wasHidden = menu.hidden;
        providerDetailEl.querySelectorAll('.km-menu').forEach((m) => { m.hidden = true; });
        menu.hidden = !wasHidden;
      });
      menu.querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden = true;
        const act = b.dataset.act;
        if (act === 'rename' || act === 'replace') {
          keyEditing = { slot, kind: act };
          renderKeyManager(view);
          $('#km-edit-input')?.focus();
        } else if (act === 'remove') {
          confirmAction(`Remove ${k.label || `Key ${k.slot}`} (${k.hint}) from ${view.label}? It will be deleted from this computer.`, () => keyAct(view, 'remove', { slot }));
        } else {
          keyAct(view, act, { slot });
        }
      }));
      const input = row.querySelector('#km-edit-input');
      if (input) {
        const save = () => keyAct(view, keyEditing.kind === 'rename' ? 'rename' : 'edit', keyEditing.kind === 'rename' ? { slot, label: input.value } : { slot, value: input.value });
        row.querySelector('[data-edit="save"]').addEventListener('click', save);
        row.querySelector('[data-edit="cancel"]').addEventListener('click', () => { keyEditing = null; renderKeyManager(view); });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') { e.stopPropagation(); keyEditing = null; renderKeyManager(view); }
        });
      }
    });
  }


  // ── Settings > MCP Servers ────────────────────────────────────────────
  // Three screens in one panel: the list, one server's page, and the add/edit
  // form. Everything reads from and writes to the engine (core/mcpServers.ts),
  // which writes the same mcp.json files the CLI's /mcp box does and applies each
  // change to the running servers at once.
  const mcpRoot = document.getElementById('mcp-root');
  const mcpPanel = document.getElementById('panel-mcp');
  let mcpView = { kind: 'list' }; // { kind: 'list' } | { kind: 'detail', name } | { kind: 'form', edit?: detail }
  let mcpSignInUrl = null; // { name, url } while a sign-in is waiting on the browser
  let mcpBusy = null; // name of the server an action is running on
  const MCP_STATE = {
    connected: { dot: 'ok', text: 'Connected' },
    pending: { dot: 'wait', text: 'Connecting…' },
    failed: { dot: 'bad', text: 'Failed' },
    'needs-auth': { dot: 'warn', text: 'Needs sign-in' },
    disabled: { dot: 'off', text: 'Off' },
  };
  const CHEV_R = '<svg viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const BACK_SVG = '<svg viewBox="0 0 12 12" fill="none"><path d="M7.5 2.5L4 6l3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const PLUG_SVG = '<svg viewBox="0 0 16 16" fill="none"><path d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0V5ZM8 11.5V14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function mcpStatusLine(s) {
    if (s.state === 'connected') {
      const parts = [plural(s.toolCount, 'tool')];
      if (s.promptCount) parts.push(plural(s.promptCount, 'prompt'));
      if (s.offersResources) parts.push('resources');
      return `Connected · ${parts.join(' · ')}`;
    }
    if (s.state === 'failed') return s.error ? `Failed: ${s.error}` : 'Failed to connect';
    return MCP_STATE[s.state]?.text ?? s.state;
  }
  const mcpChips = (s) =>
    `<span class="mcp-chip">${s.type === 'http' ? 'Remote' : 'Local'}</span><span class="mcp-chip">${s.scope === 'global' ? 'All projects' : 'This project'}</span>`;

  async function mcpRender() {
    if (mcpView.kind === 'list') return mcpRenderList(await window.mw.mcpList());
    if (mcpView.kind === 'detail') {
      const d = await window.mw.mcpDetail(mcpView.name);
      if (!d) { mcpView = { kind: 'list' }; return mcpRender(); }
      return mcpRenderDetail(d);
    }
    return mcpRenderForm(mcpView.edit ?? null, mcpView.error ?? null, mcpView.draft ?? null);
  }
  function mcpGo(view) {
    mcpView = view;
    mcpPanel.scrollTop = 0;
    return mcpRender();
  }
  async function mcpAct(action, args, after) {
    mcpBusy = args.name ?? null;
    if (mcpView.kind !== 'form') await mcpRender();
    const { result } = await window.mw.mcpAction(action, args);
    mcpBusy = null;
    if (after) return after(result);
    if (!result.ok) mcpToast(result.error);
    return mcpRender();
  }
  function mcpToast(text) {
    const el = mcpRoot.querySelector('.mcp-toast');
    if (el) { el.textContent = text; el.hidden = false; }
  }

  // ── List ──
  function mcpRenderList(servers) {
    const connected = servers.filter((s) => s.state === 'connected');
    const tools = connected.reduce((n, s) => n + s.toolCount, 0);
    const blocked = servers.reduce((n, s) => n + s.blockedCount, 0);
    const cards = servers.map((s) => {
      const st = MCP_STATE[s.state] ?? MCP_STATE.pending;
      return `
        <div class="mcp-card state-${s.state} ${mcpBusy === s.name ? 'busy' : ''}" data-name="${escapeHtml(s.name)}" tabindex="0">
          <span class="mcp-tile">${escapeHtml(s.name.slice(0, 1).toUpperCase())}</span>
          <div class="mcp-card-text">
            <div class="mcp-card-top"><span class="n">${escapeHtml(s.name)}</span>${mcpChips(s)}</div>
            <div class="mcp-status"><span class="mcp-dot ${st.dot}"></span><span class="mcp-status-text">${escapeHtml(mcpStatusLine(s))}</span></div>
          </div>
          ${s.blockedCount ? `<span class="km-badge bad" title="Tools that changed since you allowed them">${s.blockedCount} blocked</span>` : ''}
          <div class="sw ${s.state === 'disabled' ? '' : 'on'} mcp-toggle" role="switch" aria-checked="${s.state !== 'disabled'}" title="${s.state === 'disabled' ? 'Turn on' : 'Turn off'}"></div>
          <span class="mcp-chev">${CHEV_R}</span>
        </div>`;
    }).join('');

    mcpRoot.innerHTML = `
      <div class="mcp-head">
        <div>
          <div class="settings-section-title">MCP Servers</div>
          <div class="settings-section-desc">Tools from outside Mindweave that the agent can use, from servers on this computer or on the web.</div>
        </div>
        <button class="settings-btn" id="mcp-add">+ Add server</button>
      </div>
      <div class="mcp-toast" hidden></div>
      ${servers.length ? `
        <div class="mcp-summary">
          <span>${plural(servers.length, 'server')}</span><span class="sep"></span>
          <span><span class="mcp-dot ok"></span>${connected.length} connected</span><span class="sep"></span>
          <span>${plural(tools, 'tool')} available</span>
        </div>
        ${blocked ? `
          <div class="mcp-warn">
            <div><span class="t">${plural(blocked, 'tool')} changed since you allowed ${blocked === 1 ? 'it' : 'them'}</span>
            <span class="d">A server changed what ${blocked === 1 ? 'a tool says it does' : 'some tools say they do'}, so ${blocked === 1 ? 'it is' : 'they are'} blocked until you allow ${blocked === 1 ? 'it' : 'them'} again.</span></div>
            <button class="settings-btn ghost" id="mcp-allow">Allow</button>
          </div>` : ''}
        <div class="mcp-list">${cards}</div>
      ` : `
        <div class="mcp-empty">
          <span class="mcp-empty-ico">${PLUG_SVG}</span>
          <div class="t">No MCP servers yet</div>
          <div class="d">Add one to give the agent more tools, such as GitHub, a database or a browser.</div>
          <button class="settings-btn" id="mcp-add-empty">+ Add server</button>
        </div>`}
    `;
    mcpRoot.querySelector('#mcp-add').addEventListener('click', () => mcpGo({ kind: 'form' }));
    mcpRoot.querySelector('#mcp-add-empty')?.addEventListener('click', () => mcpGo({ kind: 'form' }));
    mcpRoot.querySelector('#mcp-allow')?.addEventListener('click', () =>
      confirmAction('Allow the changed tools? Their new descriptions will be trusted from now on.', () => mcpAct('allowChanged', {})));
    mcpRoot.querySelectorAll('.mcp-card').forEach((card) => {
      const name = card.dataset.name;
      const s = servers.find((x) => x.name === name);
      card.querySelector('.mcp-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        mcpAct(s.state === 'disabled' ? 'enable' : 'disable', { name });
      });
      card.addEventListener('click', () => mcpGo({ kind: 'detail', name }));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') mcpGo({ kind: 'detail', name }); });
    });
  }

  // ── One server ──
  function mcpRenderDetail(d) {
    const st = MCP_STATE[d.state] ?? MCP_STATE.pending;
    const off = d.state === 'disabled';
    const secrets = d.type === 'http' ? d.config.headers : d.config.env;
    const secretRows = Object.entries(secrets).map(([k, v]) => `
      <div class="mcp-kv"><span class="k mono">${escapeHtml(k)}</span><span class="v mono mcp-secret" data-value="${escapeHtml(v)}">${'•'.repeat(Math.min(12, Math.max(6, v.length)))}</span></div>`).join('');
    const tools = d.tools.map((t) => `
      <div class="mcp-tool" data-search="${escapeHtml(`${t.name} ${t.description}`.toLowerCase())}">
        <div class="mcp-tool-top">
          <span class="n mono">${escapeHtml(t.name)}</span>
          ${t.readOnly ? '<span class="pd-tag">Read-only</span>' : ''}
          ${t.blocked === 'changed' ? '<span class="km-badge bad">Changed · blocked</span>' : t.blocked === 'forbidden' ? '<span class="km-badge off">Forbidden</span>' : ''}
        </div>
        ${t.description ? `<div class="mcp-tool-desc">${escapeHtml(t.description)}</div>` : ''}
      </div>`).join('');
    const waiting = mcpSignInUrl && mcpSignInUrl.name === d.name;

    mcpRoot.innerHTML = `
      <button class="pd-back" id="mcp-back">${BACK_SVG}MCP Servers</button>
      <div class="mcp-dhead">
        <span class="mcp-tile big state-${d.state}">${escapeHtml(d.name.slice(0, 1).toUpperCase())}</span>
        <div class="mcp-dtitle">
          <h3>${escapeHtml(d.name)}</h3>
          <div class="mcp-card-top">${mcpChips(d)}<span class="mcp-status"><span class="mcp-dot ${st.dot}"></span>${escapeHtml(st.text)}</span></div>
        </div>
        <div class="sw ${off ? '' : 'on'}" id="mcp-d-toggle" role="switch" aria-checked="${!off}" title="${off ? 'Turn on' : 'Turn off'}"></div>
      </div>

      <div class="mcp-actions">
        <button class="settings-btn ghost" id="mcp-reconnect" ${off || mcpBusy ? 'disabled' : ''}>${mcpBusy === d.name ? 'Working…' : 'Reconnect'}</button>
        ${d.type === 'http' ? (d.signedIn
          ? '<button class="settings-btn ghost" id="mcp-signout">Sign out</button>'
          : `<button class="settings-btn ${d.state === 'needs-auth' ? '' : 'ghost'}" id="mcp-signin" ${off ? 'disabled' : ''}>Sign in</button>`) : ''}
        <button class="settings-btn ghost" id="mcp-edit">Edit</button>
        <span class="grow"></span>
        <button class="settings-btn ghost danger-text" id="mcp-remove">Remove</button>
      </div>
      <div class="mcp-toast" hidden></div>

      ${waiting ? `
        <div class="mcp-note">
          <span class="t">Finish signing in in your browser</span>
          <span class="d">If no browser window opened, open the sign-in page yourself.</span>
          <button class="pd-link" id="mcp-open-signin">Open sign-in page ${EXT_SVG}</button>
        </div>` : ''}
      ${d.state === 'failed' && d.error ? `<div class="mcp-error"><span class="t">Couldn't connect</span><span class="d mono">${escapeHtml(d.error)}</span></div>` : ''}
      ${d.state === 'needs-auth' && !waiting ? `<div class="mcp-note"><span class="t">This server needs you to sign in</span><span class="d">Sign in opens its login page in your browser; the server connects once you're done.</span></div>` : ''}

      <div class="mcp-section">
        <div class="settings-group">Connection</div>
        <div class="mcp-box">
          <div class="mcp-kv"><span class="k">${d.type === 'http' ? 'Address' : 'Runs'}</span><span class="v mono">${escapeHtml(d.target)}</span></div>
          <div class="mcp-kv"><span class="k">Saved in</span><span class="v mono">${escapeHtml(d.configPath)}</span></div>
          ${d.serverInfo ? `<div class="mcp-kv"><span class="k">Server</span><span class="v">${escapeHtml(d.serverInfo.name)}${d.serverInfo.version ? ` ${escapeHtml(d.serverInfo.version)}` : ''}</span></div>` : ''}
          ${d.version ? `<div class="mcp-kv"><span class="k">Protocol</span><span class="v mono">${escapeHtml(d.version)}</span></div>` : ''}
        </div>
      </div>

      ${secretRows ? `
        <div class="mcp-section">
          <div class="mcp-section-head"><span class="settings-group">${d.type === 'http' ? 'Headers' : 'Environment variables'}</span><button class="pd-link" id="mcp-reveal">Show values</button></div>
          <div class="mcp-box">${secretRows}</div>
        </div>` : ''}

      <div class="mcp-section">
        <div class="mcp-section-head"><span class="settings-group">Tools</span><span class="pd-unit">${d.state === 'connected' ? plural(d.tools.length, 'tool') : 'Listed once it connects'}</span></div>
        ${d.tools.length > 8 ? `
          <div class="settings-search pd-filter"><svg viewBox="0 0 14 14"><circle cx="6" cy="6" r="4.2" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M9.2 9.2L12.5 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg><input type="text" id="mcp-tool-filter" placeholder="Filter ${d.tools.length} tools…" spellcheck="false"></div>` : ''}
        ${tools ? `<div class="mcp-tools">${tools}</div>` : `<div class="km-empty">${off ? 'This server is off.' : d.state === 'connected' ? 'This server offers no tools.' : 'No tools yet.'}</div>`}
      </div>
    `;
    const $ = (sel) => mcpRoot.querySelector(sel);
    $('#mcp-back').addEventListener('click', () => mcpGo({ kind: 'list' }));
    $('#mcp-d-toggle').addEventListener('click', () => mcpAct(off ? 'enable' : 'disable', { name: d.name }));
    $('#mcp-reconnect').addEventListener('click', () => mcpAct('reconnect', { name: d.name }));
    $('#mcp-signin')?.addEventListener('click', () => mcpAct('signIn', { name: d.name }, (r) => {
      mcpSignInUrl = null;
      if (!r.ok) { mcpRender().then(() => mcpToast(r.error)); return; }
      mcpRender();
    }));
    $('#mcp-signout')?.addEventListener('click', () => confirmAction(`Sign out of ${d.name}? Its saved login is deleted from this computer.`, () => mcpAct('signOut', { name: d.name })));
    $('#mcp-open-signin')?.addEventListener('click', () => window.mw.openExternal(mcpSignInUrl.url));
    $('#mcp-edit').addEventListener('click', () => mcpGo({ kind: 'form', edit: d }));
    $('#mcp-remove').addEventListener('click', () =>
      confirmAction(`Remove ${d.name}? It stops now and is deleted from ${d.configPath}.`, () => mcpAct('remove', { name: d.name }, (r) => {
        if (!r.ok) return mcpRender().then(() => mcpToast(r.error));
        return mcpGo({ kind: 'list' });
      })));
    $('#mcp-reveal')?.addEventListener('click', (e) => {
      const show = e.currentTarget.textContent.startsWith('Show');
      mcpRoot.querySelectorAll('.mcp-secret').forEach((el) => {
        el.textContent = show ? el.dataset.value : '•'.repeat(Math.min(12, Math.max(6, el.dataset.value.length)));
      });
      e.currentTarget.textContent = show ? 'Hide values' : 'Show values';
    });
    $('#mcp-tool-filter')?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      mcpRoot.querySelectorAll('.mcp-tool').forEach((row) => { row.hidden = !!q && !row.dataset.search.includes(q); });
    });
  }

  // ── Add / edit ──
  function mcpQuote(arg) {
    return /[\s'"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
  }
  function mcpPairsEditor(id, pairs, keyPh, valPh) {
    const rows = (pairs.length ? pairs : [['', '']]).map(([k, v]) => `
      <div class="mcp-pair">
        <input type="text" class="km-input mono" placeholder="${keyPh}" value="${escapeHtml(k)}" spellcheck="false">
        <input type="text" class="km-input mono" placeholder="${valPh}" value="${escapeHtml(v)}" spellcheck="false" autocomplete="off">
        <button class="mcp-pair-x" aria-label="Remove">×</button>
      </div>`).join('');
    return `<div class="mcp-pairs" id="${id}">${rows}</div><button class="pd-link mcp-pair-add" data-for="${id}">+ Add another</button>`;
  }
  function mcpReadPairs(id) {
    const out = {};
    mcpRoot.querySelectorAll(`#${id} .mcp-pair`).forEach((row) => {
      const [k, v] = row.querySelectorAll('input');
      if (k.value.trim()) out[k.value.trim()] = v.value;
    });
    return out;
  }

  function mcpRenderForm(edit, error, draft) {
    const d = draft ?? (edit
      ? {
          name: edit.name, type: edit.type, scope: edit.scope,
          command: edit.type === 'stdio' ? [edit.config.command, ...edit.config.args].map(mcpQuote).join(' ') : '',
          url: edit.config.url ?? '',
          env: Object.entries(edit.config.env), headers: Object.entries(edit.config.headers),
        }
      : { name: '', type: 'stdio', scope: 'project', command: '', url: '', env: [], headers: [] });
    mcpRoot.innerHTML = `
      <button class="pd-back" id="mcp-back">${BACK_SVG}${edit ? escapeHtml(edit.name) : 'MCP Servers'}</button>
      <div class="km-head"><div><h3>${edit ? 'Edit server' : 'Add a server'}</h3><span>${edit ? 'Saving reconnects it with the new settings.' : 'It connects as soon as you save.'}</span></div></div>
      ${error ? `<div class="km-error">${escapeHtml(error)}</div>` : ''}
      <div class="mcp-form">
        <label class="mcp-field"><span class="l">Name</span>
          <input type="text" class="km-input" id="mcp-f-name" placeholder="e.g. github" value="${escapeHtml(d.name)}" spellcheck="false" autocomplete="off">
          <span class="h">Its tools show up to the agent under this name.</span></label>

        <div class="mcp-field"><span class="l">Type</span>
          <div class="settings-seg mcp-seg" id="mcp-f-type">
            <button data-v="stdio" class="${d.type === 'stdio' ? 'active' : ''}">Local command</button>
            <button data-v="http" class="${d.type === 'http' ? 'active' : ''}">Remote URL</button>
          </div></div>

        <div class="mcp-when" data-when="stdio" ${d.type === 'stdio' ? '' : 'hidden'}>
          <label class="mcp-field"><span class="l">Command</span>
            <input type="text" class="km-input mono" id="mcp-f-command" placeholder="npx -y @modelcontextprotocol/server-github" value="${escapeHtml(d.command)}" spellcheck="false" autocomplete="off">
            <span class="h">The command that starts the server, with its arguments. Quote anything with spaces.</span></label>
          <div class="mcp-field"><span class="l">Environment variables <em>optional</em></span>
            ${mcpPairsEditor('mcp-f-env', d.env, 'NAME', 'value')}</div>
        </div>

        <div class="mcp-when" data-when="http" ${d.type === 'http' ? '' : 'hidden'}>
          <label class="mcp-field"><span class="l">Server URL</span>
            <input type="text" class="km-input mono" id="mcp-f-url" placeholder="https://example.com/mcp" value="${escapeHtml(d.url)}" spellcheck="false" autocomplete="off">
            <span class="h">If the server needs a login, you can sign in from its page after saving.</span></label>
          <div class="mcp-field"><span class="l">Headers <em>optional</em></span>
            ${mcpPairsEditor('mcp-f-headers', d.headers, 'Header', 'value')}</div>
        </div>

        <div class="mcp-field"><span class="l">Available in</span>
          <div class="settings-seg mcp-seg" id="mcp-f-scope">
            <button data-v="project" class="${d.scope === 'project' ? 'active' : ''}">This project</button>
            <button data-v="global" class="${d.scope === 'global' ? 'active' : ''}">All projects</button>
          </div>
          <span class="h" id="mcp-f-scope-h">${d.scope === 'global' ? 'Saved in ~/.mindweave/mcp.json.' : 'Saved in this project\'s .mindweave/mcp.json. Share it with the repo, or keep secrets out of it.'}</span></div>
      </div>
      <div class="mcp-form-foot">
        <button class="settings-btn ghost" id="mcp-f-cancel">Cancel</button>
        <button class="settings-btn" id="mcp-f-save">${edit ? 'Save and reconnect' : 'Add and connect'}</button>
      </div>
    `;
    const $ = (sel) => mcpRoot.querySelector(sel);
    const back = () => mcpGo(edit ? { kind: 'detail', name: edit.name } : { kind: 'list' });
    $('#mcp-back').addEventListener('click', back);
    $('#mcp-f-cancel').addEventListener('click', back);
    const segValue = (id) => mcpRoot.querySelector(`#${id} button.active`)?.dataset.v;
    for (const id of ['mcp-f-type', 'mcp-f-scope']) {
      mcpRoot.querySelectorAll(`#${id} button`).forEach((b) => b.addEventListener('click', () => {
        mcpRoot.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle('active', x === b));
        if (id === 'mcp-f-type') mcpRoot.querySelectorAll('.mcp-when').forEach((w) => { w.hidden = w.dataset.when !== b.dataset.v; });
        if (id === 'mcp-f-scope') $('#mcp-f-scope-h').textContent = b.dataset.v === 'global' ? 'Saved in ~/.mindweave/mcp.json.' : 'Saved in this project\'s .mindweave/mcp.json. Share it with the repo, or keep secrets out of it.';
      }));
    }
    const wirePairs = () => {
      mcpRoot.querySelectorAll('.mcp-pair-x').forEach((x) => { x.onclick = () => {
        const list = x.closest('.mcp-pairs');
        if (list.querySelectorAll('.mcp-pair').length > 1) x.closest('.mcp-pair').remove();
        else x.closest('.mcp-pair').querySelectorAll('input').forEach((i) => { i.value = ''; });
      }; });
    };
    mcpRoot.querySelectorAll('.mcp-pair-add').forEach((b) => b.addEventListener('click', () => {
      const list = mcpRoot.querySelector(`#${b.dataset.for}`);
      const row = list.querySelector('.mcp-pair').cloneNode(true);
      row.querySelectorAll('input').forEach((i) => { i.value = ''; });
      list.appendChild(row);
      wirePairs();
      row.querySelector('input').focus();
    }));
    wirePairs();
    $('#mcp-f-name').focus();
    $('#mcp-f-save').addEventListener('click', async () => {
      const form = {
        name: $('#mcp-f-name').value,
        type: segValue('mcp-f-type'),
        scope: segValue('mcp-f-scope'),
        command: $('#mcp-f-command').value,
        args: '',
        url: $('#mcp-f-url').value,
        env: mcpReadPairs('mcp-f-env'),
        headers: mcpReadPairs('mcp-f-headers'),
        ...(edit ? { originalName: edit.name } : {}),
      };
      const draftNow = { ...form, env: Object.entries(form.env), headers: Object.entries(form.headers) };
      $('#mcp-f-save').disabled = true;
      $('#mcp-f-save').textContent = 'Connecting…';
      await mcpAct('save', { form }, (r) => {
        if (!r.ok) return mcpGo({ kind: 'form', edit, error: r.error, draft: draftNow });
        return mcpGo({ kind: 'detail', name: form.name.trim() });
      });
    });
  }

  document.querySelectorAll('.settings-nav button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.panel === 'mcp') mcpGo({ kind: 'list' });
  }));
  // Servers connect and fail in the background: keep the list and a server's page live,
  // but never redraw a form someone is typing into.
  window.mw?.onMcpChanged?.(() => {
    if (!mcpPanel.classList.contains('active') || document.getElementById('settings-overlay').hidden) return;
    if (mcpView.kind !== 'form' && !mcpBusy) mcpRender();
  });
  window.mw?.onMcpSignInUrl?.(({ name, url }) => {
    mcpSignInUrl = { name, url };
    if (mcpView.kind === 'detail' && mcpView.name === name) mcpRender();
  });


  // Row actions on Permissions and Rules & Skills: small icons, named on hover.
  const ICON_RETRY = '<svg viewBox="0 0 16 16" fill="none"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_EDIT = '<svg viewBox="0 0 16 16" fill="none"><path d="M10.6 2.9l2.5 2.5L6 12.5H3.5V10l7.1-7.1Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  const ICON_MOVE = '<svg viewBox="0 0 16 16" fill="none"><path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 16 16" fill="none"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ── Settings > Permissions ────────────────────────────────────────────
  // Plain, like Rules & Skills: pick a project (or All projects) from a list, then
  // simple rows. A project's view also lists the rules for all projects that apply
  // there, tagged. Every action goes to the engine (core/permissions.ts), which
  // writes the file and applies it to the open chat at once.
  const permRoot = document.getElementById('perm-root');
  let permCwd = null; // the project picked in the list; null = the open one
  let permGlobal = false; // "All projects" picked
  let permOpenAdd = null;
  let permError = null; // { kind, text }
  let permMenuOpen = false;

  const PERM_SECTIONS = [
    {
      kind: 'path', title: 'Protected files',
      desc: "The agent can't change, create or delete these, or run commands that name them.",
      placeholder: 'A folder, file or pattern: src/legacy, *.pem',
      suggestions: ['.env', '*.pem', '.git', 'migrations/**'],
      empty: 'Nothing protected.',
    },
    {
      kind: 'command', title: 'Blocked commands',
      desc: 'Never run. A match anywhere counts: "git push" also blocks "git push origin main".',
      placeholder: 'A command or part of one: git push',
      suggestions: ['git push --force', 'git reset --hard', 'npm publish', 'rm -rf'],
      empty: 'No commands blocked.',
    },
    {
      kind: 'sentinel', title: "Sentinel doesn't ask for",
      desc: 'In Sentinel, these go ahead without a question. Changing permissions and adding MCP servers are always asked.',
      picker: 'sentinel',
      empty: 'Sentinel asks about everything.',
    },
    {
      kind: 'mcpTool', title: 'Blocked MCP tools',
      desc: 'Never offered to the agent; the rest of the server keeps working.',
      picker: 'mcpTools',
      empty: 'No MCP tools blocked.',
    },
  ];

  async function permRender(payload) {
    const p = payload ?? (await window.mw.permissions(permCwd));
    const v = p.view;
    const proj = v.project.name;
    const scope = permGlobal ? 'global' : 'project';

    // ── the project list (same control as Rules & Skills) ──
    const options = [
      `<button class="rs-opt ${permGlobal ? 'active' : ''}" data-global="1">${RS_GLOBE}<span class="rs-n">All projects</span></button>`,
      '<div class="rs-opt-sep">Projects</div>',
      ...p.projects.map((x) => `
        <button class="rs-opt ${!permGlobal && x.cwd === v.project.cwd ? 'active' : ''}" data-cwd="${escapeHtml(x.cwd)}" title="${escapeHtml(x.cwd)}">
          ${RS_FOLDER}<span class="rs-n">${escapeHtml(x.name)}</span>${x.current ? '<span class="rs-open">Open</span>' : ''}
        </button>`),
    ].join('');

    // ── starting mode: one small switch ──
    const chosen = v.defaultMode[scope];
    const modeBtns = [
      ...(scope === 'project' ? [{ id: '', name: 'Same as all projects' }] : []),
      ...v.modes.map((m) => ({ id: m.id, name: m.name })),
    ].map((m) => {
      const on = scope === 'project' ? (chosen ?? '') === m.id : (chosen ?? 'lightning') === m.id;
      return `<button data-mode="${m.id}" class="${on ? 'active' : ''}">${escapeHtml(m.name)}</button>`;
    }).join('');
    const follows = v.modes.find((m) => m.id === (v.defaultMode.global ?? 'lightning'))?.name ?? 'Lightning';

    // ── the rule lists ──
    const sections = PERM_SECTIONS.map((sec) => {
      const mine = v.lists[sec.kind].filter((i) => i.scope === scope);
      const fromAll = scope === 'project' ? v.lists[sec.kind].filter((i) => i.scope === 'global') : [];
      const open = permOpenAdd === sec.kind;
      const taken = new Set(mine.map((i) => i.value));
      const choices = sec.picker ? v.choices[sec.picker].filter((c) => !taken.has(c.value)) : [];
      const name = (i) => (i.label && i.label !== i.value ? `${escapeHtml(i.label)} <span class="perm-sub mono">${escapeHtml(i.value)}</span>` : `<span class="mono">${escapeHtml(i.value)}</span>`);
      const rows = [
        ...mine.map((i) => `
          <div class="rs-row" data-value="${escapeHtml(i.value)}" data-scope="${i.scope}">
            <span class="rs-name">${name(i)}</span>
            <span class="rs-scope ${i.scope}">${i.scope === 'global' ? 'All projects' : projName(proj)}</span>
            <span class="rs-actions">
              <button class="rs-ib" data-act="move" title="${i.scope === 'global' ? `Move to ${escapeHtml(proj)}` : 'Move to all projects'}" aria-label="Move">${ICON_MOVE}</button>
              <button class="rs-ib danger" data-act="remove" title="Delete" aria-label="Delete">${ICON_TRASH}</button>
            </span>
          </div>`),
        ...fromAll.map((i) => `
          <div class="rs-row inherited" title="Set for all projects; change it under All projects">
            <span class="rs-name">${name(i)}</span>
            <span class="rs-scope global">All projects</span>
          </div>`),
      ].join('');
      const addRow = open ? `
        <div class="rs-new">
          ${sec.picker
            ? (choices.length
              ? `<select class="km-input perm-select" id="perm-add-${sec.kind}">${choices.map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`).join('')}</select>`
              : `<span class="rs-empty">${sec.kind === 'mcpTool' ? 'No MCP tools to pick from. Connect a server under MCP Servers first.' : 'Everything is already on this list.'}</span>`)
            : `<input type="text" class="km-input mono" id="perm-add-${sec.kind}" placeholder="${escapeHtml(sec.placeholder)}" spellcheck="false" autocomplete="off">`}
          ${!sec.picker || choices.length ? `<button class="settings-btn" data-add="${sec.kind}">Add</button>` : ''}
          ${sec.kind === 'path' ? '<button class="settings-btn ghost" data-pick="files">Files…</button><button class="settings-btn ghost" data-pick="folder">Folder…</button>' : ''}
          <button class="settings-btn ghost" data-cancel="${sec.kind}">Cancel</button>
        </div>
        ${sec.suggestions ? `<div class="perm-suggest">${sec.suggestions.filter((x) => !taken.has(x)).map((x) => `<button data-suggest="${escapeHtml(x)}" data-kind="${sec.kind}">${escapeHtml(x)}</button>`).join('')}</div>` : ''}` : '';
      return `
        <div class="perm-sec" data-kind="${sec.kind}">
          <div class="rs-group perm-head">${sec.title} <span class="rs-count">${mine.length + fromAll.length}</span>${open ? '' : `<button class="perm-addlink" data-open="${sec.kind}">+ Add</button>`}</div>
          <div class="rs-hint">${sec.desc}</div>
          ${permError && permError.kind === sec.kind ? `<div class="km-error">${escapeHtml(permError.text)}</div>` : ''}
          ${addRow}
          ${rows || `<div class="rs-empty">${sec.empty}</div>`}
        </div>`;
    }).join('');

    const grants = v.project.current && scope === 'project' ? [
      ...v.session.sentinel.map((g) => ({ kind: 'sentinel', value: g.value, text: g.label, what: 'Sentinel stopped asking' })),
      ...v.session.lifted.map((x) => ({ kind: 'lifted', value: x, text: x, what: 'Protection lifted' })),
      ...v.session.outsideDirs.map((d) => ({ kind: 'outside', value: d, text: d, what: 'Writing outside the project' })),
    ] : null;

    permRoot.innerHTML = `
      <div class="settings-section-title">Permissions</div>
      <div class="settings-section-desc">What the agent may and may not do, for one project or for all of them.</div>
      <div class="rs-bar">
        <span class="rs-to perm-show">Showing</span>
        <div class="rs-pick">
          <button class="rs-pick-btn" id="perm-pick-btn" aria-haspopup="listbox">
            ${permGlobal ? RS_GLOBE : RS_FOLDER}<span class="rs-n">${permGlobal ? 'All projects' : escapeHtml(proj)}</span>
            <svg class="chev" viewBox="0 0 10 10" fill="none"><path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="rs-menu perm-menu" role="listbox" ${permMenuOpen ? '' : 'hidden'}>${options}</div>
        </div>
      </div>
      <div class="rs-hint">${permGlobal ? 'These apply in every project, together with each project\'s own.' : `These apply in ${projName(proj)}. Rules for all projects apply too and are listed with their tag.`}</div>

      <div class="rs-group">Starting mode</div>
      <div class="rs-hint">${scope === 'project' ? `The mode ${projName(proj)} opens in. "Same as all projects" is ${escapeHtml(follows)} right now.` : 'The mode a project opens in, unless it has its own.'} You can still switch any time from the chat.</div>
      <div class="perm-mode">
        <div class="settings-seg" id="perm-mode">${modeBtns}</div>
      </div>

      ${sections}

      ${grants ? `
        <div class="rs-group">Allowed in this chat only <span class="rs-count">${grants.length}</span></div>
        <div class="rs-hint">Things you said yes to while the agent worked. They end with this chat.</div>
        ${grants.map((g) => `
          <div class="rs-row">
            <span class="rs-name">${escapeHtml(g.text)} <span class="perm-sub">${g.what}</span></span>
            <span class="rs-actions"><button data-revoke="${g.kind}" data-value="${escapeHtml(g.value)}">Take back</button></span>
          </div>`).join('') || '<div class="rs-empty">Nothing extra allowed in this chat.</div>'}` : ''}
    `;

    const act = async (action, args, kindForError) => {
      const next = await window.mw.permAction(action, { ...args, cwd: v.project.cwd });
      permError = next.result.ok ? null : { kind: kindForError, text: next.result.error };
      if (next.result.ok && action === 'add') permOpenAdd = null;
      permRender(next);
    };
    const redraw = () => permRender(p);

    permRoot.querySelector('#perm-pick-btn').addEventListener('click', (e) => { e.stopPropagation(); permMenuOpen = !permMenuOpen; redraw(); });
    permRoot.querySelectorAll('.perm-menu .rs-opt').forEach((o) => o.addEventListener('click', (e) => {
      e.stopPropagation();
      permMenuOpen = false; permOpenAdd = null; permError = null;
      if (o.dataset.global) { permGlobal = true; redraw(); return; }
      permGlobal = false; permCwd = o.dataset.cwd; permRender();
    }));
    permRoot.onclick = () => { if (permMenuOpen) { permMenuOpen = false; redraw(); } };
    permRoot.querySelectorAll('#perm-mode button').forEach((b) => b.addEventListener('click', () =>
      act('setMode', { scope, mode: b.dataset.mode || null }, null)));
    permRoot.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
      permOpenAdd = b.dataset.open; permError = null;
      permRender(p).then(() => permRoot.querySelector(`#perm-add-${b.dataset.open}`)?.focus());
    }));
    permRoot.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => { permOpenAdd = null; permError = null; redraw(); }));
    const addFrom = (kind, value) => act('add', { kind, value, scope }, kind);
    permRoot.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => addFrom(b.dataset.add, permRoot.querySelector(`#perm-add-${b.dataset.add}`).value)));
    permRoot.querySelectorAll('.rs-new input').forEach((i) => i.addEventListener('keydown', (e) => {
      const kind = i.id.replace('perm-add-', '');
      if (e.key === 'Enter') addFrom(kind, i.value);
      if (e.key === 'Escape') { e.stopPropagation(); permOpenAdd = null; permError = null; redraw(); }
    }));
    permRoot.querySelectorAll('[data-suggest]').forEach((b) => b.addEventListener('click', () => addFrom(b.dataset.kind, b.dataset.suggest)));
    // Files… / Folder…: the system picker, opened in the project; each pick is added.
    permRoot.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', async () => {
      const { paths, outside } = await window.mw.permPick(v.project.cwd, b.dataset.pick === 'folder');
      let last = null;
      const problems = [];
      for (const value of paths) {
        last = await window.mw.permAction('add', { kind: 'path', value, scope, cwd: v.project.cwd });
        if (!last.result.ok) problems.push(`${value}: ${last.result.error}`);
      }
      if (outside?.length) problems.push(`${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside ${proj}, so ${outside.length === 1 ? 'it' : 'they'} can't be protected here.`);
      permError = problems.length ? { kind: 'path', text: problems.join(' ') } : null;
      if (!problems.length && paths.length) permOpenAdd = null;
      if (last) permRender(last); else redraw();
    }));
    permRoot.querySelectorAll('.perm-sec .rs-row[data-value]').forEach((row) => {
      const kind = row.closest('.perm-sec').dataset.kind;
      const { value, scope: from } = row.dataset;
      row.querySelector('[data-act="move"]').addEventListener('click', () => act('move', { kind, value, scope: from }, kind));
      row.querySelector('[data-act="remove"]').addEventListener('click', () => act('remove', { kind, value, scope: from }, kind));
    });
    permRoot.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () =>
      act('revoke', { kind: b.dataset.revoke, value: b.dataset.value }, null)));
  }

  document.querySelectorAll('.settings-nav button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.panel === 'permissions') {
      permCwd = null; permGlobal = noProject; permOpenAdd = null; permError = null; permMenuOpen = false;
      permRender();
    }
  }));


  // ── Settings > Tokens > Context ────────────────────────────────────────
  // One tab for everything about consumption: what auto-compaction does now
  // (built), plus Spend and Limits, so the page never needs restructuring. "Apply to" is the same project-picker as
  // Rules & Skills: All projects edits the universal override, a specific
  // project edits that project's own. The banner always shows what's actually
  // in force for the picked project — project beats all-projects beats
  // Mindweave's own model-anchored default — so precedence is spelled out
  // rather than left for the user to infer.
  const usageRoot = document.getElementById('usage-root');
  let usageSubTab = 'context'; // 'context' | 'spend' | 'limits'
  let usageCwd = null; // project picked in the dropdown; null = the open one
  let usageGlobal = false; // "All projects" picked
  let usageMenuOpen = false;
  let usageCustomOpen = false;
  let usageError = null;
  let usageNote = null; // e.g. "Raised to 20K — that model's floor." after a silent clamp
  let spendCooldownUntil = 0; // Date.now() ms; Refresh stays dim until this passes
  const SPEND_COOLDOWN_MS = 8000;

  const fmtK = (n) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

  // Each tab covers a different thing (auto-compaction, spend, a cap) — the page-level
  // line just says the page holds three separate settings; the real explanation lives
  // under whichever tab is open, same place Spend/Limits' "coming soon" text already sat.
  const USAGE_TAB_DESC = {
    context: "How much of a conversation Mindweave keeps live before it summarizes older turns. Auto-compaction fires once you cross this number.",
    spend: "A day/week/month view of what you've spent, read from your own sessions on this computer and never sent anywhere.",
    limits: "Set how much you want to use in a month. It works out a 5-hour window and a weekly one from how you work, warns you as you near one, and holds off new steps when one is used up.",
  };

  async function usageRender(payload) {
    const p = payload ?? (await window.mw.ctxGet(usageCwd));
    const view = p.view;
    const target = p.projects.find((x) => x.cwd === (usageCwd ?? p.projects.find((y) => y.current)?.cwd)) ?? p.projects[0];
    const project = target?.name ?? 'Project';
    const scope = usageGlobal ? 'global' : 'project';
    const scopeValue = usageGlobal ? view.globalOverride : view.projectOverride;

    const tabs = `
      <div class="usage-tabs">
        <button class="usage-tab ${usageSubTab === 'context' ? 'active' : ''}" data-utab="context">Context</button>
        <button class="usage-tab ${usageSubTab === 'spend' ? 'active' : ''}" data-utab="spend">Spend</button>
        <button class="usage-tab ${usageSubTab === 'limits' ? 'active' : ''}" data-utab="limits">Limits</button>
      </div>`;

    if (usageSubTab === 'spend') { await renderSpendTab(p, tabs); return; }

    if (usageSubTab === 'limits') { await renderLimitsTab(p, tabs); return; }

    const options = [
      `<button class="rs-opt ${usageGlobal ? 'active' : ''}" data-global="1">${RS_GLOBE}<span class="rs-n">All projects</span></button>`,
      '<div class="rs-opt-sep">Projects</div>',
      ...p.projects.map((x) => `
        <button class="rs-opt ${!usageGlobal && x.cwd === target?.cwd ? 'active' : ''}" data-cwd="${escapeHtml(x.cwd)}" title="${escapeHtml(x.cwd)}">
          ${RS_FOLDER}<span class="rs-n">${escapeHtml(x.name)}</span>${x.current ? '<span class="rs-open">Open</span>' : ''}
        </button>`),
    ].join('');

    const sourceLabel =
      view.effective.source === 'project' ? `${escapeHtml(project)}'s own limit`
      : view.effective.source === 'global' ? 'your all-projects limit'
      : `Mindweave's default for ${escapeHtml(view.model)}`;

    const activePreset = scopeValue === null ? 'recommended' : view.presets.includes(scopeValue) ? String(scopeValue) : 'custom';
    const showCustomRow = usageCustomOpen || activePreset === 'custom';

    usageRoot.innerHTML = `
      <div class="settings-section-title">Tokens</div>
      <div class="settings-section-desc">Three separate things Mindweave tracks about how you're using it.</div>
      ${tabs}
      <div class="settings-section-desc usage-tab-desc">${USAGE_TAB_DESC.context}</div>

      <div class="usage-bar">
        <span class="rs-to">Apply to</span>
        <div class="rs-pick">
          <button class="rs-pick-btn" id="usage-pick-btn" aria-haspopup="listbox">
            ${usageGlobal ? RS_GLOBE : RS_FOLDER}<span class="rs-n">${usageGlobal ? 'All projects' : escapeHtml(project)}</span>
            <svg class="chev" viewBox="0 0 10 10" fill="none"><path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="rs-menu" role="listbox" ${usageMenuOpen ? '' : 'hidden'}>${options}</div>
        </div>
      </div>

      <div class="usage-banner">Compacts at <strong>${fmtK(view.effective.tokens)}</strong> — ${sourceLabel}</div>

      <div class="usage-reco">
        <div class="usage-reco-head">Recommended for ${escapeHtml(view.model)} <span class="usage-reco-live">(your current model)</span></div>
        <div class="usage-reco-note">${escapeHtml(view.recommendation.note)}</div>
      </div>

      <div class="settings-row">
        <div class="settings-row-label"><span class="t">Auto-compact at</span><span class="d">Editing ${usageGlobal ? 'the all-projects limit' : `${escapeHtml(project)}'s own limit`}</span></div>
        <div class="settings-seg usage-presets">
          <button data-preset="recommended" class="${activePreset === 'recommended' ? 'active' : ''}">Recommended</button>
          ${view.presets.map((n) => `<button data-preset="${n}" class="${activePreset === String(n) ? 'active' : ''}">${fmtK(n)}</button>`).join('')}
          <button data-preset="custom" class="${activePreset === 'custom' ? 'active' : ''}">Custom</button>
        </div>
      </div>
      ${showCustomRow ? `
      <div class="usage-custom-row">
        <div class="usage-custom-field">
          <input type="text" inputmode="numeric" pattern="[0-9]*" class="km-input" id="usage-custom-input" value="${activePreset === 'custom' && scopeValue ? scopeValue : ''}" placeholder="e.g. 250000" spellcheck="false" autocomplete="off">
          <span class="usage-custom-range">${fmtK(view.minTokens)}–${fmtK(view.recommendation.window)} tokens</span>
        </div>
        <button class="settings-btn" id="usage-custom-apply">Set</button>
      </div>` : ''}
      ${usageError ? `<div class="km-error">${escapeHtml(usageError)}</div>` : ''}
      ${usageNote ? `<div class="rs-notice">${escapeHtml(usageNote)}</div>` : ''}
    `;

    usageRoot.querySelectorAll('[data-utab]').forEach((b) => b.addEventListener('click', () => { usageSubTab = b.dataset.utab; usageRender(p); }));

    const cwd = target?.cwd;
    usageRoot.querySelector('#usage-pick-btn').addEventListener('click', (e) => { e.stopPropagation(); usageMenuOpen = !usageMenuOpen; usageRender(p); });
    usageRoot.querySelectorAll('.rs-opt').forEach((o) => o.addEventListener('click', (e) => {
      e.stopPropagation();
      usageMenuOpen = false; usageError = null; usageNote = null; usageCustomOpen = false;
      if (o.dataset.global) { usageGlobal = true; usageRender(p); return; }
      usageGlobal = false;
      usageCwd = o.dataset.cwd;
      usageRender();
    }));
    usageRoot.onclick = () => { if (usageMenuOpen) { usageMenuOpen = false; usageRender(p); } };

    const act = async (action, tokens) => {
      const next = await window.mw.ctxAction(action, { scope, tokens, cwd });
      usageError = next.result.ok ? null : next.result.error;
      usageNote = null;
      // The server clamps silently (a model's real window is a hard ceiling, its floor
      // is where compaction would fire almost every turn) — say so when it actually
      // changed what was typed, rather than let the number just look ignored.
      if (next.result.ok && action === 'set' && next.view.effective.tokens !== tokens) {
        const clampedUp = next.view.effective.tokens > tokens;
        usageNote = clampedUp
          ? `${fmtK(tokens)} is below what this model can safely run on — set to ${fmtK(next.view.effective.tokens)}, the floor.`
          : `${fmtK(tokens)} is more than this model's real window — set to ${fmtK(next.view.effective.tokens)}, its full window.`;
      }
      if (next.result.ok) usageCustomOpen = false;
      await usageRender(next);
    };
    usageRoot.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.preset;
      if (v === 'recommended') { act('reset'); return; }
      if (v === 'custom') { usageCustomOpen = true; usageError = null; usageNote = null; usageRender(p); return; }
      act('set', Number(v));
    }));
    // Digits only, live — typing a letter or symbol does nothing rather than being
    // accepted and rejected later, and the visible range (right next to the field)
    // is what stops "250" being mistaken for 250,000: the field itself says the scale.
    usageRoot.querySelector('#usage-custom-input')?.addEventListener('input', (e) => {
      const digits = e.target.value.replace(/[^0-9]/g, '');
      if (digits !== e.target.value) e.target.value = digits;
    });
    usageRoot.querySelector('#usage-custom-apply')?.addEventListener('click', () => {
      const n = Number(usageRoot.querySelector('#usage-custom-input').value);
      if (!Number.isFinite(n) || n <= 0) { usageError = 'Give a token count above zero.'; usageNote = null; usageRender(p); return; }
      act('set', n);
    });
    usageRoot.querySelector('#usage-custom-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') usageRoot.querySelector('#usage-custom-apply').click();
    });
  }

  // "8123 -> 8.1K", "1_200_000 -> 1.2M" — the CLI's own token shorthand (see
  // fmtLiveTokens above), extended with M since an all-time total can run that high.
  function fmtSpendTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 10_000) return `${Math.round(n / 1000)}K`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  }
  // The exact-current-period keys, computed the same way spendView.ts derives them
  // (UTC day / Monday-anchored week / UTC month) — so "today" means the actual
  // current bucket, never just whichever bucket happened to sort last.
  function spendDayKey(d) { return d.toISOString().slice(0, 10); }
  function spendMonthKey(d) { return d.toISOString().slice(0, 7); }
  function spendWeekKey(d) { const c = new Date(d); c.setUTCDate(c.getUTCDate() - ((c.getUTCDay() + 6) % 7)); return spendDayKey(c); }

  // ── Settings > Tokens > Spend ──────────────────────────────────────────
  // Read-only: what spendView.ts already computed from every session's own call log.
  // Nothing here edits anything — Limits (a cap you set) is a separate, still-unbuilt
  // tab, on purpose.
  async function renderSpendTab(p, tabs) {
    const [spend, providers] = await Promise.all([window.mw.spendGet(false), connectedProviders().catch(() => [])]);
    const labelFor = (id) => providers.flatMap((pr) => pr.models || []).find((m) => m.id === id)?.label || id;

    const now = new Date();
    const todayBilled = spend.daily.find((b) => b.key === spendDayKey(now))?.billed ?? 0;
    const weekBilled = spend.weekly.find((b) => b.key === spendWeekKey(now))?.billed ?? 0;
    const monthBilled = spend.monthly.find((b) => b.key === spendMonthKey(now))?.billed ?? 0;

    // No bar: a bar has a track with a visible end, which reads as "how full toward
    // a limit" — the wrong idea for a running total that has no ceiling. A share of
    // the total says the same relative-size thing without implying one.
    const totalForShare = Math.max(1, spend.totalBilled);
    const rows = spend.byModel
      .map((m) => `
        <div class="spend-row">
          <span class="spend-row-name">${escapeHtml(labelFor(m.model))}</span>
          <span class="spend-row-share">${Math.round((m.billed / totalForShare) * 100)}%</span>
          <span class="spend-row-num">${fmtSpendTokens(m.billed)}</span>
        </div>`)
      .join('');

    usageRoot.innerHTML = `
      <div class="settings-section-title">Tokens</div>
      <div class="settings-section-desc">Three separate things Mindweave tracks about how you're using it.</div>
      ${tabs}
      <div class="settings-section-desc usage-tab-desc">${USAGE_TAB_DESC.spend}</div>

      <div class="spend-total">
        <div class="spend-total-num">${fmtSpendTokens(spend.totalBilled)}</div>
        <div class="spend-total-label">
          tokens billed, across ${spend.projectsScanned} project${spend.projectsScanned === 1 ? '' : 's'}
          <button class="spend-refresh${Date.now() < spendCooldownUntil ? ' cooldown' : ''}" id="spend-refresh" title="Recompute now" ${Date.now() < spendCooldownUntil ? 'disabled' : ''}>
            <svg class="spend-refresh-ico" viewBox="0 0 14 14" fill="none"><path d="M11.5 7A4.5 4.5 0 1 1 10 3.8M11.5 2.5v3h-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <span class="spend-refresh-label">${Date.now() < spendCooldownUntil ? 'Refreshed' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      <div class="spend-trend">
        <div class="spend-trend-item"><span class="spend-trend-num">${fmtSpendTokens(todayBilled)}</span><span class="spend-trend-label">today</span></div>
        <div class="spend-trend-item"><span class="spend-trend-num">${fmtSpendTokens(weekBilled)}</span><span class="spend-trend-label">this week</span></div>
        <div class="spend-trend-item"><span class="spend-trend-num">${fmtSpendTokens(monthBilled)}</span><span class="spend-trend-label">this month</span></div>
      </div>

      <div class="settings-group">By model</div>
      ${spend.byModel.length ? `<div class="spend-list">${rows}</div>` : '<div class="usage-soon">Nothing recorded yet — this fills in as you use Mindweave.</div>'}
    `;
    usageRoot.querySelectorAll('[data-utab]').forEach((b) => b.addEventListener('click', () => { usageSubTab = b.dataset.utab; usageRender(p); }));

    const refreshBtn = usageRoot.querySelector('#spend-refresh');
    refreshBtn?.addEventListener('click', async () => {
      if (refreshBtn.disabled) return;
      refreshBtn.disabled = true;
      refreshBtn.classList.remove('cooldown');
      refreshBtn.classList.add('spinning');
      refreshBtn.querySelector('.spend-refresh-label').textContent = 'Refreshing…';
      const started = Date.now();
      await window.mw.spendGet(true);
      // A held spin, at least briefly, even when the recompute was instant (the cache
      // was already fresh) — a click that visibly did nothing reads as broken.
      const elapsed = Date.now() - started;
      if (elapsed < 500) await new Promise((r) => setTimeout(r, 500 - elapsed));
      spendCooldownUntil = Date.now() + SPEND_COOLDOWN_MS;
      if (usageSubTab === 'spend') await usageRender(p); // redraws with the fresh numbers, button starts its cooldown
    });
    // If the tab is just left open, the button should un-dim itself on schedule
    // rather than needing another click or a re-render to notice the cooldown passed.
    if (Date.now() < spendCooldownUntil) {
      setTimeout(() => { if (usageSubTab === 'spend') usageRender(p); }, spendCooldownUntil - Date.now() + 50);
    }
  }

  document.querySelectorAll('.settings-nav button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.panel === 'usage') {
      usageCwd = null; usageGlobal = noProject; usageMenuOpen = false; usageCustomOpen = false; usageError = null; usageNote = null;
      usageRender();
    }
    if (b.dataset.panel === 'about') renderAbout();
  }));

  // ── Settings > About ─────────────────────────────────────────────────
  // The running version (the same figure /feedback already reads), and, honestly, no update
  // check yet: this build has no publish channel to check against, so saying otherwise would
  // be a UI that lies. The moment one exists this is the one place that starts telling the truth.
  // ── What's new ───────────────────────────────────────────────────────
  // Updates and news from the signed feed (main.js fetches and checks it: see news/). Click an item
  // for its summary here in Settings; "More details" opens a bigger window with the technical side.
  const readStore = (k) => { try { return mwStore.getItem(k); } catch { return null; } };
  const WN_READ_KEY = 'mw:news-read'; // the old place; read once and moved to the main process
  // What the feed last delivered, already cleaned.
  let wnRemote = [];
  // An item whose update just finished stays on screen, saying so, until you go Back.
  let wnHold = null;
  const wnItems = () => (wnHold && !wnRemote.some((i) => i.id === wnHold.id) ? [wnHold, ...wnRemote] : wnRemote);
  // The unread number on the tab, and a dot on the Settings gear while anything is unread.
  function showUpdateDots() {
    const n = wnUnread();
    const wtab = document.querySelector('.settings-nav button[data-panel="whatsnew"]');
    wtab.querySelector('.nav-count')?.remove();
    if (n) wtab.insertAdjacentHTML('beforeend', '<span class="nav-count" aria-label="' + n + ' new">' + n + '</span>');
    const gear = document.getElementById('open-settings');
    gear.querySelector('.rdot')?.remove();
    gear.title = n ? 'Settings: something new' : 'Settings';
    if (n) gear.insertAdjacentHTML('beforeend', '<span class="rdot" aria-hidden="true"></span>');
  }
  // What has been read lives in the main process (feed-state.json), written at once; this is its copy.
  let wnReadIds = new Set();
  const wnReadSet = () => new Set(wnReadIds);
  function wnMarkAllRead(ids) {
    ids.forEach((i) => wnReadIds.add(i));
    void window.mw?.feedMarkRead?.(ids);
    showUpdateDots();
  }
  function wnUnread() {
    const read = wnReadSet();
    return wnItems().filter((i) => !read.has(i.id)).length;
  }
  function wnMarkRead(id) { wnMarkAllRead([id]); }
  const WN_AREA = { app: 'App update', core: 'Core update', cli: 'CLI update' };
  const wnKindLabel = (i) => (i.kind === 'update' ? WN_AREA[i.area] || 'Update' : 'News');
  // Only https pictures are ever shown.
  const wnImgOk = (src) => /^https:\/\//i.test(src) || /^data:image\//i.test(src);
  const wnFigures = (item) => (item.images || []).filter((im) => wnImgOk(im.src)).map((im) =>
    '<figure class="wn-fig"><img src="' + escapeHtml(im.src) + '" alt="' + escapeHtml(im.alt || '') + '">' +
    (im.caption ? '<figcaption>' + escapeHtml(im.caption) + '</figcaption>' : '') + '</figure>').join('');
  const wnPanel = document.getElementById('panel-whatsnew');
  let wnOpenId = null;
  let wnPendingOpen = null; // a page restored after a restart, opened once its item has loaded

  const WN_ICONS = {
    app: '<svg viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M2.5 6h11" stroke="currentColor" stroke-width="1.2"/></svg>',
    core: '<svg viewBox="0 0 16 16" fill="none"><rect x="4.5" y="4.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    cli: '<svg viewBox="0 0 16 16" fill="none"><rect x="2.5" y="3" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M5.3 6.6L7.3 8.3L5.3 10M8.8 10h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    update: '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.8" stroke="currentColor" stroke-width="1.2"/><path d="M8 11V5.5M5.7 7.6L8 5.3l2.3 2.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    news: '<svg viewBox="0 0 16 16" fill="none"><path d="M2.5 6.5v3h2l4.5 3v-9l-4.5 3h-2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M11.5 5.5a3.6 3.6 0 0 1 0 5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  };
  const WN_CHEV = '<svg class="wn-chev" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  let wnFilter = 'all'; // all | update | news

  // A result from the main process: keep it, and redraw if this page is showing.
  function wnApply(r) {
    if (!r) return;
    wnRemote = (r.items || []).map((i) => ({ ...i, remote: true }));
    (r.read || []).forEach((i) => wnReadIds.add(i));
    // Anything marked read before this moved to the main process comes along once.
    try {
      const old = JSON.parse(mwStore.getItem(WN_READ_KEY) || 'null');
      if (Array.isArray(old)) { wnMarkAllRead(old.filter((x) => typeof x === 'string')); mwStore.removeItem(WN_READ_KEY); }
    } catch { /* nothing to move */ }
    if (wnPendingOpen && wnItems().some((i) => i.id === wnPendingOpen)) { wnOpenId = wnPendingOpen; wnPendingOpen = null; }
    showUpdateDots();
    if (typeof refreshUpdateChip === 'function') refreshUpdateChip();
    if (typeof renderAboutVersions === 'function' && aboutInfo && document.getElementById('panel-about').classList.contains('active')) renderAboutVersions();
    if (wnPanel.classList.contains('active')) renderWhatsNew();
  }
  // Rows fade in only when the page is opened (the tab, or Back from an item). A redraw from the switch,
  // a filter or a feed update leaves them still.
  function renderWhatsNew(enter = false) {
    if (!wnOpenId) wnHold = null;
    const items = wnItems();
    const item = items.find((i) => i.id === wnOpenId);
    if (item) return renderWnSummary(item);
    if (!wnPendingOpen) wnOpenId = null;
    const read = wnReadSet();
    const unread = items.filter((i) => !read.has(i.id)).length;
    const count = (k) => (k === 'all' ? items.length : items.filter((i) => i.kind === k).length);
    const shown = items.filter((i) => wnFilter === 'all' || i.kind === wnFilter);
    let html = '<div class="wn-head"><div><div class="settings-section-title">What’s new</div>' +
      '<div class="settings-section-desc">News, updates and fixes for mwcode and Mindweave. ' + (unread ? unread + ' new since you last looked.' : 'You are all caught up.') + '</div></div>' +
      (unread ? '<button class="settings-btn wn-readall">Mark all as read</button>' : '') + '</div>';
    if (items.length) {
      html += '<div class="wn-bar"><div class="settings-seg wn-filter">' + [['all', 'All'], ['update', 'Updates'], ['news', 'News']].map(([k, label]) =>
        '<button data-f="' + k + '" class="' + (wnFilter === k ? 'active' : '') + '">' + label + '<span class="wn-count">' + count(k) + '</span></button>').join('') + '</div></div>';
    }
    if (!items.length) html += '<div class="wn-empty">Nothing new right now.</div>';
    else if (!shown.length) html += '<div class="wn-empty">Nothing here yet.</div>';
    else {
      html += '<div class="wn-list">' + shown.map((i, n) => (
        '<button class="wn-card' + (enter ? ' wn-enter' : '') + '" style="--i:' + n + '" data-id="' + escapeHtml(i.id) + '">' +
          '<span class="wn-main">' +
            '<span class="wn-card-top"><span class="wn-title">' + escapeHtml(i.title) + '</span></span>' +
            '<span class="wn-desc">' + escapeHtml(i.summary) + '</span>' +
          '</span>' +
          '<span class="wn-side">' + (read.has(i.id) ? '' : '<span class="wn-new"><span class="wn-dot" aria-hidden="true"></span>New</span>') + '<span class="wn-meta"><span class="wn-ico">' + WN_ICONS[i.kind === 'update' ? (i.area || 'app') : 'news'] + '</span>' + wnKindLabel(i) + ' · ' + escapeHtml(i.date) + '</span>' + WN_CHEV + '</span>' +
        '</button>'
      )).join('') + '</div>';
    }
    wnPanel.innerHTML = html;
    wnPanel.querySelectorAll('.wn-filter button').forEach((f) => f.addEventListener('click', () => { wnFilter = f.dataset.f; renderWhatsNew(); }));
    wnPanel.querySelector('.wn-readall')?.addEventListener('click', () => {
      wnMarkAllRead(items.map((i) => i.id));
      renderWhatsNew();
    });
    wnPanel.querySelectorAll('.wn-card').forEach((c) => c.addEventListener('click', () => {
      wnOpenId = c.dataset.id;
      wnMarkRead(wnOpenId);
      renderWhatsNew();
    }));
  }

  // Where an item's buttons go: the ones the post names, else the obvious place for its kind. The core and
  // the CLI live in the Mindweave repo, the app in its own; an announcement points to the project's usual
  // places (as on About).
  const MW_GITHUB = { label: 'GitHub', url: 'https://github.com/mindweave-cli/mindweave' };
  const APP_GITHUB = { label: 'GitHub', url: 'https://github.com/mindweave-cli/mwcode' };
  const MW_SOCIAL = [{ label: 'Website', url: 'https://mindweavedev.netlify.app/' }, MW_GITHUB, { label: 'X', url: 'https://x.com/mindweavecli' }];
  function wnLinks(item) {
    if (item.links?.length) return item.links;
    if (item.kind === 'update') return item.area === 'core' || item.area === 'cli' ? [MW_GITHUB] : item.area === 'app' ? [APP_GITHUB] : [];
    return MW_SOCIAL;
  }
  function renderWnSummary(item) {
    // Looking at an item is reading it, however the page was reached (a click, or coming back after a restart).
    if (!wnReadSet().has(item.id)) wnMarkRead(item.id);
    wnPanel.innerHTML =
      '<button class="settings-btn wn-back">' + BACK_SVG + 'Back</button>' +
      '<div class="wn-sum-title">' + escapeHtml(item.title) + '</div>' +
      '<div class="wn-sum-meta">' + wnKindLabel(item) + ' · ' + escapeHtml(item.date) + '</div>' +
      '<div class="wn-sum-text">' + escapeHtml(item.summary) + '</div>' +
      wnFigures(item) +
      '<ul class="wn-points">' + item.points.map((p) => '<li>' + escapeHtml(p) + '</li>').join('') + '</ul>' +
      (item.sections || []).map((sec) => (
        '<div class="settings-group">' + escapeHtml(sec.h) + '</div>' +
        (sec.text ? '<div class="wn-sum-text wn-sec-text">' + escapeHtml(sec.text) + '</div>' : '') +
        (sec.list ? '<ul class="wn-points">' + sec.list.map((p) => '<li>' + escapeHtml(p) + '</li>').join('') + '</ul>' : '')
      )).join('') +
      '<div class="wn-actions">' +
        (item._done ? '<div class="wn-sum-text wn-sec-text">Updated to ' + escapeHtml(item._done) + '. The command line is up to date.</div>' : '') +
        (item.remote && item.kind === 'update' && item.area === 'cli' && aboutInfo?.cliCanUpdate && !item._done ? '<button class="settings-btn wn-cliupd"' + (item._busy ? ' disabled>Updating…' : '>Update now') + '</button>' : '') +
        (cliErr && item.area === 'cli' && !item._done ? '<div class="wn-sum-text wn-sec-text">The update did not finish: ' + escapeHtml(cliErr) + '</div>' : '') +
        (item.remote && item.kind === 'update' && item.link && !item._done && !(item.area === 'cli' && aboutInfo?.cliCanUpdate) ? '<button class="settings-btn wn-get">' + (item.version ? 'Get ' + escapeHtml(item.version) : 'Open the release') + '</button>' : '') +
        (item.command ? '<button class="settings-btn wn-copy">Copy update command</button>' : '') +
        wnLinks(item).map((l, n) => '<button class="settings-btn wn-out" data-n="' + n + '">' + escapeHtml(l.label) + ' <span class="wn-arrow">\u2197</span></button>').join('') +
      '</div>';
    wnPanel.scrollTop = 0;
    wnPanel.querySelector('.wn-back').addEventListener('click', () => { wnOpenId = null; wnHold = null; renderWhatsNew(true); });
    const outs = wnLinks(item);
    wnPanel.querySelectorAll('.wn-out').forEach((b) => b.addEventListener('click', () => window.mw.openExternal(outs[Number(b.dataset.n)].url)));
    wnPanel.querySelector('.wn-get')?.addEventListener('click', () => window.mw.openExternal(item.link.url));
    wnPanel.querySelector('.wn-cliupd')?.addEventListener('click', (e) => { e.currentTarget.disabled = true; e.currentTarget.textContent = 'Updating…'; runCliUpdate(item); });
    wnPanel.querySelector('.wn-copy')?.addEventListener('click', (e) => {
      navigator.clipboard?.writeText(item.command).then(() => { e.currentTarget.textContent = 'Copied'; setTimeout(() => { const b = wnPanel.querySelector('.wn-copy'); if (b) b.textContent = 'Copy update command'; }, 1600); }).catch(() => {});
    });
  }

  document.querySelector('.settings-nav button[data-panel="whatsnew"]').addEventListener('click', () => { wnOpenId = null; renderWhatsNew(true); });
  // ── Coming back after a restart ─────────────────────────────────────────
  // Whatever you left open is where you land: Settings on the same page (and What's new on the same
  // item). The project, session, sidebar, switches, window place and half-typed message come back on their own.
  const UI_KEY = 'mw:ui:v1';
  function saveUi() {
    const panel = document.querySelector('.settings-nav button.active')?.dataset.panel || 'general';
    try {
      mwStore.setItem(UI_KEY, JSON.stringify({ settingsOpen: !settingsOverlay.hidden, panel, wn: wnOpenId || wnPendingOpen, wnFilter, usageTab: usageSubTab }));
    } catch { /* not remembered */ }
  }
  new MutationObserver(saveUi).observe(settingsOverlay, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('click', () => setTimeout(saveUi, 0), true); // any tab, filter or page change
  window.addEventListener('pagehide', saveUi);
  function restoreUi() {
    let ui = null;
    try { ui = JSON.parse(mwStore.getItem(UI_KEY) || 'null'); } catch { /* none */ }
    if (ui?.settingsOpen) {
      if (['context', 'spend', 'limits'].includes(ui.usageTab)) usageSubTab = ui.usageTab;
      if (['all', 'update', 'news'].includes(ui.wnFilter)) wnFilter = ui.wnFilter;
      document.getElementById('open-settings').click();
      document.querySelector('.settings-nav button[data-panel="' + CSS.escape(String(ui.panel)) + '"]')?.click();
      if (ui.panel === 'whatsnew' && typeof ui.wn === 'string') {
        wnPendingOpen = ui.wn;
        if (wnItems().some((i) => i.id === ui.wn)) { wnOpenId = ui.wn; wnPendingOpen = null; }
        renderWhatsNew();
      }
    }
  }
  // Everything above is defined by the time the page has finished loading. (A half-typed message,
  // with its attachments, is kept per project by the main process: draft:get / draft:set.)
  setTimeout(restoreUi, 400);

  window.mw?.feedGet?.().then(wnApply).catch(() => {});
  window.mw?.onFeedUpdated?.(wnApply);
  showUpdateDots();

  // ── Settings > About: the versions, and an update when there is one ─────────────────
  // Three chips: App, Core, CLI. An update comes from the signed feed (an "update" item newer than
  // what is installed). One update: its chip turns into a shimmering "Update now". Two or more: the
  // chips stay and an "Update all" button appears. Pressing either turns the whole row into one
  // progress button, then "Restart to update"; after the restart the row is back to plain chips.
  //
  // MOCKUP: nothing installs yet (no packaged app, no updater). the stored value 'mw:mock-updates' set to
  // a list like "cli" or "app,cli" pretends those are out and walks through a fake download; without
  // it, a real update item's button opens its release page. The real installer plugs in at startUpdate().
  const MOCK_UPDATES_KEY = 'mw:mock-updates';
  const MOCK_INSTALLED_KEY = 'mw:mock-installed';
  const AREA_LABEL = { app: 'App', core: 'Core', cli: 'CLI' };
  let aboutInfo = null;
  let updUi = { state: 'idle', pct: 0, areas: [] }; // state: idle | busy | ready
  const verCmp = (x, y) => { const p = String(x).split('.').map(Number), q = String(y).split('.').map(Number); for (let i = 0; i < 3; i++) if ((p[i] || 0) !== (q[i] || 0)) return (p[i] || 0) < (q[i] || 0) ? -1 : 1; return 0; };
  const verBump = (v) => { const p = String(v).split('.').map(Number); return (p[0] || 0) + '.' + ((p[1] || 0) + 1) + '.0'; };
  function installedVersions() {
    if (!aboutInfo) return null;
    let mockInstalled = {};
    try { mockInstalled = JSON.parse(readStore(MOCK_INSTALLED_KEY) || '{}'); } catch { /* none */ }
    return { app: aboutInfo.appVersion, core: aboutInfo.coreVersion || aboutInfo.version, cli: aboutInfo.cliVersion || aboutInfo.version, ...mockInstalled };
  }
  // [{ area, from, to, link? }] for each part that has a newer version out.
  function pendingUpdates() {
    const have = installedVersions();
    if (!have) return [];
    const mock = (readStore(MOCK_UPDATES_KEY) || '').split(',').map((x) => x.trim()).filter((x) => AREA_LABEL[x]);
    if (mock.length) return mock.map((area) => ({ area, from: have[area], to: verBump(have[area]), mock: true }));
    // The app's own update, from the updater in the main process (signed, checked, installs itself).
    // The core and the command line travel inside the app, so this one update covers all three.
    const real = realUpd && realUpd.version && ['available', 'downloading', 'ready', 'error'].includes(realUpd.status)
      ? [{ area: 'app', from: have.app, to: realUpd.version, real: true, manual: realUpd.mode === 'manual', link: { url: realUpd.manualUrl } }]
      : [];
    const best = {};
    for (const it of wnRemote) {
      if (it.kind !== 'update' || !it.version || !AREA_LABEL[it.area]) continue;
      if (it.area === 'app' && realUpd && realUpd.mode !== 'none') continue; // the updater owns the app's update
      // The app's own terminal copy moves with the app's update, so a notice about it would be noise.
      if (it.area === 'cli' && (aboutInfo.cliSource === 'bundled' || aboutInfo.cliSource === 'none')) continue;
      if (!best[it.area] || verCmp(it.version, best[it.area].version) > 0) best[it.area] = it;
    }
    return [...real, ...Object.values(best).filter((it) => !have[it.area] || verCmp(it.version, have[it.area]) > 0)
      .map((it) => ({ area: it.area, from: have[it.area], to: it.version, link: it.link, ...(it.area === 'cli' && aboutInfo.cliCanUpdate ? { inApp: true } : {}) }))];
  }

  // What the updater in the main process reports (see updater/): the signed check, the download and
  // its progress. null until the first answer, and { mode: 'none' } for a copy that is not installed.
  let realUpd = null;
  function applyRealUpdate(s) {
    if (!s) return;
    realUpd = s;
    if (s.status === 'downloading') updUi = { state: 'busy', pct: s.pct || 0, areas: [{ area: 'app', to: s.version, real: true }] };
    else if (s.status === 'ready') updUi = { state: 'ready', pct: 100, areas: [{ area: 'app', to: s.version, real: true }] };
    else if (updUi.areas.some((u) => u.real)) updUi = { state: 'idle', pct: 0, areas: [] };
    if (typeof renderAboutVersions === 'function') renderAboutVersions();
    refreshUpdateChip();
  }
  window.mw?.updateGet?.().then(applyRealUpdate).catch(() => {});
  window.mw?.onUpdateChanged?.(applyRealUpdate);

  // The box in the top row, next to Run: shows when any update is out, and takes you to About.
  function refreshUpdateChip() {
    const chip = document.getElementById('tb-update');
    if (!chip) return;
    const pending = pendingUpdates();
    chip.hidden = !(pending.length || updUi.state !== 'idle');
    chip.textContent = updUi.state === 'ready' ? 'Restart to update' : updUi.state === 'busy' ? 'Updating\u2026' : 'Update available';
    chip.title = pending.length ? pending.map((u) => AREA_LABEL[u.area] + ' ' + u.to).join(', ') + ' available' : 'Update';
  }
  // macOS: Settings > About > Command line puts mw and mindweave on the Terminal's PATH (main.js).
  const aboutCli = document.getElementById('about-cli');
  const aboutCliDesc = document.getElementById('about-cli-desc');
  const aboutCliBtn = document.getElementById('about-cli-btn');
  function renderCli(state, error) {
    if (!aboutCli || !state) return;
    aboutCli.hidden = false;
    aboutCliBtn.hidden = state.installed;
    aboutCliDesc.textContent = error || (state.installed
      ? 'Added: type mw in the Terminal'
      : state.temporary ? 'Move mwcode to Applications first, then open it from there' : 'Use mwcode in the Terminal as mw');
  }
  if (window.mw?.platform === 'darwin') window.mw.cliState?.().then((s) => renderCli(s));
  aboutCliBtn?.addEventListener('click', async () => {
    aboutCliBtn.disabled = true;
    const r = await window.mw.cliInstall();
    aboutCliBtn.disabled = false;
    renderCli(r?.state, r?.error);
  });

  document.getElementById('tb-update')?.addEventListener('click', () => {
    settingsOverlay.hidden = false;
    document.querySelector('.settings-nav button[data-panel="about"]')?.click();
  });

  function renderAboutVersions() {
    refreshUpdateChip();
    const row = document.getElementById('about-versions');
    const note = document.getElementById('about-version-note');
    const have = installedVersions();
    if (!row || !have) return;
    const pending = pendingUpdates();
    const plain = note.dataset.plain || (note.dataset.plain = note.textContent);
    const chip = (area, extra = '', tag = 'div') => '<' + tag + ' class="about-version' + (extra ? ' ' + extra : '') + '"' + (tag === 'button' ? ' data-update="' + area + '"' : '') + '>' +
      '<span class="av-k">' + AREA_LABEL[area] + '</span>' + escapeHtml(have[area] || 'unknown') + '</' + tag + '>';

    if (updUi.state === 'busy') {
      row.innerHTML = '<button class="settings-btn au-btn" disabled><span>Updating</span><span class="au-bar"><i style="width:' + updUi.pct + '%"></i></span></button>';
      note.textContent = updUi.areas.some((u) => u.cli) ? 'Updating the command line with npm. This takes a moment.' : 'Downloading. Your sessions, settings and keys stay as they are.';
      return;
    }
    if (updUi.state === 'ready') {
      row.innerHTML = '<button class="settings-btn au-btn on" id="au-restart">Restart to update</button>';
      note.textContent = 'Ready. Restart to finish; the app reopens where you left off.';
      row.querySelector('#au-restart').addEventListener('click', restartToUpdate);
      return;
    }
    if (pending.length === 1) {
      const u = pending[0];
      row.innerHTML = ['app', 'core', 'cli'].map((a) => (a === u.area
        ? '<button class="about-version has-update" data-update="' + a + '" title="' + AREA_LABEL[a] + ' ' + escapeHtml(u.to) + '"><span class="av-k">' + AREA_LABEL[a] + '</span>' + escapeHtml(have[a] || 'unknown') + '<span class="av-new">New update available. Update now</span></button>'
        : chip(a))).join('');
      note.textContent = AREA_LABEL[u.area] + ' ' + u.to + ' is out. Updating keeps your sessions, settings and keys.';
    } else if (pending.length > 1) {
      row.innerHTML = ['app', 'core', 'cli'].map((a) => chip(a, pending.some((u) => u.area === a) ? 'pending' : '')).join('') +
        '<button class="settings-btn has-update" id="au-all">Update all</button>';
      note.textContent = pending.map((u) => AREA_LABEL[u.area] + ' ' + u.to).join(', ') + ' are out. Updating keeps your sessions, settings and keys.';
    } else {
      row.innerHTML = chip('app') + chip('core') + chip('cli');
      note.textContent = plain;
    }
    if (cliErr && pending.some((u) => u.area === 'cli')) note.textContent = 'The update did not finish: ' + cliErr;
    else if (realUpd?.error && pending.some((u) => u.real)) note.textContent = 'The update did not finish: ' + realUpd.error + '. Nothing was changed. Press the button to try again.';
    else if (realUpd?.mode === 'manual' && pending.some((u) => u.real)) note.textContent = (realUpd.reason || 'This copy cannot update itself.') + ' The button opens the download.';
    row.querySelector('.has-update[data-update]')?.addEventListener('click', () => startUpdate(pending));
    row.querySelector('#au-all')?.addEventListener('click', () => startUpdate(pending));
  }

  // The one place a real installer goes. Today: the pretend download for the mockup, and for a real
  // update item, its release page.
  function startUpdate(pending) {
    const real = pending.find((u) => u.real);
    if (real) {
      // Installs itself where it can; otherwise the release page opens (a .deb, a read-only folder...).
      if (real.manual) window.mw.openExternal(real.link.url);
      else window.mw.updateStart();
      return;
    }
    if (pending.some((u) => u.inApp)) { runCliUpdate(); return; }
    if (!pending.every((u) => u.mock)) {
      const link = pending.find((u) => u.link)?.link;
      if (link) window.mw.openExternal(link.url);
      return;
    }
    updUi = { state: 'busy', pct: 0, areas: pending };
    renderAboutVersions();
    const tick = setInterval(() => {
      updUi.pct = Math.min(100, updUi.pct + 9 + Math.random() * 14);
      if (updUi.pct >= 100) { clearInterval(tick); updUi.state = 'ready'; }
      renderAboutVersions();
    }, 260);
  }
  // The npm-installed terminal version, updated by the app (main.js runs npm with fixed arguments).
  let cliErr = null;
  let cliRunning = null;
  function runCliUpdate(item) {
    if (cliRunning) return cliRunning;
    cliErr = null;
    wnHold = item ? { ...item, _busy: true } : null;
    updUi = { state: 'busy', pct: 0, areas: [{ area: 'cli', cli: true }] };
    const tick = setInterval(() => { updUi.pct = Math.min(92, updUi.pct + 3); renderAboutVersions(); }, 400);
    renderAboutVersions();
    cliRunning = window.mw.cliUpdate().catch((e) => ({ ok: false, error: String(e?.message || e) })).then(async (r) => {
      clearInterval(tick);
      updUi = { state: 'idle', pct: 0, areas: [] };
      if (r.ok) {
        wnHold = item ? { ...item, _done: r.version } : null;
        aboutInfo = { ...aboutInfo, ...(await window.mw.feedbackInfo().catch(() => ({}))) };
      } else { wnHold = null; cliErr = r.error || 'It did not finish.'; }
      cliRunning = null;
      renderAboutVersions();
      showUpdateDots();
      if (wnPanel.classList.contains('active')) renderWhatsNew();
      return r;
    });
    return cliRunning;
  }
  // Mockup only: "restarting" applies the new versions and puts the row back to plain chips.
  function restartToUpdate() {
    if (updUi.areas.some((u) => u.real)) { window.mw.updateRestart(); return; }
    const done = updUi.areas;
    let installed = {};
    try { installed = JSON.parse(readStore(MOCK_INSTALLED_KEY) || '{}'); } catch { /* none */ }
    done.forEach((u) => { installed[u.area] = u.to; });
    const left = (readStore(MOCK_UPDATES_KEY) || '').split(',').filter((a) => a && !done.some((u) => u.area === a));
    try {
      mwStore.setItem(MOCK_INSTALLED_KEY, JSON.stringify(installed));
      if (left.length) mwStore.setItem(MOCK_UPDATES_KEY, left.join(',')); else mwStore.removeItem(MOCK_UPDATES_KEY);
    } catch { /* not remembered */ }
    updUi = { state: 'idle', pct: 0, areas: [] };
    renderAboutVersions();
  }

  // The versions are needed at startup too, for the box in the top row.
  window.mw?.feedbackInfo?.().then((info) => { aboutInfo = info || {}; refreshUpdateChip(); }).catch(() => {});

  let aboutLoaded = false;
  function renderAbout() {
    if (aboutInfo) renderAboutVersions();
    if (aboutLoaded) return;
    aboutLoaded = true;
    window.mw?.feedbackInfo?.().then((info) => { aboutInfo = info || {}; renderAboutVersions(); }).catch(() => {});
    document.querySelectorAll('#panel-about .about-inline-link, #panel-about .pd-link').forEach((b) => {
      b.addEventListener('click', () => window.mw.openExternal(b.dataset.url));
    });
  }


  // ── Settings > Tokens > Limits ─────────────────────────────────────────
  // Two states. With a limit ON, the tab is a summary: the bars, what is set, and two buttons
  // (change the monthly amount, or go back to unlimited). With it OFF, or while editing, it is
  // the setup: you set the month, Analyze works out a 5-hour window and a weekly one from how you
  // actually use the tool, and both stay editable. The rules (when a window opens, what holds work
  // back) live in the core (dynamo/usageLimits.ts): this only shows them and sends changes back.
  let limDraft = null; // what the fields hold right now, until Save
  let limEditing = false; // changing the numbers of a limit that is already on
  let limNote = null; // the reasoning Analyze gave
  let limError = null;
  let limSaved = null;
  let limScaleOpen = null; // which amount's unit menu is open: 'monthly' | 'five' | 'week'

  const LIM_SCALES = [
    { v: 1e3, name: 'Thousands', short: 'K' },
    { v: 1e6, name: 'Millions', short: 'M' },
    { v: 1e9, name: 'Billions', short: 'B' },
  ];
  const limScaleOf = (v) => LIM_SCALES.find((s) => s.v === v) || LIM_SCALES[1];

  // A stored amount as what a person types: 3000000 -> { num: '3', scale: 1e6 }, 105000 -> 105 thousand.
  function limAmountFrom(n, fallbackScale) {
    if (!n) return { num: '', scale: fallbackScale };
    const scale = n >= 1e9 ? 1e9 : n >= 1e6 ? 1e6 : 1e3;
    return { num: String(Math.round((n / scale) * 1000) / 1000), scale };
  }

  const limDraftFrom = (c) => ({
    monthly: limAmountFrom(c.monthly, 1e6),
    monthStartDay: String(c.monthStartDay || 1),
    fiveHour: limAmountFrom(c.fiveHour, 1e3),
    weekly: limAmountFrom(c.weekly, 1e3),
    enforce: c.enforce !== false,
    analyzedAt: c.analyzedAt,
  });

  // The tokens an amount stands for: 0 when empty, NaN when it is not a number.
  function limTokens(a) {
    const t = String(a.num ?? '').trim();
    if (!t) return 0;
    if (!/^(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
    return Math.round(Number(t) * a.scale);
  }

  // "3 million tokens = 3,000,000": said back as you type, so a bare "100" cannot be mistaken for 100 tokens.
  function limReadback(a) {
    const n = limTokens(a);
    if (!n || Number.isNaN(n)) return '';
    return `${a.num} ${limScaleOf(a.scale).name.toLowerCase()} = ${n.toLocaleString('en-US')} tokens`;
  }

  const limNoTokens = (s) => String(s).replace(/ tokens$/, '');

  // One row per window, laid out the way a plan's usage page does it: what it is and when it
  // resets on the left, the bar in the middle, how much of it is used on the right, and the
  // amount itself underneath.
  function limBarsHtml(v) {
    if (!v.config.enabled) return '';
    if (!v.lines.length) return '';
    return v.lines.map((l) => {
      const w = v.status.windows.find((x) => x.id === l.id);
      const pctText = Math.round((w.fraction || 0) * 100);
      const barPct = Math.max(0, Math.min(100, pctText));
      const name = l.id === 'fiveHour' ? '5-hour window' : l.id === 'weekly' ? 'This week' : 'This month';
      const reset = w.state === 'idle'
        ? (l.id === 'monthly' ? '' : 'Not started. Opens with your next message.')
        : (w.state === 'blocked' ? `Used up. ${l.opens.charAt(0).toUpperCase() + l.opens.slice(1)}` : l.opens.charAt(0).toUpperCase() + l.opens.slice(1));
      return `
        <div class="lim-row ${w.state}">
          <div class="lim-name">${name}</div>
          <div class="lim-track"><div class="lim-fill" style="width:${barPct}%"></div></div>
          <div class="lim-pct">${pctText}% used</div>
          <div class="lim-reset">${escapeHtml(reset)}</div>
          <div class="lim-amount">${escapeHtml(limNoTokens(l.used))} of ${escapeHtml(l.limit)}</div>
        </div>`;
    }).join('');
  }

  // ── The limit meter (chat header) ────────────────────────────────────────
  // Shown ONLY while usage limits are on, and then always: it is the one place the 5-hour window is
  // visible while you work. The bar fills through green, then orange, then red as the window is used,
  // with a short line saying what that means for the work in hand. It reads the same numbers the
  // Limits tab does, so the two cannot disagree. With no 5-hour amount set it follows whichever
  // window is fullest instead.
  const limitMeter = document.getElementById('limit-meter');
  const lmFill = document.getElementById('lm-fill');
  const lmMsg = document.getElementById('lm-msg');
  const lmPct = document.getElementById('lm-pct');
  const lmTip = document.getElementById('lm-tip');

  // What the fill level means for the work, in a few words. Steps are by how full the window is.
  function limitMessage(w, opens) {
    if (w.state === 'idle') return 'The window opens with your next message';
    const f = w.fraction || 0;
    if (f >= 1) return `Limit reached. ${opens}`;
    if (f < 0.35) return 'Plenty of room to work';
    if (f < 0.55) return 'Room to keep going';
    if (f < 0.75) return "Past halfway. Let's finish what we have before it hits.";
    if (f < 0.9) return 'Getting close. Time to wrap things up.';
    return 'Almost full. Wrap up and save your work.';
  }

  async function refreshLimitMeter() {
    if (!limitMeter || !window.mw?.limitsGet) return;
    let v;
    try { v = await window.mw.limitsGet(false); } catch { return; }
    const wins = v?.status?.windows || [];
    // Not set, or nothing to show: no meter at all.
    if (!v?.config?.enabled || !wins.length) { limitMeter.hidden = true; return; }
    const w = wins.find((x) => x.id === 'fiveHour') || wins.reduce((a, b) => ((b.fraction || 0) > (a.fraction || 0) ? b : a));
    const line = v.lines.find((l) => l.id === w.id);
    const f = Math.max(0, Math.min(1, w.fraction || 0));
    const pct = Math.round((w.fraction || 0) * 100);
    const opens = line?.opens ? line.opens.charAt(0).toUpperCase() + line.opens.slice(1) : '';
    limitMeter.hidden = false;
    limitMeter.dataset.state = f >= 1 ? 'full' : f >= 0.9 ? 'red' : f >= 0.55 ? 'orange' : 'green';
    lmFill.style.width = `${f * 100}%`;
    // The colours belong to the TRACK, not the fill: the fill only reveals as much of it as is used, so
    // green is always the first stretch, then orange, and red is always the very end.
    lmFill.style.backgroundSize = f > 0 ? `${100 / f}% 100%` : '100% 100%';
    lmPct.textContent = `${pct}%`;
    lmMsg.textContent = limitMessage(w, opens);
    const name = w.id === 'fiveHour' ? '5-hour window' : w.id === 'weekly' ? 'This week' : 'This month';
    lmTip.innerHTML = `
      <div class="lm-tip-head"><span>${name}</span><b>${pct}% used</b></div>
      <div class="lm-tip-num">${escapeHtml(limNoTokens(line?.used || ''))} of ${escapeHtml(line?.limit || '')}</div>
      ${opens ? `<div class="lm-tip-note">${escapeHtml(w.state === 'blocked' ? opens : opens.replace(/^Resets/, 'Resets'))}</div>` : ''}`;
  }
  // A window can end, and the day can turn, while nothing is happening: look again now and then.
  setInterval(() => { void refreshLimitMeter(); }, 30000);

  const LIM_DISCLAIMER = 'The token count is almost accurate, but it can be off at times. It is worked out from what each provider reports for your calls, and providers report things a little differently, so a call or an older session may be counted slightly high or low. We keep working to make it as accurate as possible.';
  const LIM_CHEV = '<svg class="chev" viewBox="0 0 10 10" fill="none"><path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // The number and its unit. The unit is a menu, in the same design as the project pickers.
  function limAmountHtml(key, id, a, placeholder) {
    const s = limScaleOf(a.scale);
    const menu = LIM_SCALES.map((o) => `<button class="rs-opt ${o.v === a.scale ? 'active' : ''}" data-scale-pick="${key}" data-v="${o.v}"><span class="rs-n">${o.name}</span><span class="lim-scale-short">${o.short}</span></button>`).join('');
    return `
      <div class="lim-amt">
        <input type="text" inputmode="decimal" class="km-input lim-input" id="${id}" value="${escapeHtml(a.num)}" placeholder="${placeholder}" spellcheck="false" autocomplete="off">
        <div class="rs-pick lim-scale">
          <button class="rs-pick-btn lim-scale-btn" data-scale-btn="${key}" aria-haspopup="listbox"><span class="rs-n">${s.name}</span>${LIM_CHEV}</button>
          <div class="rs-menu lim-scale-menu" role="listbox" ${limScaleOpen === key ? '' : 'hidden'}>${menu}</div>
        </div>
      </div>`;
  }

  async function renderLimitsTab(p, tabs) {
    const v = await window.mw.limitsGet(false);
    if (!limDraft) limDraft = limDraftFrom(v.config);
    const d = limDraft;
    const head = `
      <div class="settings-section-title">Tokens</div>
      <div class="settings-section-desc">Three separate things Mindweave tracks about how you're using it.</div>
      ${tabs}
      <div class="settings-section-desc usage-tab-desc">${USAGE_TAB_DESC.limits}</div>`;
    const wireTabs = () => usageRoot.querySelectorAll('[data-utab]').forEach((b) => b.addEventListener('click', () => { usageSubTab = b.dataset.utab; limEditing = false; limScaleOpen = null; usageRender(p); }));

    // ── A limit is on: the summary ──
    if (v.config.enabled && !limEditing) {
      const c = v.config;
      const line = (id) => v.lines.find((l) => l.id === id)?.limit;
      usageRoot.innerHTML = `
        ${head}
        <div class="lim-bars" id="lim-bars">${limBarsHtml(v)}</div>
        <div class="lim-summary">
          <div class="lim-sum-main">
            <span class="lim-sum-label">Monthly limit</span>
            <span class="lim-sum-value">${escapeHtml(line('monthly') || '')}</span>
          </div>
          <div class="lim-sum-sub">
            ${line('fiveHour') ? `5-hour window ${escapeHtml(line('fiveHour'))}` : ''}${line('fiveHour') && line('weekly') ? ' · ' : ''}${line('weekly') ? `weekly ${escapeHtml(line('weekly'))}` : ''}
            · month starts on day ${c.monthStartDay} · ${c.enforce ? 'new steps wait when a window is used up' : 'warnings only'}
          </div>
          <div class="lim-actions">
            <button class="settings-btn lim-save" id="lim-edit">Edit monthly spending</button>
            <button class="settings-btn" id="lim-off">Turn off (unlimited)</button>
          </div>
        </div>
        ${limSaved ? `<div class="rs-notice lim-note">${escapeHtml(limSaved)}</div>` : ''}
        <div class="usage-soon lim-fine">${LIM_DISCLAIMER}</div>`;
      wireTabs();
      usageRoot.querySelector('#lim-edit').addEventListener('click', () => { limEditing = true; limDraft = limDraftFrom(v.config); limSaved = null; limError = null; limNote = null; usageRender(p); });
      usageRoot.querySelector('#lim-off').addEventListener('click', async () => {
        const next = await window.mw.limitsSave({ enabled: false });
        limDraft = limDraftFrom(next.config); limEditing = false; limError = null; limNote = null; limSaved = 'Limits are off. Nothing is capped, and your numbers are kept.';
        void refreshLimitMeter();
        usageRender(p);
      });
      return;
    }

    // ── Setup (first time, after turning it off, or editing) ──
    // While limits are off the form is locked: you see your saved numbers but cannot change them
    // until you press "Turn on limits". Cancel goes back to locked.
    const locked = !limEditing;
    usageRoot.innerHTML = `
      ${head}
      ${locked ? `<div class="lim-status">
        <span class="lim-status-text">Limits are off. Nothing is capped. Your saved numbers are kept.</span>
        <button class="settings-btn" id="lim-turn-on">Turn on limits</button>
      </div>` : ''}
      <div class="lim-form"${locked ? ' inert aria-disabled="true"' : ''}>
      <div class="settings-group">Your limit</div>
      <div class="settings-row">
        <div class="settings-row-label"><span class="t">Count in</span><span class="d">Fresh input plus output, the same figure as the Spend tab.</span></div>
        <div class="settings-seg">
          <button class="active">Tokens</button>
          <span class="lim-tipwrap" data-tip="Still in development. Money limits need each model's real price, and that is not reliable enough yet."><button class="lim-disabled" disabled aria-disabled="true">Money</button></span>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label"><span class="t">Monthly limit</span><span class="d">The one number you set. Everything else follows from it.</span></div>
        <div class="lim-field">
          ${limAmountHtml('monthly', 'lim-monthly', d.monthly, 'e.g. 3')}
          <div class="lim-readback" id="lim-monthly-read">${escapeHtml(limReadback(d.monthly))}</div>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label"><span class="t">Month starts on day</span><span class="d">The day your budget starts over, 1 to 28.</span></div>
        <div class="lim-field"><input type="text" inputmode="numeric" class="km-input lim-input lim-small" id="lim-day" value="${escapeHtml(d.monthStartDay)}" spellcheck="false" autocomplete="off"></div>
      </div>

      <div class="lim-analyze">
        <button class="settings-btn" id="lim-analyze">Analyze</button>
        <span class="lim-analyze-hint">Works out the 5-hour and weekly amounts from your monthly limit and how you use the tool.</span>
      </div>
      ${limNote ? `<div class="rs-notice lim-note">${escapeHtml(limNote)}</div>` : ''}

      <div class="settings-row">
        <div class="settings-row-label"><span class="t">5-hour window</span><span class="d">A session starts with your first message and lasts 5 hours. Used up, it waits until those 5 hours end.</span></div>
        <div class="lim-field">
          ${limAmountHtml('five', 'lim-five', d.fiveHour, 'e.g. 250')}
          <div class="lim-readback" id="lim-five-read">${escapeHtml(limReadback(d.fiveHour))}</div>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label"><span class="t">Weekly window</span><span class="d">Resets at the same day and time every week, counted from the day you turn limits on. Used up means waiting days, not hours.</span></div>
        <div class="lim-field">
          ${limAmountHtml('week', 'lim-week', d.weekly, 'e.g. 700')}
          <div class="lim-readback" id="lim-week-read">${escapeHtml(limReadback(d.weekly))}</div>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-label"><span class="t">Stop at a limit</span><span class="d">On: new steps wait until the window opens. Off: you are only warned.</span></div>
        <div class="sw ${d.enforce ? 'on' : ''}" id="lim-enforce" role="switch" aria-checked="${d.enforce}" aria-label="Stop at a limit"></div>
      </div>

      </div>
      ${limError ? `<div class="km-error">${escapeHtml(limError)}</div>` : ''}
      ${limSaved ? `<div class="rs-notice lim-note">${escapeHtml(limSaved)}</div>` : ''}
      ${locked ? '' : `<div class="lim-actions">
        <button class="settings-btn lim-save" id="lim-save">Save limits</button>
        <button class="settings-btn" id="lim-cancel">Cancel</button>
      </div>`}
      <div class="usage-soon lim-fine">${LIM_DISCLAIMER}</div>`;
    wireTabs();

    // Take what is in the fields into the draft, so opening a menu or pressing Analyze never loses typing.
    const sync = () => {
      const val = (id) => usageRoot.querySelector(id)?.value ?? '';
      d.monthly.num = val('#lim-monthly');
      d.fiveHour.num = val('#lim-five');
      d.weekly.num = val('#lim-week');
      d.monthStartDay = val('#lim-day');
    };
    const drafts = { monthly: d.monthly, five: d.fiveHour, week: d.weekly };
    const readbackIds = { monthly: '#lim-monthly-read', five: '#lim-five-read', week: '#lim-week-read' };
    const inputIds = { monthly: '#lim-monthly', five: '#lim-five', week: '#lim-week' };

    Object.keys(inputIds).forEach((key) => {
      const input = usageRoot.querySelector(inputIds[key]);
      input.addEventListener('input', () => {
        // Digits and one point only; anything else is dropped as it is typed.
        const cleaned = input.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
        if (cleaned !== input.value) input.value = cleaned;
        drafts[key].num = input.value;
        limError = null; limSaved = null;
        usageRoot.querySelector(readbackIds[key]).textContent = limReadback(drafts[key]);
      });
    });
    usageRoot.querySelector('#lim-day').addEventListener('input', (e) => {
      const digits = e.target.value.replace(/[^0-9]/g, '').slice(0, 2);
      if (digits !== e.target.value) e.target.value = digits;
      limError = null; limSaved = null;
    });

    // The unit menus.
    usageRoot.querySelectorAll('[data-scale-btn]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      sync();
      limScaleOpen = limScaleOpen === b.dataset.scaleBtn ? null : b.dataset.scaleBtn;
      usageRender(p);
    }));
    usageRoot.querySelectorAll('[data-scale-pick]').forEach((o) => o.addEventListener('click', (e) => {
      e.stopPropagation();
      sync();
      drafts[o.dataset.scalePick].scale = Number(o.dataset.v);
      limScaleOpen = null; limError = null; limSaved = null;
      usageRender(p);
    }));
    usageRoot.onclick = () => { if (limScaleOpen) { sync(); limScaleOpen = null; usageRender(p); } };

    usageRoot.querySelector('#lim-enforce').addEventListener('click', () => { sync(); d.enforce = !d.enforce; limSaved = null; usageRender(p); });

    const readAmounts = () => {
      sync();
      const monthly = limTokens(d.monthly);
      const fiveHour = limTokens(d.fiveHour);
      const weekly = limTokens(d.weekly);
      const day = Number(d.monthStartDay || 1);
      if ([monthly, fiveHour, weekly].some((n) => Number.isNaN(n))) return { error: 'Amounts are plain numbers, like 3 or 12.5.' };
      if (!(day >= 1 && day <= 28)) return { error: 'The month starts on a day from 1 to 28.' };
      return { monthly, fiveHour, weekly, day };
    };

    usageRoot.querySelector('#lim-analyze').addEventListener('click', async () => {
      const a = readAmounts();
      if (a.error) { limError = a.error; limSaved = null; usageRender(p); return; }
      if (!(a.monthly > 0)) { limError = 'Set a monthly limit first, then Analyze can work out the rest.'; limSaved = null; usageRender(p); return; }
      const r = await window.mw.limitsAnalyze({ unit: 'tokens', monthly: a.monthly, monthStartDay: a.day });
      d.fiveHour = limAmountFrom(r.fiveHour, 1e3);
      d.weekly = limAmountFrom(r.weekly, 1e3);
      d.analyzedAt = Date.now();
      limNote = r.note; limError = null; limSaved = null; limScaleOpen = null;
      usageRender(p);
    });

    usageRoot.querySelector('#lim-turn-on')?.addEventListener('click', () => { limEditing = true; limSaved = null; limError = null; usageRender(p); });
    usageRoot.querySelector('#lim-save')?.addEventListener('click', async () => {
      const a = readAmounts();
      if (a.error) { limError = a.error; limSaved = null; usageRender(p); return; }
      if (!(a.monthly > 0 || a.fiveHour > 0 || a.weekly > 0)) { limError = 'Give at least one amount above zero.'; limSaved = null; usageRender(p); return; }
      if (a.monthly > 0 && a.weekly > a.monthly) { limError = 'The weekly amount cannot be more than the month.'; limSaved = null; usageRender(p); return; }
      if (a.weekly > 0 && a.fiveHour > a.weekly) { limError = 'The 5-hour amount cannot be more than the week.'; limSaved = null; usageRender(p); return; }
      const next = await window.mw.limitsSave({
        enabled: true, unit: 'tokens', monthly: a.monthly, monthStartDay: a.day, fiveHour: a.fiveHour, weekly: a.weekly,
        enforce: d.enforce, ...(d.analyzedAt ? { analyzedAt: d.analyzedAt } : {}),
      });
      limDraft = limDraftFrom(next.config);
      void refreshLimitMeter();
      limEditing = false; limError = null; limNote = null;
      limSaved = d.enforce ? 'Saved. New steps will wait when a window is used up.' : 'Saved. You will be warned as you approach a limit.';
      usageRender(p);
    });

    usageRoot.querySelector('#lim-cancel')?.addEventListener('click', () => { limEditing = false; limDraft = limDraftFrom(v.config); limError = null; limNote = null; limSaved = null; usageRender(p); });
  }

  // A window can end while the tab sits open, so the bars are redrawn now and then, not only when a call ends.
  setInterval(() => { void refreshLimitBars(); }, 30000);

  // While the tab is open, the bars follow use as it happens (the engine says when a call finished).
  async function refreshLimitBars() {
    const el = document.getElementById('lim-bars');
    if (!el || usageSubTab !== 'limits' || settingsOverlay.hidden) return;
    el.innerHTML = limBarsHtml(await window.mw.limitsGet(false));
  }

  // ── Settings > Rules & Skills ──────────────────────────────────────────
  // Plain on purpose: a list of files, each opened in the text editor. A rule is an
  // instruction the agent always follows; a skill is a procedure it runs when it fits.
  // "Add to" is a dropdown LIST (All projects, then every project you've opened),
  // so it holds any number of projects; picking a project also shows its files.
  const rsRoot = document.getElementById('rs-root');
  let rsAdding = null; // 'rule' | 'skill' while the new-item row is open
  let rsError = null;
  let rsNotice = null; // what the last upload added
  let rsCwd = null; // the project picked in the list; null = the open one
  let rsGlobal = false; // "All projects" picked: new files go to the universal folder
  let rsMenuOpen = false;
  const RS_GLOBE = '<svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.8" stroke="currentColor" stroke-width="1.2"/><path d="M2.4 8h11.2M8 2.2c1.6 1.7 2.4 3.6 2.4 5.8S9.6 12.1 8 13.8C6.4 12.1 5.6 10.2 5.6 8S6.4 3.9 8 2.2Z" stroke="currentColor" stroke-width="1.1"/></svg>';
  const RS_FOLDER = '<svg viewBox="0 0 16 16" fill="none"><path d="M2 4.5c0-.8.6-1.5 1.5-1.5h3l1.5 1.6h4.5c.8 0 1.5.7 1.5 1.5v5.4c0 .8-.7 1.5-1.5 1.5h-9c-.9 0-1.5-.7-1.5-1.5V4.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

  async function rsRender(payload) {
    const p = payload ?? (await window.mw.rsList(rsCwd));
    const list = p.items;
    const target = p.projects.find((x) => x.cwd === (rsCwd ?? p.projects.find((y) => y.current)?.cwd)) ?? p.projects[0];
    const project = target?.name ?? 'Project';
    const scope = rsGlobal ? 'global' : 'project';
    const row = (i) => `
      <div class="rs-row" data-file="${escapeHtml(i.file)}">
        <span class="rs-name mono">${escapeHtml(i.name)}</span>
        <span class="rs-scope ${i.scope}">${i.scope === 'global' ? 'All projects' : projName(project)}</span>
        <span class="rs-actions">
          <button class="rs-ib" data-rs="edit" title="Edit" aria-label="Edit">${ICON_EDIT}</button>
          <button class="rs-ib" data-rs="move" title="${i.scope === 'global' ? `Move to ${escapeHtml(project)}` : 'Move to all projects'}" aria-label="Move">${ICON_MOVE}</button>
          <button class="rs-ib danger" data-rs="remove" title="Delete" aria-label="Delete">${ICON_TRASH}</button>
        </span>
      </div>`;
    const group = (kind, title, empty) => {
      const mine = list.filter((i) => i.kind === kind);
      return `
        <div class="rs-group">${title} <span class="rs-count">${mine.length}</span></div>
        ${mine.length ? mine.map(row).join('') : `<div class="rs-empty">${empty}</div>`}`;
    };
    const options = [
      `<button class="rs-opt ${rsGlobal ? 'active' : ''}" data-global="1">${RS_GLOBE}<span class="rs-n">All projects</span></button>`,
      '<div class="rs-opt-sep">Projects</div>',
      ...p.projects.map((x) => `
        <button class="rs-opt ${!rsGlobal && x.cwd === target?.cwd ? 'active' : ''}" data-cwd="${escapeHtml(x.cwd)}" title="${escapeHtml(x.cwd)}">
          ${RS_FOLDER}<span class="rs-n">${escapeHtml(x.name)}</span>${x.current ? '<span class="rs-open">Open</span>' : ''}
        </button>`),
    ].join('');

    rsRoot.innerHTML = `
      <div class="settings-section-title">Rules &amp; Skills</div>
      <div class="settings-section-desc">Rules are instructions the agent always follows. Skills are step-by-step procedures it runs when they fit. Each is a file you can edit.</div>
      <div class="rs-bar">
        <button class="settings-btn ghost" data-new="rule">+ Rule</button>
        <button class="settings-btn ghost" data-new="skill">+ Skill</button>
        <button class="settings-btn ghost" id="rs-upload">Upload…</button>
        <input type="file" id="rs-file" accept=".md,.markdown,.txt" multiple hidden>
        <span class="rs-to">Add to</span>
        <div class="rs-pick">
          <button class="rs-pick-btn" id="rs-pick-btn" aria-haspopup="listbox">
            ${rsGlobal ? RS_GLOBE : RS_FOLDER}<span class="rs-n">${rsGlobal ? 'All projects' : escapeHtml(project)}</span>
            <svg class="chev" viewBox="0 0 10 10" fill="none"><path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <div class="rs-menu" role="listbox" ${rsMenuOpen ? '' : 'hidden'}>${options}</div>
        </div>
      </div>
      <div class="rs-hint">Or drop .md files anywhere here. A file named SKILL.md, or one with a "when_to_use" line at the top, becomes a skill; anything else becomes a rule. ${noProject ? 'Showing the files for all projects.' : `Showing ${escapeHtml(project)}'s and all projects' files.`}</div>
      ${rsAdding ? `
        <div class="rs-new">
          <input type="text" class="km-input" id="rs-new-name" placeholder="${rsAdding === 'rule' ? 'Rule name, e.g. use-pnpm' : 'Skill name, e.g. deploy'}" spellcheck="false" autocomplete="off">
          <button class="settings-btn" id="rs-create">Create ${rsAdding}</button>
          <button class="settings-btn ghost" id="rs-cancel">Cancel</button>
        </div>` : ''}
      ${rsError ? `<div class="km-error">${escapeHtml(rsError)}</div>` : ''}
      ${rsNotice ? `<div class="rs-notice">${escapeHtml(rsNotice)}</div>` : ''}
      ${group('rule', 'Rules', 'No rules yet.')}
      ${group('skill', 'Skills', 'No skills yet.')}
    `;

    const cwd = target?.cwd;
    const act = async (action, args) => {
      const next = await window.mw.rsAction(action, { ...args, cwd });
      rsError = next.result.ok ? null : next.result.error;
      await rsRender(next);
      return next.result;
    };
    const edit = async (file, name) => {
      const text = await window.mw.rsRead(file, cwd);
      if (text === null) { rsError = "Couldn't open that file."; return rsRender(); }
      openFileEditor(name, file, text, async (next) => (await act('save', { file, text: next })).ok);
    };

    // The list.
    rsRoot.querySelector('#rs-pick-btn').addEventListener('click', (e) => { e.stopPropagation(); rsMenuOpen = !rsMenuOpen; rsRender(p); });
    rsRoot.querySelectorAll('.rs-opt').forEach((o) => o.addEventListener('click', (e) => {
      e.stopPropagation();
      rsMenuOpen = false; rsError = null; rsNotice = null;
      if (o.dataset.global) { rsGlobal = true; rsRender(p); return; }
      rsGlobal = false;
      rsCwd = o.dataset.cwd;
      rsRender();
    }));
    rsRoot.onclick = () => { if (rsMenuOpen) { rsMenuOpen = false; rsRender(p); } };

    rsRoot.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', () => {
      rsAdding = b.dataset.new; rsError = null; rsNotice = null;
      rsRender(p).then(() => rsRoot.querySelector('#rs-new-name')?.focus());
    }));
    const fileInput = rsRoot.querySelector('#rs-file');
    rsRoot.querySelector('#rs-upload').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { rsImportFiles([...fileInput.files]); fileInput.value = ''; });
    const create = async () => {
      const kind = rsAdding;
      const name = rsRoot.querySelector('#rs-new-name').value;
      const next = await window.mw.rsAction('create', { kind, name, scope, cwd });
      rsError = next.result.ok ? null : next.result.error;
      if (next.result.ok) rsAdding = null;
      await rsRender(next);
      if (next.result.ok) edit(next.result.file, next.items.find((i) => i.file === next.result.file)?.name ?? name); // straight into the new file
    };
    rsRoot.querySelector('#rs-create')?.addEventListener('click', create);
    rsRoot.querySelector('#rs-new-name')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') create();
      if (e.key === 'Escape') { e.stopPropagation(); rsAdding = null; rsRender(p); }
    });
    rsRoot.querySelector('#rs-cancel')?.addEventListener('click', () => { rsAdding = null; rsError = null; rsRender(p); });
    rsRoot.querySelectorAll('.rs-row').forEach((r) => {
      const file = r.dataset.file;
      const item = list.find((i) => i.file === file);
      r.querySelector('[data-rs="edit"]').addEventListener('click', () => edit(file, item.name));
      r.querySelector('[data-rs="move"]').addEventListener('click', () => act('move', { file }));
      r.querySelector('[data-rs="remove"]').addEventListener('click', () =>
        confirmAction(`Delete the ${item.kind} "${item.name}"?`, () => act('remove', { file })));
    });
    rsState = { cwd, scope };
  }
  let rsState = { cwd: null, scope: 'project' }; // what the last render targeted, for drops

  // Upload and drop share one path: read each file here, let the engine decide rule
  // or skill, and say what came in (and what didn't, and why).
  async function rsImportFiles(files) {
    const texts = files.filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
    const skipped = files.length - texts.length;
    if (!texts.length) { rsError = 'Only .md or .txt files can be added as rules or skills.'; rsNotice = null; return rsRender(); }
    const payload = await Promise.all(texts.map(async (f) => ({ name: f.name, text: await f.text() })));
    const next = await window.mw.rsImport(payload, rsState.scope, rsState.cwd);
    const added = next.results.filter((r) => r.ok);
    const failed = next.results.filter((r) => !r.ok);
    rsNotice = added.length ? `Added ${added.map((r) => `${r.kind} "${r.name}"`).join(', ')}.` : null;
    rsError = [...failed.map((r) => r.error), ...(skipped ? [`${skipped} file${skipped === 1 ? ' was' : 's were'} skipped: only .md or .txt.`] : [])].join(' ') || null;
    rsRender(next);
  }
  const rsPanel = document.getElementById('panel-rules');
  rsPanel.addEventListener('dragover', (e) => { e.preventDefault(); rsPanel.classList.add('rs-dragging'); });
  rsPanel.addEventListener('dragleave', (e) => { if (!rsPanel.contains(e.relatedTarget)) rsPanel.classList.remove('rs-dragging'); });
  rsPanel.addEventListener('drop', (e) => {
    e.preventDefault();
    rsPanel.classList.remove('rs-dragging');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) rsImportFiles(files);
  });

  document.querySelectorAll('.settings-nav button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.panel === 'rules') { rsAdding = null; rsError = null; rsNotice = null; rsMenuOpen = false; rsCwd = null; rsGlobal = noProject; rsRender(); }
  }));

  // Back to the list whenever the panel is left or Settings is reopened.
  document.querySelectorAll('.settings-nav button').forEach((b) => b.addEventListener('click', showProviderList));
  document.getElementById('open-settings').addEventListener('click', showProviderList);

  providerSearch.addEventListener('input', () => {
    const q = providerSearch.value.trim().toLowerCase();
    let anyVisible = false;
    document.querySelectorAll('#provider-list .settings-row').forEach((row) => {
      const match = row.dataset.search.includes(q);
      row.hidden = !match;
      if (match) anyVisible = true;
    });
    providerEmpty.hidden = anyVisible;
  });

  document.querySelectorAll('.settings-seg').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
      });
    });
  });

  // ── Confirm dialog (generic yes/no) ──────────────────────────────────
  const confirmOverlay = document.getElementById('confirm-overlay');
  const confirmText = document.getElementById('confirm-text');
  const confirmYes = document.getElementById('confirm-yes');
  const confirmNo = document.getElementById('confirm-no');

  function confirmAction(message, onYes, { yes = 'Yes, remove', danger = true } = {}) {
    confirmText.textContent = message;
    confirmYes.textContent = yes;
    confirmYes.classList.toggle('danger', danger);
    confirmOverlay.hidden = false;
    confirmYes.onclick = () => {
      confirmOverlay.hidden = true;
      onYes();
    };
    confirmNo.onclick = () => {
      confirmOverlay.hidden = true;
    };
  }
  // The same dialog with several answers instead of yes/no. The extra buttons are made
  // for this one question and removed when it closes, however it closes.
  let closeChoices = null;
  function chooseAction(message, choices) {
    confirmText.textContent = message;
    confirmYes.hidden = true;
    confirmNo.hidden = true;
    confirmOverlay.querySelector('.confirm-modal').classList.add('wide');
    const made = choices.map((c) => {
      const b = document.createElement('button');
      b.className = `settings-btn${c.primary ? '' : ' ghost'}`;
      b.textContent = c.label;
      b.onclick = () => { closeChoices(); c.onPick?.(); };
      confirmYes.parentElement.appendChild(b);
      return b;
    });
    closeChoices = () => {
      confirmOverlay.hidden = true;
      made.forEach((b) => b.remove());
      confirmOverlay.querySelector('.confirm-modal').classList.remove('wide');
      confirmYes.hidden = false;
      confirmNo.hidden = false;
      closeChoices = null;
    };
    confirmOverlay.hidden = false;
  }
  confirmOverlay.addEventListener('click', (e) => {
    if (e.target !== confirmOverlay) return;
    if (closeChoices) closeChoices();
    else confirmOverlay.hidden = true;
  });

  // ── Mode picker (chat header) — real Lightning/Architect/Sentinel switch ──
  // Mode is a client concept the engine reads as plain planMode/guarded flags
  // (cli/modes.ts) — never persisted with the session (Architect is deliberately
  // never sticky across a fresh launch, see turnRunner.ts), but it DOES carry
  // from session to session within this running window, same as the CLI.
  const modePick = document.getElementById('mode-pick');
  const modeMenu = document.getElementById('mode-menu');

  function applyModeState(mode) {
    if (!mode) return;
    modePick.dataset.mode = mode.id;
    modePick.lastChild.textContent = mode.name;
    modePick.title = mode.descriptor;
    modeMenu.querySelectorAll('.mode-item').forEach((opt) => opt.classList.toggle('active', opt.dataset.mode === mode.id));
  }

  // Each mode's one-line description comes from the engine (cli/modes.ts), so the
  // menu can never describe a mode differently from what it actually does.
  window.mw?.listModes?.().then((modes) => {
    (modes || []).forEach((m) => {
      const desc = modeMenu.querySelector(`.mode-item[data-mode="${m.id}"] .mode-desc`);
      if (desc && m.descriptor) desc.textContent = m.descriptor;
    });
  }).catch(() => {});

  modePick.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.qtab-menu').forEach((m) => { if (m !== modeMenu) m.hidden = true; });
    modeMenu.hidden = !modeMenu.hidden;
  });
  document.addEventListener('click', () => { modeMenu.hidden = true; });

  modeMenu.querySelectorAll('.qtab-menu-item[data-mode]').forEach((opt) => {
    opt.addEventListener('click', async () => {
      modeMenu.hidden = true;
      const mode = await window.mw.setMode(opt.dataset.mode);
      applyModeState(mode);
    });
  });

  // ── Quick tabs: things pinned to the chat header ─────────────────────
  // Keys: 'mode' (the mode picker, markup in index.html), 'mcp:<server>' and
  // 'rs:<file>' (a rule or skill). Pins are saved (qt:get / qt:set), and each chip
  // reads real state: an MCP chip's switch really turns the server on or off.
  // A chip's pop-up stays open while you use it; a click anywhere else, or Esc,
  // closes it.
  const chatQtabs = document.getElementById('chat-qtabs');
  const modeWrap = document.querySelector('.qtab-wrap[data-key="mode"]');
  let qtPins = ['mode'];
  let qtMcp = []; // latest MCP server views, for chip status
  let qtRs = []; // latest rules & skills, for chip labels
  const QT_STATE = {
    connected: ['ok', 'Connected'], pending: ['wait', 'Connecting…'], failed: ['bad', 'Failed'],
    'needs-auth': ['warn', 'Needs sign-in'], disabled: ['off', 'Off'],
  };

  function openSettingsAt(panel) {
    document.getElementById('open-settings').click();
    document.querySelector(`.settings-nav button[data-panel="${panel}"]`)?.click();
  }
  function closeQtabMenus(except) {
    document.querySelectorAll('.qtab-menu').forEach((m) => { if (m !== except) m.hidden = true; });
  }
  async function saveQtPins(pins) {
    qtPins = await window.mw.setQuickTabs(pins);
    renderQuickTabs();
    // Always, not only while it's on screen: Settings can reopen straight onto this
    // page, and it must never show a chip as pinned after it was removed.
    qtRenderSettings();
  }
  const isPinned = (key) => qtPins.includes(key);
  const togglePin = (key) => saveQtPins(isPinned(key) ? qtPins.filter((k) => k !== key) : [...qtPins, key]);

  function qtChipMenu(wrap, html) {
    const menu = wrap.querySelector('.qtab-menu');
    menu.innerHTML = html;
    return menu;
  }

  function renderQuickTabs() {
    modeWrap.hidden = !isPinned('mode');
    chatQtabs.querySelectorAll('.qtab-wrap[data-qt]').forEach((w) => w.remove());
    for (const key of qtPins) {
      if (key === 'mode') continue;
      const wrap = document.createElement('div');
      wrap.className = 'qtab-wrap';
      wrap.dataset.qt = key;
      const mcpName = key.startsWith('mcp:') ? key.slice(4) : null;
      const file = key.startsWith('rs:') ? key.slice(3) : null;
      const server = mcpName ? qtMcp.find((s) => s.name === mcpName) : null;
      const item = file ? qtRs.find((i) => i.file === file) : null;
      if ((mcpName && !server && qtMcp.length) || (file && !item && qtRs.length)) continue; // gone since pinned
      const [dot] = server ? QT_STATE[server.state] ?? QT_STATE.pending : ['rs'];
      const label = mcpName ?? item?.name ?? file.split(/[\\/]/).slice(-2).join('/');
      wrap.innerHTML = `
        <button class="tab qt-chip"><span class="qt-dot ${dot}"></span><span class="qt-label">${escapeHtml(label)}</span></button>
        <div class="qtab-menu qt-menu" hidden></div>`;
      chatQtabs.appendChild(wrap);
      const btn = wrap.querySelector('.qt-chip');
      const menu = wrap.querySelector('.qtab-menu');
      menu.addEventListener('click', (e) => e.stopPropagation()); // using the pop-up must not close it
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeQtabMenus(menu);
        menu.hidden = !menu.hidden;
        if (!menu.hidden) fillQtMenu(key, wrap);
      });
    }
  }

  function fillQtMenu(key, wrap) {
    const removeBtn = '<button class="qt-remove">Remove from quick tabs</button>';
    if (key.startsWith('mcp:')) {
      const s = qtMcp.find((x) => x.name === key.slice(4));
      if (!s) { qtChipMenu(wrap, `<div class="qt-head"><span class="qt-title">${escapeHtml(key.slice(4))}</span></div><div class="qt-sub">Not configured any more.</div>${removeBtn}`); }
      else {
        const [dot, text] = QT_STATE[s.state] ?? QT_STATE.pending;
        qtChipMenu(wrap, `
          <div class="qt-head">
            <span class="qt-kind">MCP server</span>
            <span class="qt-title">${escapeHtml(s.name)}</span>
            <span class="qt-status"><span class="qt-dot ${dot}"></span>${escapeHtml(text)}${s.state === 'connected' ? ` · ${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}` : ''}</span>
          </div>
          <div class="qt-row"><span>Turned on</span><div class="sw ${s.state === 'disabled' ? '' : 'on'}" data-qt="toggle" role="switch"></div></div>
          <div class="qt-actions">
            <button data-qt="reconnect" ${s.state === 'disabled' ? 'disabled' : ''}>Reconnect</button>
            <button data-qt="open">Open in Settings</button>
          </div>
          ${removeBtn}`);
        const menu = wrap.querySelector('.qtab-menu');
        menu.querySelector('[data-qt="toggle"]').addEventListener('click', async () => {
          await window.mw.mcpAction(s.state === 'disabled' ? 'enable' : 'disable', { name: s.name });
          await refreshQtData();
          fillQtMenu(key, wrap); // stays open, showing the new state
        });
        menu.querySelector('[data-qt="reconnect"]').addEventListener('click', async (e) => {
          e.currentTarget.textContent = 'Reconnecting…';
          await window.mw.mcpAction('reconnect', { name: s.name });
          await refreshQtData();
          fillQtMenu(key, wrap);
        });
        menu.querySelector('[data-qt="open"]').addEventListener('click', () => {
          closeQtabMenus();
          openSettingsAt('mcp');
          mcpGo({ kind: 'detail', name: s.name });
        });
      }
    } else {
      const file = key.slice(3);
      const item = qtRs.find((i) => i.file === file);
      if (!item) { qtChipMenu(wrap, `<div class="qt-head"><span class="qt-title">${escapeHtml(file.split(/[\\/]/).pop())}</span></div><div class="qt-sub">This file is gone.</div>${removeBtn}`); }
      else {
        qtChipMenu(wrap, `
          <div class="qt-head">
            <span class="qt-kind">${item.kind === 'skill' ? 'Skill' : 'Rule'} · ${item.scope === 'global' ? 'All projects' : 'This project'}</span>
            <span class="qt-title">${escapeHtml(item.name)}</span>
          </div>
          <div class="qt-actions">
            <button data-qt="edit">Edit</button>
            <button data-qt="open">Open in Settings</button>
          </div>
          ${removeBtn}`);
        const menu = wrap.querySelector('.qtab-menu');
        menu.querySelector('[data-qt="edit"]').addEventListener('click', async () => {
          closeQtabMenus();
          const text = await window.mw.rsRead(file);
          if (text !== null) {
            openFileEditor(item.name, file, text, async (next) => (await window.mw.rsAction('save', { file, text: next })).result.ok);
          }
        });
        menu.querySelector('[data-qt="open"]').addEventListener('click', () => { closeQtabMenus(); openSettingsAt('rules'); });
      }
    }
    wrap.querySelector('.qt-remove').addEventListener('click', () => { closeQtabMenus(); togglePin(key); });
  }

  async function refreshQtData() {
    const [mcp, rs] = await Promise.all([
      window.mw.mcpList?.().catch(() => []) ?? [],
      window.mw.rsList?.().then((p) => p.items).catch(() => []) ?? [],
    ]);
    qtMcp = mcp || [];
    qtRs = rs || [];
  }

  // The mode chip's own "Remove" (its markup lives in index.html).
  document.getElementById('mode-remove').addEventListener('click', () => { modeMenu.hidden = true; togglePin('mode'); });

  // One rule for every quick tab pop-up: a click outside closes it, Esc closes it.
  document.addEventListener('click', (e) => { if (!e.target.closest('.qtab-wrap')) closeQtabMenus(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector('.qtabs .qtab-menu:not([hidden])')) { closeQtabMenus(); e.stopPropagation(); }
  }, true);

  // Keep MCP chips' status dots current while servers connect and fail.
  window.mw?.onMcpChanged?.(async () => {
    if (!qtPins.some((k) => k.startsWith('mcp:'))) return;
    await refreshQtData();
    if (!document.querySelector('.qtabs .qt-menu:not([hidden])')) renderQuickTabs();
  });

  (async () => {
    if (!window.mw?.quickTabs) return;
    qtPins = await window.mw.quickTabs();
    await refreshQtData();
    renderQuickTabs();
  })();

  // ── Settings > Quick Tabs: choose what is pinned ───────────────────────
  const qtRoot = document.getElementById('qt-root');
  async function qtRenderSettings() {
    await refreshQtData();
    const pinBtn = (key) => `<button class="qt-pin ${isPinned(key) ? 'on' : ''}" data-pin="${escapeHtml(key)}">${isPinned(key) ? 'Pinned' : 'Pin'}</button>`;
    const row = (key, name, sub) => `
      <div class="rs-row">
        <span class="rs-name">${escapeHtml(name)}${sub ? ` <span class="perm-sub">${escapeHtml(sub)}</span>` : ''}</span>
        ${pinBtn(key)}
      </div>`;
    qtRoot.innerHTML = `
      <div class="settings-section-title">Quick Tabs</div>
      <div class="settings-section-desc">Pin things to the chat header so they're one click away. The model picker is always in the composer.</div>

      <div class="rs-group">Mode</div>
      <div class="rs-hint">Switch between Lightning, Architect and Sentinel.</div>
      ${row('mode', 'Mode picker', '')}

      <div class="rs-group">MCP servers <span class="rs-count">${qtMcp.length}</span></div>
      <div class="rs-hint">See a server's status, turn it on or off, or reconnect it.</div>
      ${qtMcp.length ? qtMcp.map((s) => row(`mcp:${s.name}`, s.name, s.type === 'http' ? 'Remote' : 'Local')).join('') : '<div class="rs-empty">No MCP servers yet. Add one under MCP Servers.</div>'}

      <div class="rs-group">Rules &amp; Skills <span class="rs-count">${qtRs.length}</span></div>
      <div class="rs-hint">Open a rule or skill for editing straight from the chat.</div>
      ${qtRs.length ? qtRs.map((i) => row(`rs:${i.file}`, i.name, `${i.kind === 'skill' ? 'Skill' : 'Rule'} · ${i.scope === 'global' ? 'All projects' : 'This project'}`)).join('') : '<div class="rs-empty">No rules or skills yet. Add them under Rules &amp; Skills.</div>'}
    `;
    qtRoot.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', () => togglePin(b.dataset.pin)));
  }
  document.querySelectorAll('.settings-nav button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.panel === 'quicktabs') qtRenderSettings();
  }));
  document.getElementById('open-settings').addEventListener('click', () => {
    if (document.getElementById('panel-quicktabs').classList.contains('active')) qtRenderSettings();
  });

  // The agent can save rules, skills and forbidden entries itself (governor and skill
  // tools). When a tool finishes while one of these Settings pages is open, redraw it
  // from disk so what the agent just added is there, unless you're typing in it.
  let settingsRefreshTimer = null;
  window.mw?.onChatEvent?.((e) => {
    if (e.type !== 'toolEnd' && e.type !== 'done') return;
    if (settingsOverlay.hidden) return;
    clearTimeout(settingsRefreshTimer);
    settingsRefreshTimer = setTimeout(() => {
      const active = document.querySelector('.settings-panel.active');
      if (!active || active.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
      if (active.id === 'panel-permissions' && !permOpenAdd && !permMenuOpen) permRender();
      else if (active.id === 'panel-usage' && !usageMenuOpen) usageRender();
      else if (active.id === 'panel-rules' && !rsAdding && !rsMenuOpen) rsRender();
      else if (active.id === 'panel-quicktabs') qtRenderSettings();
    }, 300);
  });

  // ── Composer pickers (thinking + model) ──────────────────────────────
  // Opens or closes a list in place with a short slide: height and opacity together, from the measured size.
  function slideList(el, open) {
    if (open === !el.hidden && !el._sliding) return;
    el.getAnimations().forEach((a) => a.cancel());
    const ease = 'cubic-bezier(.2,.8,.2,1)';
    // Its padding, border and margin slide too, or the last few pixels would pop at the very end.
    const shut = { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px', borderBottomWidth: '0px' };
    const full = (h) => { const cs = getComputedStyle(el); return { height: h + 'px', opacity: 1, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginBottom: cs.marginBottom, borderBottomWidth: cs.borderBottomWidth }; };
    if (open) {
      el.hidden = false;
      const h = el.scrollHeight;
      el._sliding = el.animate([shut, full(h)], { duration: 200, easing: ease });
      el._sliding.finished.then(() => { el._sliding = null; }, () => {});
      return;
    }
    const h = el.offsetHeight;
    const anim = el.animate([full(h), shut], { duration: 150, easing: ease });
    el._sliding = anim;
    anim.finished.then(() => { el.hidden = true; el._sliding = null; }, () => {});
  }
  function wirePicker(buttonId, menuId, dataKey) {
    const button = document.getElementById(buttonId);
    const menu = document.getElementById(menuId);
    const label = button.querySelector('.lbl');

    // The sidebar's project list slides open and shut (it pushes the sessions down, so a jump reads as
    // clunky); the pop-up menus elsewhere just appear.
    const slides = menu.classList.contains('side-projects');
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.qtab-menu').forEach((m) => { if (m !== menu) m.hidden = true; });
      if (slides) slideList(menu, menu.hidden); else menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', () => { if (slides) slideList(menu, false); else menu.hidden = true; });

    menu.querySelectorAll('.qtab-menu-item').forEach((opt) => {
      if (opt.dataset[dataKey] === undefined) return; // handled separately (e.g. "Open other…")
      opt.addEventListener('click', () => {
        label.textContent = opt.dataset[dataKey];
        menu.hidden = true;
      });
    });
  }

  wirePicker('proj-pick', 'proj-menu', 'proj');

  // ── Thinking picker — real ladder for the CURRENT model, not a fixed three-
  // option list. Every model has its own shape (DeepSeek: Light/Thinking/
  // Maximum; Gemini: Standard/Thinking/Maximum; some models can't turn
  // thinking off at all) — see turnRunner.ts's sessionThinkLevels. Rebuilt
  // fresh whenever the model changes, same as the CLI's `/think`.
  const thinkPick = document.getElementById('think-pick');
  const thinkMenu = document.getElementById('think-menu');
  const thinkLabelEl = thinkPick.querySelector('.lbl');

  let currentThinking = null;

  function applyThinkingState(thinking) {
    if (!thinking) return;
    currentThinking = thinking;
    thinkLabelEl.textContent = thinking.current;
  }

  function populateThinkMenu(thinking) {
    thinkMenu.innerHTML = '<div class="menu-label">Thinking</div>';
    (thinking?.levels || []).forEach((level) => {
      const item = document.createElement('button');
      item.className = 'qtab-menu-item';
      item.textContent = level.label;
      if (level.label === thinking.current) item.style.color = 'var(--accent-hi)';
      item.title = level.description;
      item.addEventListener('click', async () => {
        thinkMenu.hidden = true;
        const result = await window.mw.setThinking({ thinking: level.thinking, effort: level.effort });
        if (result) applyThinkingState(result);
      });
      thinkMenu.appendChild(item);
    });
  }

  thinkPick.addEventListener('click', async (e) => {
    e.stopPropagation();
    document.querySelectorAll('.qtab-menu').forEach((m) => { if (m !== thinkMenu) m.hidden = true; });
    const opening = thinkMenu.hidden;
    thinkMenu.hidden = !thinkMenu.hidden;
    if (opening) populateThinkMenu(currentThinking);
  });
  document.addEventListener('click', () => { thinkMenu.hidden = true; });

  // ── Provider picker (right after Standard) + Model picker (original spot,
  // right before send) — two separate controls. Both connected-providers-only.
  // Provider picker is plain names, no model list attached — picking one jumps
  // to that provider's default model. Model picker shows the CURRENT provider's
  // own models (capped, so a router like OpenRouter doesn't dump hundreds into
  // one menu). Either one takes effect on the NEXT turn in this conversation,
  // same as /model in the CLI — nothing about the chat resets.
  const PROVIDER_SHORT_NAME = { anthropic: 'Claude' };
  const providerPick = document.getElementById('provider-pick');
  const providerMenu = document.getElementById('provider-menu');
  const providerLabelEl = providerPick.querySelector('.lbl');
  const modelPick = document.getElementById('model-pick');
  const modelMenu = document.getElementById('model-menu');
  const modelLabelEl = modelPick.querySelector('.lbl');

  let currentModel = null;

  function applyModelState(model) {
    if (!model) return;
    currentModel = model;
    void refreshContext(); // another model has another window, so another bar
    // Settings > Tokens > Context shows "recommended for <model>" and the effective
    // bar for whatever model is active. It only refetches on its own clicks, so
    // switching models while sitting on that tab left it showing the old one until
    // you left and came back — this closes that gap the moment the model changes.
    if (!settingsOverlay.hidden && document.getElementById('panel-usage')?.classList.contains('active') && usageSubTab === 'context') {
      void usageRender();
    }
    const shortProvider = PROVIDER_SHORT_NAME[model.providerId] || model.providerLabel;
    providerLabelEl.textContent = shortProvider;
    providerPick.title = shortProvider;
    modelLabelEl.textContent = model.label;
    modelPick.title = `${shortProvider} · ${model.label}`;
  }

  async function connectedProviders() {
    const providers = (await window.mw.listProviders?.()) || [];
    return providers.filter((p) => p.connected).sort((a, b) => a.label.localeCompare(b.label));
  }

  async function populateProviderMenu() {
    providerMenu.innerHTML = '';
    const connected = await connectedProviders();
    if (connected.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'qtab-menu-item';
      empty.textContent = 'No providers connected';
      providerMenu.appendChild(empty);
      return;
    }
    connected.forEach((p) => {
      const item = document.createElement('button');
      item.className = 'qtab-menu-item';
      item.textContent = PROVIDER_SHORT_NAME[p.id] || p.label;
      item.addEventListener('click', async () => {
        providerMenu.hidden = true;
        const defaultModel = p.models[0];
        if (!defaultModel) return;
        const result = await window.mw.setModel(defaultModel.id);
        if (result) { applyModelState(result.model); applyThinkingState(result.thinking); }
      });
      providerMenu.appendChild(item);
    });
  }

  // ── Model picker ──
  // A provider with many models (a router like OpenRouter) opens a bigger panel with
  // a search box, filters and a sort; a short list stays a compact menu. Every row
  // says what the model costs (the engine's own rates) and what it can do, free
  // models are marked, and the last few picked sit on top under "Recent".
  const MP_BIG_AFTER = 12;
  let mpData = null; // { providerId, label, models, recent }
  let mpQuery = '';
  let mpFilter = 'all'; // 'all' | 'free' | 'images' | 'thinking'
  let mpSort = 'default'; // 'default' | 'cheap' | 'pricey'
  let mpActive = 0; // keyboard highlight, index into the visible rows

  const mpFree = (m) => m.price.input + m.price.output === 0;
  const mpMaker = (id) => {
    const bare = id.replace(/^[a-z-]+:/, '');
    return bare.includes('/') ? bare.split('/')[0] : '';
  };
  function mpPrice(n) {
    let out = n.toFixed(4).replace(/0+$/, '');
    if ((out.split('.')[1] ?? '').length < 2) out = n.toFixed(2);
    return `$${out}`;
  }

  async function populateModelMenu() {
    const connected = await connectedProviders();
    const provider = connected.find((p) => p.id === currentModel?.providerId) || connected[0];
    if (!provider) {
      modelMenu.classList.remove('mp-big');
      modelMenu.innerHTML = '<div class="qtab-menu-item">No providers connected. Add one in Settings.</div>';
      return;
    }
    mpData = await window.mw.modelPicker(provider.id);
    mpQuery = ''; mpFilter = 'all'; mpSort = 'default'; mpActive = 0;
    renderModelMenu(true);
  }

  function mpVisible() {
    const q = mpQuery.trim().toLowerCase();
    let list = mpData.models.filter((m) => {
      if (mpFilter === 'free' && !mpFree(m)) return false;
      if (mpFilter === 'images' && !m.acceptsImages) return false;
      if (mpFilter === 'thinking' && !m.thinks) return false;
      return !q || `${m.label} ${m.id}`.toLowerCase().includes(q);
    });
    if (mpSort !== 'default') {
      const cost = (m) => m.price.input + m.price.output;
      list = [...list].sort((a, b) => (mpSort === 'cheap' ? cost(a) - cost(b) : cost(b) - cost(a)));
    }
    return list;
  }

  function mpRow(m, i) {
    const on = m.id === currentModel?.id;
    const maker = mpMaker(m.id);
    const price = mpFree(m)
      ? '<span class="mp-free">Free</span>'
      : `<span class="mp-price" title="Input / output, USD per 1M tokens">${mpPrice(m.price.input)} / ${mpPrice(m.price.output)}</span>`;
    return `
      <button class="mp-row ${on ? 'on' : ''} ${i === mpActive ? 'kb' : ''}" data-id="${escapeHtml(m.id)}" data-i="${i}">
        <span class="mp-main">
          <span class="mp-name">${escapeHtml(m.label)}</span>
          <span class="mp-meta">${maker ? `<span class="mp-maker">${escapeHtml(maker)}</span>` : ''}${m.thinks ? '<span class="mp-tag">Thinking</span>' : ''}${m.acceptsImages ? '<span class="mp-tag">Images</span>' : ''}</span>
        </span>
        ${price}
        <svg class="mp-check" viewBox="0 0 12 12"><path d="M2.5 6.3L5 8.7L9.5 3.6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>`;
  }

  function renderModelMenu(focusSearch = false) {
    const big = mpData.models.length > MP_BIG_AFTER;
    modelMenu.classList.toggle('mp-big', big);
    const rows = mpVisible();
    if (mpActive >= rows.length) mpActive = Math.max(0, rows.length - 1);
    const searching = mpQuery || mpFilter !== 'all' || mpSort !== 'default';
    const recent = !searching ? mpData.recent.map((id) => mpData.models.find((m) => m.id === id)).filter(Boolean) : [];
    const free = mpData.models.filter(mpFree).length;
    // Recent rows come first in keyboard order, then the full list.
    const ordered = [...recent, ...rows];
    modelMenu.innerHTML = `
      ${big ? `
        <div class="mp-top">
          <div class="mp-search">
            <svg viewBox="0 0 14 14"><circle cx="6" cy="6" r="4.2" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M9.2 9.2L12.5 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
            <input type="text" id="mp-q" placeholder="Search ${mpData.models.length} ${escapeHtml(mpData.label)} models…" value="${escapeHtml(mpQuery)}" spellcheck="false" autocomplete="off">
          </div>
          <div class="mp-tools">
            ${[['all', 'All'], ['free', `Free${free ? ` ${free}` : ''}`], ['images', 'Images'], ['thinking', 'Thinking']]
              .map(([k, l]) => `<button class="mp-chip ${mpFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}
            <span class="mp-sort">
              ${[['default', 'Default'], ['cheap', 'Cheapest'], ['pricey', 'Priciest']]
                .map(([k, l]) => `<button class="${mpSort === k ? 'on' : ''}" data-s="${k}">${l}</button>`).join('')}
            </span>
          </div>
        </div>` : ''}
      <div class="mp-list">
        ${recent.length ? `<div class="mp-label">Recent</div>${recent.map((m, i) => mpRow(m, i)).join('')}<div class="mp-label">All models</div>` : ''}
        ${rows.map((m, i) => mpRow(m, i + recent.length)).join('') || '<div class="mp-empty">No models match.</div>'}
      </div>`;
    modelMenu._ordered = ordered;

    const q = modelMenu.querySelector('#mp-q');
    if (q) {
      q.addEventListener('input', () => { mpQuery = q.value; mpActive = 0; renderModelMenu(true); });
      q.addEventListener('keydown', mpKeys);
      if (focusSearch) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
    }
    modelMenu.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => { mpFilter = b.dataset.f; mpActive = 0; renderModelMenu(true); }));
    modelMenu.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => { mpSort = b.dataset.s; mpActive = 0; renderModelMenu(true); }));
    modelMenu.querySelectorAll('.mp-row').forEach((r) => r.addEventListener('click', () => mpChoose(r.dataset.id)));
    modelMenu.querySelector('.mp-row.kb')?.scrollIntoView({ block: 'nearest' });
  }

  function mpKeys(e) {
    const n = modelMenu._ordered?.length ?? 0;
    if (e.key === 'ArrowDown') { e.preventDefault(); mpActive = Math.min(n - 1, mpActive + 1); renderModelMenu(true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mpActive = Math.max(0, mpActive - 1); renderModelMenu(true); }
    else if (e.key === 'Enter') { e.preventDefault(); const m = modelMenu._ordered?.[mpActive]; if (m) mpChoose(m.id); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); modelMenu.hidden = true; }
  }

  async function mpChoose(id) {
    modelMenu.hidden = true;
    const result = await window.mw.setModel(id);
    if (result) { applyModelState(result.model); applyThinkingState(result.thinking); }
  }
  // Typing, filtering and scrolling inside the panel must not close it.
  modelMenu.addEventListener('click', (e) => e.stopPropagation());

  providerPick.addEventListener('click', async (e) => {
    e.stopPropagation();
    document.querySelectorAll('.qtab-menu').forEach((m) => { if (m !== providerMenu) m.hidden = true; });
    const opening = providerMenu.hidden;
    providerMenu.hidden = !providerMenu.hidden;
    if (opening) await populateProviderMenu();
  });
  document.addEventListener('click', () => { providerMenu.hidden = true; });

  modelPick.addEventListener('click', async (e) => {
    e.stopPropagation();
    document.querySelectorAll('.qtab-menu').forEach((m) => { if (m !== modelMenu) m.hidden = true; });
    const opening = modelMenu.hidden;
    modelMenu.hidden = !modelMenu.hidden;
    if (opening) await populateModelMenu();
  });
  document.addEventListener('click', () => { modelMenu.hidden = true; });

  // "Open other project…" opens a real OS folder picker (main.js, via
  // dialog.showOpenDialog) and switches the live session over to it. Anything
  // opened before shows above it as a one-click recent list — remembered on
  // disk (main.js's desktop-state.json), so it's there again after a restart.
  const projOpenOther = document.getElementById('proj-open-other');
  const projMenu = document.getElementById('proj-menu');
  const projLabel = document.querySelector('#proj-pick .lbl');
  const projRecentSep = document.getElementById('proj-recent-sep');
  let currentProjectCwd = null;

  // Every project opened before: the menu lists them (scrolling past six) and the search finds them.
  let knownProjects = [];
  const projRecentList = document.getElementById('proj-recent-list');
  async function switchToProject(cwd) {
    projMenu.hidden = true;
    const state = await window.mw.switchProject(cwd);
    if (state) applyAppState(state);
  }
  function renderRecentProjects(recentProjects) {
    knownProjects = recentProjects || [];
    projMenu.querySelectorAll('.proj-recent-item').forEach((el) => el.remove());
    const others = (recentProjects || []).filter((p) => p.cwd !== currentProjectCwd);
    projRecentSep.hidden = others.length === 0;
    others.forEach((p) => {
      const item = document.createElement('button');
      item.className = 'qtab-menu-item proj-recent-item';
      item.title = p.cwd;
      item.innerHTML = `<span class="proj-dot" style="background:var(--dim)"></span><span class="si-text"><span class="si-name">${p.name}</span></span>`;
      item.addEventListener('click', () => switchToProject(p.cwd));
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); openProjectMenu(p, e.clientX, e.clientY, item); });
      projRecentList.appendChild(item);
    });
    if (sessionSearch.value.trim()) drawSessionList();
  }

  // ── First launch: no project, no key ─────────────────────────────────────
  // With no project the sidebar button reads "Open a project" and opens the folder picker, the hero
  // drops "in <project>", Run is hidden, and sending asks for a folder first (then sends). With no key
  // the composer shows "Connect a provider" instead of the thinking, provider and model pickers and the
  // context meter, and sending opens Settings > Providers. Both clear the moment they are done.
  let noProject = false;
  let needsKey = false;
  function setProjectState(state) {
    const was = noProject;
    noProject = !!state.noProject;
    // Settings pages tied to a project show All projects until there is one (each resets to noProject as it
    // opens); these cover a page already open when the project changes.
    if (noProject) { permGlobal = true; usageGlobal = true; rsGlobal = true; }
    else if (was) { permGlobal = false; usageGlobal = false; rsGlobal = false; }
    document.body.classList.toggle('no-project', noProject);
    projLabel.textContent = noProject ? 'Open a project' : state.name;
    document.getElementById('proj-pick').title = noProject ? 'Open a project folder' : 'Switch project';
    document.getElementById('chat-hero-in').hidden = noProject;
  }
  async function openProjectFirst() {
    const state = await window.mw.openProject();
    if (!state) return false;
    applyAppState(state);
    return true;
  }
  document.getElementById('proj-pick').addEventListener('click', (e) => {
    if (!noProject) return;
    e.stopImmediatePropagation();
    void openProjectFirst();
  }, true);
  async function refreshKeyState() {
    let connected = [];
    try { connected = await connectedProviders(); } catch { return; }
    needsKey = connected.length === 0;
    document.querySelector('.composer').classList.toggle('needs-key', needsKey);
    document.getElementById('connect-pick').hidden = !needsKey;
    updateSendButtonMode();
    if (needsKey) return;
    void refreshContext();
    // The built-in default model belongs to one provider; a first key for another one moves the chat onto
    // that one, so the composer never offers a model it has no key for.
    if (currentModel && !connected.some((p) => p.id === currentModel.providerId)) {
      const first = connected.find((p) => p.models?.length);
      const result = first && (await window.mw.setModel(first.models[0].id));
      if (result) { applyModelState(result.model); applyThinkingState(result.thinking); }
    }
  }
  document.getElementById('connect-pick').addEventListener('click', () => openSettingsAt('providers'));
  // A key is added in Settings: look again as it closes.
  new MutationObserver(() => { if (settingsOverlay.hidden) void refreshKeyState(); })
    .observe(settingsOverlay, { attributes: true, attributeFilter: ['hidden'] });

  projOpenOther.addEventListener('click', async () => {
    projMenu.hidden = true;
    const state = await window.mw.openProject();
    if (state) applyAppState(state);
  });

  // ── Session picker: switch sessions or start a new one — real sessions on
  // disk (memory/store.ts), not a decorative list. ─────────────────────────
  const sessionPick = document.getElementById('session-pick');
  const sessionLabel = sessionPick.querySelector('.lbl');
  const sessionNewBtn = document.getElementById('session-new');
  const sessionList = document.getElementById('session-list');
  const sessionSearch = document.getElementById('session-search');
  let sessionData = { sessions: [], activeId: null };

  sessionPick.addEventListener('click', () => {
    setSide(true);
    sessionSearch.focus();
  });
  sessionSearch.addEventListener('input', drawSessionList);
  document.getElementById('session-search-clear').addEventListener('click', (e) => {
    e.preventDefault();
    sessionSearch.value = '';
    drawSessionList();
    sessionSearch.focus();
  });
  sessionSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (sessionSearch.value) { sessionSearch.value = ''; drawSessionList(); } else sessionSearch.blur();
    }
    if (e.key === 'Enter') sessionList.querySelector('.session-item')?.click(); // the top match: a project or a session
  });

  function relativeTime(ms) {
    const diff = Date.now() - ms;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'now';
    if (min < 60) return `${min}m`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h`;
    const d = Math.round(hr / 24);
    if (d < 7) return `${d}d`;
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Today / Yesterday / This week / Earlier, by calendar day, not by hours ago.
  function sessionGroup(ms) {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const day = 86400000;
    if (ms >= start.getTime()) return 'Today';
    if (ms >= start.getTime() - day) return 'Yesterday';
    if (ms >= start.getTime() - 6 * day) return 'This week';
    return 'Earlier';
  }

  function renderSessionList(sessions, activeId) {
    viewSessionId = activeId || null;
    sessionData = { sessions: sessions || [], activeId };
    const active = sessionData.sessions.find((s) => s.id === activeId);
    sessionLabel.textContent = active ? active.label : 'New session';
    drawSessionList();
  }

  const FOLDER_SVG = '<svg viewBox="0 0 14 14" fill="none"><path d="M1.8 3.8c0-.6.4-1 1-1h2.6l1.2 1.4h4.6c.6 0 1 .4 1 1v5c0 .6-.4 1-1 1H2.8c-.6 0-1-.4-1-1v-6.4Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';
  function drawSessionList() {
    const { sessions, activeId } = sessionData;
    const q = sessionSearch.value.trim().toLowerCase();
    const shown = sessions
      .filter((s) => !q || String(s.label).toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    // Pinned sessions first, under their own heading, then the rest by day.
    shown.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    const pinBtn = document.getElementById('side-pin');
    const current = sessions.find((s) => s.id === activeId);
    pinBtn.hidden = !current; // a session not saved yet has nothing to pin
    pinBtn.classList.toggle('on', !!current?.pinned);
    pinBtn.title = current?.pinned ? 'Unpin this session' : 'Pin this session';
    sessionList.innerHTML = '';
    document.getElementById('session-search-clear').hidden = !q;
    // Typing also finds projects, by name or folder, listed above the sessions. Click one to open it.
    const projects = q
      ? knownProjects.filter((p) => p.cwd !== currentProjectCwd && (p.name.toLowerCase().includes(q) || p.cwd.toLowerCase().includes(q))).slice(0, 8)
      : [];
    if (projects.length) {
      const head = document.createElement('div');
      head.className = 'sm-group';
      head.textContent = 'Projects';
      sessionList.appendChild(head);
      for (const p of projects) {
        const item = document.createElement('button');
        item.className = 'session-item proj-result';
        item.title = p.cwd;
        item.innerHTML = '<span class="si-pin"></span><span class="si-name"></span><span class="si-time">project</span>';
        item.querySelector('.si-pin').innerHTML = FOLDER_SVG;
        item.querySelector('.si-name').textContent = p.name;
        item.addEventListener('click', () => {
          closeSideIfFloating();
          sessionSearch.value = '';
          void switchToProject(p.cwd);
        });
        item.addEventListener('contextmenu', (e) => { e.preventDefault(); openProjectMenu(p, e.clientX, e.clientY, item); });
        sessionList.appendChild(item);
      }
    }
    if (shown.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'sm-empty';
      empty.textContent = q ? (projects.length ? `No sessions match “${sessionSearch.value.trim()}”` : `Nothing matches “${sessionSearch.value.trim()}”`) : noProject ? 'Open a project to start' : 'No sessions yet';
      sessionList.appendChild(empty);
      return;
    }
    if (projects.length) {
      const head = document.createElement('div');
      head.className = 'sm-group';
      head.textContent = 'Sessions';
      sessionList.appendChild(head);
    }
    let group = null;
    shown.forEach((s) => {
      const g = s.pinned ? 'Pinned' : sessionGroup(s.updatedAt);
      if (g !== group) {
        group = g;
        const head = document.createElement('div');
        head.className = 'sm-group';
        head.textContent = g;
        sessionList.appendChild(head);
      }
      const item = document.createElement('button');
      item.className = 'session-item' + (s.id === activeId ? ' active' : '') + (s.pinned ? ' pinned' : '');
      item.dataset.id = s.id;
      item.title = s.label;
      item.innerHTML = '<span class="si-pin"></span><span class="si-name"></span><span class="si-time"></span>';
      item.querySelector('.si-pin').innerHTML = document.getElementById('sc-pin').querySelector('svg').outerHTML;
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); openSessionMenu(s, e.clientX, e.clientY); });
      item.querySelector('.si-name').textContent = s.label; // text, never HTML: titles are what was typed
      item.querySelector('.si-time').textContent = s.id === activeId ? 'current' : relativeTime(s.updatedAt);
      item.addEventListener('click', async () => {
        closeSideIfFloating();
        if (s.id === activeId) return;
        const state = await window.mw.switchSession(s.id);
        if (state) applySessionState(state);
      });
      sessionList.appendChild(item);
    });
  }

  // ── Rename and remove a project (right-click it in the list, in the search, or the name at the top) ──
  // Only the app's list and label: the folder, its sessions and the name the agent sees are untouched.
  const projectCtx = document.getElementById('project-ctx');
  let ctxProject = null; // { p, el }
  function openProjectMenu(p, x, y, el) {
    closeQtabMenus();
    sessionCtx.hidden = true;
    ctxProject = { p, el };
    projectCtx.hidden = false;
    const r = projectCtx.getBoundingClientRect();
    projectCtx.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    projectCtx.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  }
  projectCtx.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { projectCtx.hidden = true; });
  window.addEventListener('blur', () => { projectCtx.hidden = true; });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !projectCtx.hidden) { e.preventDefault(); e.stopImmediatePropagation(); projectCtx.hidden = true; }
  }, true);
  function applyProjectList(r) {
    if (!r) return;
    projLabel.textContent = r.name;
    renderRecentProjects(r.recentProjects);
    drawSessionList();
  }
  document.getElementById('pc-remove').addEventListener('click', async () => {
    projectCtx.hidden = true;
    if (!ctxProject) return;
    // Removing the open project moves to the next one in the list, or to none when it was the last.
    const r = await window.mw.forgetProject(ctxProject.p.cwd);
    if (r?.switched) applyAppState(r.switched); else applyProjectList(r);
  });
  // Rename in place, the same way as a session: Enter or clicking away keeps it, Esc leaves it.
  // Emptied, the project goes back to its folder's name.
  document.getElementById('pc-rename').addEventListener('click', () => {
    projectCtx.hidden = true;
    const target = ctxProject;
    if (!target) return;
    const nameEl = target.el.querySelector('.si-name, .lbl');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.className = 'si-rename';
    input.value = target.p.name;
    input.maxLength = 60;
    input.spellcheck = false;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() !== target.p.name) {
        const r = await window.mw.renameProject(target.p.cwd, input.value);
        if (r) { input.replaceWith(nameEl); applyProjectList(r); return; }
      }
      input.replaceWith(nameEl);
    };
    for (const ev of ['click', 'mousedown', 'contextmenu']) input.addEventListener(ev, (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
    });
    input.addEventListener('blur', () => void finish(true));
  });
  // The open project's name at the top: right-click to rename or remove it too (nothing to act on without one).
  document.getElementById('proj-pick').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (noProject) return;
    openProjectMenu({ cwd: currentProjectCwd, name: projLabel.textContent }, e.clientX, e.clientY, document.getElementById('proj-pick'));
  });

  // ── Pin and rename (right-click a session, or the pin beside the hide button) ──
  const sessionCtx = document.getElementById('session-ctx');
  let ctxSession = null;
  function openSessionMenu(s, x, y) {
    closeQtabMenus();
    ctxSession = s;
    sessionCtx.querySelector('#sc-pin span').textContent = s.pinned ? 'Unpin' : 'Pin';
    sessionCtx.hidden = false;
    const r = sessionCtx.getBoundingClientRect();
    sessionCtx.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    sessionCtx.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  }
  sessionCtx.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { sessionCtx.hidden = true; });
  window.addEventListener('blur', () => { sessionCtx.hidden = true; });
  // Captured first, so Esc here closes the menu and never also stops a turn.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sessionCtx.hidden) { e.preventDefault(); e.stopImmediatePropagation(); sessionCtx.hidden = true; }
  }, true);
  async function setPinned(s, pinned) {
    const sessions = await window.mw.pinSession(s.id, pinned);
    if (sessions) renderSessionList(sessions, sessionData.activeId);
  }
  document.getElementById('sc-pin').addEventListener('click', () => {
    sessionCtx.hidden = true;
    if (ctxSession) void setPinned(ctxSession, !ctxSession.pinned);
  });
  document.getElementById('side-pin').addEventListener('click', () => {
    const current = sessionData.sessions.find((s) => s.id === sessionData.activeId);
    if (current) void setPinned(current, !current.pinned);
  });
  // Rename in place: Enter or clicking away keeps it, Esc leaves it as it was. Emptied, the
  // session goes back to its own title.
  document.getElementById('sc-rename').addEventListener('click', () => {
    sessionCtx.hidden = true;
    const s = ctxSession;
    const item = s && sessionList.querySelector(`.session-item[data-id="${CSS.escape(s.id)}"]`);
    if (!item) return;
    // Its own row while editing: a text box inside the row's button would click the button.
    const row = document.createElement('div');
    row.className = item.className;
    const input = document.createElement('input');
    input.className = 'si-rename';
    input.value = s.label;
    input.maxLength = 80;
    input.spellcheck = false;
    row.appendChild(input);
    item.replaceWith(row);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      if (save && input.value.trim() !== s.label) {
        const sessions = await window.mw.renameSession(s.id, input.value);
        if (sessions) { renderSessionList(sessions, sessionData.activeId); return; }
      }
      drawSessionList();
    };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); void finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); void finish(false); }
    });
    input.addEventListener('blur', () => void finish(true));
  });

  sessionNewBtn.addEventListener('click', async (e) => {
    if (noProject) { e.stopImmediatePropagation(); void openProjectFirst(); return; }
    closeSideIfFloating();
    const state = await window.mw.newSession();
    if (state) applySessionState(state);
  });

  // Shared by "switch session" and "new session" — swaps the live transcript
  // in place without touching the project (cwd) or the working indicator.
  function applySessionState(state) {
    renderSessionList(state.sessions, state.sessionId);
    applyModelState(state.model);
    applyThinkingState(state.thinking);
    applyModeState(state.mode);
    renderReplay(state.replay);
    void refreshLimitMeter();
  }

  // A project switch is a session switch plus the proj-pick label and Split
  // view's project dropdown updating too.
  function applyAppState(state) {
    pathCache.clear();
    setProjectState(state);
    // The box's draft stays with the project it was written in; the new project's own
    // draft (if any) takes its place.
    if (state.cwd !== draftCwd) flushDraft().then(() => restoreDraft(state.cwd));
    currentProjectCwd = state.cwd;
    renderRecentProjects(state.recentProjects);
    applySessionState(state);
    refreshRun();
    refreshNotes();
  }

  // ── Sidebar ──────────────────────────────────────────────────────────
  // Open or hidden is yours alone: nothing hides it for you, and it opens the way you
  // left it. A window too narrow for it as a column gets it floating over the chat.
  const appEl = document.querySelector('.app');
  const sideEl = document.getElementById('side');
  const SIDE_KEY = 'mw:side:v1';
  const SIDE_NARROW = 820;
  let sideOpen = true;
  try { sideOpen = mwStore.getItem(SIDE_KEY) !== 'closed'; } catch (e) { /* default: open */ }
  // Narrow at launch: start hidden rather than covering the chat.
  let sideShown = sideOpen && window.innerWidth >= SIDE_NARROW;
  function sideRender() {
    const narrow = window.innerWidth < SIDE_NARROW;
    appEl.classList.toggle('side-closed', !sideShown);
    appEl.classList.toggle('side-float', sideShown && narrow);
    document.getElementById('side-open').hidden = sideShown && !narrow;
  }
  // Showing and hiding slides: docked, the sidebar slides off the left edge and the chat widens
  // with it; floating, it slides over the chat and the scrim fades. 200ms in, 150ms out, like the
  // project list. A second toggle mid-slide turns it around from where it is.
  const sideScrim = document.getElementById('side-scrim');
  let sideAnim = null;
  function slideSide(open, floating) {
    const w = sideEl.offsetWidth || 296;
    let from = open ? 0 : 1; // 0 = fully out, 1 = fully in
    if (sideAnim) {
      const cs = getComputedStyle(sideEl);
      const off = floating ? -new DOMMatrixReadOnly(cs.transform).m41 : -parseFloat(cs.marginLeft);
      from = Math.max(0, Math.min(1, 1 - (off || 0) / w));
      sideAnim.cancel();
    }
    const to = open ? 1 : 0;
    const at = (p) => (floating ? { transform: `translateX(${-(1 - p) * w}px)` } : { marginLeft: `${-(1 - p) * w}px` });
    const opts = { duration: (open ? 200 : 150) * Math.abs(to - from), easing: open ? 'cubic-bezier(.2,.7,.2,1)' : 'cubic-bezier(.4,0,.8,.4)' };
    const anim = sideEl.animate([at(from), at(to)], opts);
    if (floating) sideScrim.animate([{ opacity: from }, { opacity: to }], opts);
    sideAnim = anim;
    anim.onfinish = () => { if (sideAnim === anim) sideAnim = null; if (!open) sideRender(); };
  }
  function setSide(open) {
    const was = sideShown;
    sideShown = open;
    // Only a wide window's choice is remembered: a narrow one hides it for room, not by choice.
    if (window.innerWidth >= SIDE_NARROW) {
      sideOpen = open;
      try { mwStore.setItem(SIDE_KEY, open ? 'open' : 'closed'); } catch (e) { /* not remembered */ }
    }
    if (open === was && !sideAnim) { sideRender(); return; }
    const floating = open ? window.innerWidth < SIDE_NARROW : appEl.classList.contains('side-float');
    if (open) sideRender(); // shown first, then slid in; a hide stays shown until its slide ends
    slideSide(open, floating);
  }
  function closeSideIfFloating() {
    if (appEl.classList.contains('side-float')) setSide(false);
  }
  let sideWasNarrow = window.innerWidth < SIDE_NARROW;
  window.addEventListener('resize', () => {
    const narrow = window.innerWidth < SIDE_NARROW;
    if (narrow !== sideWasNarrow) sideShown = narrow ? false : sideOpen; // crossing the line: room decides, then your choice
    sideWasNarrow = narrow;
    sideRender();
  });
  // While the window is being resized, sizes follow at once instead of sliding after it (styles.css).
  let resizingTimer = null;
  window.addEventListener('resize', () => {
    document.documentElement.classList.add('resizing');
    clearTimeout(resizingTimer);
    resizingTimer = setTimeout(() => document.documentElement.classList.remove('resizing'), 150);
  });
  document.getElementById('side-hide').addEventListener('click', () => setSide(false));
  document.getElementById('side-open').addEventListener('click', () => setSide(!appEl.classList.contains('side-float')));
  document.getElementById('side-scrim').addEventListener('click', () => setSide(false));
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      setSide(!sideShown);
    }
  });
  document.getElementById('rail-sessions').addEventListener('click', () => sessionSearch.focus());
  // The session being worked in shows it: its time turns into a pulsing dot.
  const chatStatusForSide = document.getElementById('chat-status');
  new MutationObserver(() => sideEl.classList.toggle('working', chatStatusForSide.classList.contains('show')))
    .observe(chatStatusForSide, { attributes: true, attributeFilter: ['class'] });
  sideRender();

  // ── Composer attachments: images, files, long pastes ─────────────────
  // Everything waiting to go out with the next message sits in a tray above the
  // input. Images show as thumbnails, files as small cards, and a long paste as
  // a "Pasted text" card instead of flooding the box. Any of them opens on
  // click: an image full size, a file's contents, a paste in an editor that
  // changes what will be sent. The engine resolves files and pastes the same
  // way the CLI does (prepareMessage in turnRunner.ts).
  const attachBtn = document.getElementById('attach-btn');
  const attachInput = document.getElementById('attach-input');
  const attachRow = document.getElementById('attach-row');

  // Same thresholds as the CLI's prompt (PromptInput.tsx): a paste this big
  // becomes a card rather than text in the box.
  const PASTE_MIN_LINES = 6;
  const PASTE_MIN_CHARS = 400;

  let attachments = []; // { id, kind: 'image'|'file'|'paste', name, path?, size?, url?, text? }
  let attachSeq = 0;

  attachBtn.addEventListener('click', () => attachInput.click());

  // The one way files join the tray, for the + button and for drag and drop.
  // A File from disk carries its real path. One without a path (a photo dragged
  // out of a browser) is saved to a temp file first, so it attaches anyway
  // instead of vanishing: the engine needs a path to read it from.
  async function addFiles(files) {
    const list = Array.from(files || []);
    if (list.length === 0) return;
    for (const f of list) {
      let path = window.mw.pathForFile(f);
      if (!path) {
        try {
          path = await window.mw.saveTempFile(f.name || 'dropped', new Uint8Array(await f.arrayBuffer()));
        } catch {
          path = '';
        }
      }
      if (!path) continue;
      const isImage = /^image\//.test(f.type);
      attachments.push({
        id: ++attachSeq, kind: isImage ? 'image' : 'file', name: f.name || 'dropped file', path, size: f.size,
        // A local preview of the picked file itself; nothing is uploaded anywhere.
        url: isImage ? URL.createObjectURL(f) : null,
      });
    }
    renderAttachments();
  }

  attachInput.addEventListener('change', async () => {
    const files = Array.from(attachInput.files);
    attachInput.value = '';
    await addFiles(files);
  });

  // Text coming in (pasted or dropped): a big block becomes a card, anything
  // smaller is left to go into the box. Returns true when it took the text.
  function takeLongText(text) {
    const lines = text.split(/\r?\n/).length;
    if (lines < PASTE_MIN_LINES && text.length < PASTE_MIN_CHARS) return false;
    attachments.push({ id: ++attachSeq, kind: 'paste', name: 'Pasted text', text: text.replace(/\r\n/g, '\n') });
    renderAttachments();
    return true;
  }

  // (Its own lookup: this runs before the composer section declares composerInput.)
  document.getElementById('composer-input').addEventListener('paste', (e) => {
    if (takeLongText(e.clipboardData?.getData('text/plain') ?? '')) e.preventDefault();
  });

  // ── Drag and drop onto the chat ──────────────────────────────────────
  // Anywhere on the chat pane: files attach exactly like the + button; dropped
  // text behaves like a paste. Every other drop is swallowed, because by default
  // a file dropped on the window NAVIGATES to it and replaces the whole app.
  const dropOverlay = document.getElementById('drop-overlay');
  const dropPane = document.querySelector('.pane-chat');
  let dragDepth = 0;

  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const isTextDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('text/plain');

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  // A drag that starts in this window (text selected in the chat and moved) is not something
  // to attach: only drags from outside the app open the drop overlay.
  let dragFromHere = false;
  document.addEventListener('dragstart', () => { dragFromHere = true; });
  document.addEventListener('dragend', () => { dragFromHere = false; dragDepth = 0; dropOverlay.hidden = true; });

  dropPane.addEventListener('dragenter', (e) => {
    if (viewingAgent != null || dragFromHere) return; // an agent view is read only
    if (!isFileDrag(e) && !isTextDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    dropOverlay.querySelector('.drop-title').textContent = isFileDrag(e) ? 'Drop to attach' : 'Drop to add text';
    dropOverlay.hidden = false;
  });
  dropPane.addEventListener('dragover', (e) => {
    if (!isFileDrag(e) && !isTextDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  dropPane.addEventListener('dragleave', () => {
    // Child elements fire their own enter/leave; only the last leave hides it.
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  });
  dropPane.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.hidden = true;
    if (viewingAgent != null || dragFromHere) return;
    const dt = e.dataTransfer;
    if (dt.files && dt.files.length > 0) {
      await addFiles(dt.files);
    } else {
      const text = dt.getData('text/plain');
      if (text && !takeLongText(text)) {
        const box = document.getElementById('composer-input');
        const at = box.selectionStart ?? box.value.length;
        box.value = box.value.slice(0, at) + text + box.value.slice(box.selectionEnd ?? at);
        box.dispatchEvent(new Event('input'));
      }
    }
    document.getElementById('composer-input').focus();
  });

  function fmtBytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  }
  function extOf(name) {
    const m = /\.([A-Za-z0-9]{1,6})$/.exec(name || '');
    return m ? m[1].toUpperCase() : 'FILE';
  }
  function pasteMeta(text) {
    const lines = text.split('\n').length;
    return lines > 1 ? `${lines} lines` : `${text.length} chars`;
  }

  const X_SVG = '<svg viewBox="0 0 10 10"><path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
  const FILE_SVG = '<svg viewBox="0 0 16 16"><path d="M4 1.8h5l3 3v9.4H4z" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linejoin="round"/><path d="M9 1.8v3h3" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linejoin="round"/></svg>';
  const PASTE_SVG = '<svg viewBox="0 0 16 16"><rect x="3.5" y="2.8" width="9" height="11.4" rx="1.5" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M6 2.8h4v1.6H6zM5.8 7h4.4M5.8 9.3h4.4M5.8 11.6h2.6" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round"/></svg>';

  function renderAttachments() {
    attachRow.innerHTML = '';
    attachRow.hidden = attachments.length === 0;
    attachments.forEach((a) => {
      const el = document.createElement('div');
      el.className = `att att-${a.kind}`;
      el.title = a.kind === 'paste' ? 'Click to view or edit before sending' : (a.path || a.name);
      if (a.kind === 'image') {
        el.innerHTML = `<img alt="">`;
        const img = el.querySelector('img');
        img.addEventListener('error', () => { el.classList.add('att-broken'); img.remove(); el.insertAdjacentHTML('afterbegin', FILE_SVG); });
        img.src = a.url;
      } else {
        el.innerHTML = `
          <span class="att-ico">${a.kind === 'paste' ? PASTE_SVG : FILE_SVG}</span>
          <span class="att-text"><span class="att-name"></span><span class="att-meta"></span></span>`;
        el.querySelector('.att-name').textContent = a.kind === 'paste' ? firstLine(a.text) : a.name;
        el.querySelector('.att-meta').textContent = a.kind === 'paste'
          ? `Pasted · ${pasteMeta(a.text)}`
          : [extOf(a.name), fmtBytes(a.size)].filter(Boolean).join(' · ');
      }
      const x = document.createElement('button');
      x.className = 'att-x';
      x.setAttribute('aria-label', `Remove ${a.name}`);
      x.innerHTML = X_SVG;
      x.addEventListener('click', (e) => { e.stopPropagation(); removeAttachment(a.id); });
      el.appendChild(x);
      el.addEventListener('click', () => openAttachment(a.id));
      attachRow.appendChild(el);
    });
    updateSendButtonMode();
    scheduleDraftSave();
  }
  function firstLine(text) {
    const line = text.split('\n').find((l) => l.trim()) || 'Pasted text';
    return line.trim();
  }
  function removeAttachment(id) {
    const a = attachments.find((x) => x.id === id);
    if (a?.url) URL.revokeObjectURL(a.url);
    attachments = attachments.filter((x) => x.id !== id);
    renderAttachments();
  }
  function hasAttachments() {
    return attachments.length > 0;
  }
  // Everything in the tray, handed to a send and cleared from the composer.
  function takeAttachments() {
    const out = {
      filePaths: attachments.filter((a) => a.kind !== 'paste').map((a) => a.path),
      pastes: attachments.filter((a) => a.kind === 'paste').map((a) => a.text),
    };
    attachments.forEach((a) => a.url && URL.revokeObjectURL(a.url));
    attachments = [];
    renderAttachments();
    return out;
  }

  // ── Attachment viewer: image full size, file contents, paste editor ─────
  const viewer = document.getElementById('att-viewer');
  const viewerIco = document.getElementById('att-viewer-ico');
  const viewerName = document.getElementById('att-viewer-name');
  const viewerMeta = document.getElementById('att-viewer-meta');
  const viewerBody = document.getElementById('att-viewer-body');
  const viewerFoot = document.getElementById('att-viewer-foot');
  let viewing = null;

  async function openAttachment(id) {
    const a = attachments.find((x) => x.id === id);
    if (!a) return;
    viewing = a;
    viewer.dataset.kind = a.kind;
    viewerIco.innerHTML = a.kind === 'image' ? '' : a.kind === 'paste' ? PASTE_SVG : FILE_SVG;
    viewerIco.hidden = a.kind === 'image';
    viewerName.textContent = a.kind === 'paste' ? 'Pasted text' : a.name;
    viewerFoot.hidden = a.kind !== 'paste';
    viewerBody.innerHTML = '';
    if (a.kind === 'image') {
      viewerMeta.textContent = fmtBytes(a.size);
      const img = document.createElement('img');
      img.src = a.url;
      img.alt = a.name;
      img.addEventListener('load', () => { viewerMeta.textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${fmtBytes(a.size)}`; });
      img.addEventListener('error', () => {
        viewerBody.innerHTML = `<pre class="att-pre att-note">This image can't be previewed here. It is still attached, and the model will be told if it can't read it either.</pre>`;
      });
      viewerBody.appendChild(img);
    } else if (a.kind === 'paste') {
      const ta = document.createElement('textarea');
      ta.className = 'att-edit';
      ta.value = a.text;
      ta.spellcheck = false;
      // Sized to its text (see .att-edit in styles.css): the body scrolls, not the
      // textarea, so its scrollbar shows the arrow instead of the text I-beam.
      const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
      const syncMeta = () => { viewerMeta.textContent = pasteMeta(ta.value); };
      ta.addEventListener('input', () => { syncMeta(); fit(); });
      // Chromium keeps the last cursor over a scrollbar; heading right toward it,
      // switch to the arrow before the bar so it doesn't arrive as an I-beam.
      ta.addEventListener('mousemove', (e) => {
        ta.style.cursor = e.offsetX > ta.clientWidth - 16 ? 'default' : ''; // the empty right padding only
      });
      syncMeta();
      viewerBody.appendChild(ta);
      // Open at the top with the caret at the start: you read a paste from line 1.
      setTimeout(() => { fit(); ta.focus({ preventScroll: true }); ta.setSelectionRange(0, 0); viewerBody.scrollTop = 0; }, 0);
    } else {
      viewerMeta.textContent = [extOf(a.name), fmtBytes(a.size)].filter(Boolean).join(' · ');
      const pre = document.createElement('pre');
      pre.className = 'att-pre';
      pre.textContent = 'Loading…';
      viewerBody.appendChild(pre);
      const r = await window.mw.peekFile(a.path);
      if (viewing !== a) return;
      if (r.error) pre.textContent = `Couldn't read this file: ${r.error}`;
      else if (r.binary) { pre.classList.add('att-note'); pre.textContent = "This is a binary file, so there's nothing to preview.\nIt will be skipped when sent, and you'll be told."; }
      else pre.textContent = r.text + (r.clipped ? '\n\n… (preview shows the first 256 KB; the whole file is sent)' : '');
    }
    viewer.hidden = false;
  }
  async function openSentFile(path) {
    const v = { kind: 'sent', path };
    viewing = v;
    viewer.dataset.kind = 'file';
    viewerIco.innerHTML = FILE_SVG;
    viewerIco.hidden = false;
    viewerName.textContent = baseName(path);
    viewerFoot.hidden = true;
    viewerMeta.textContent = extOf(baseName(path)) || '';
    viewerBody.innerHTML = '';
    const pre = document.createElement('pre');
    pre.className = 'att-pre';
    pre.textContent = 'Loading…';
    viewerBody.appendChild(pre);
    viewer.hidden = false;
    const r = await window.mw.peekFile(path);
    if (viewing !== v) return;
    if (r.error) { pre.classList.add('att-note'); pre.textContent = "This file isn't on disk any more (it was moved or deleted). The agent still got its contents when you sent it."; return; }
    viewerMeta.textContent = [extOf(baseName(path)), fmtBytes(r.size)].filter(Boolean).join(' · ');
    if (r.binary) { pre.classList.add('att-note'); pre.textContent = "This is a binary file, so there's nothing to preview."; return; }
    // Shows the file as it is now; it may have changed since it was sent.
    pre.textContent = r.text + (r.clipped ? '\n\n… (showing the first 256 KB)' : '');
  }
  function closeViewer({ save } = {}) {
    if (viewing?.kind === 'notes') return closeNotesEditor({ save });
    if (save && viewing?.kind === 'paste') {
      const text = viewerBody.querySelector('.att-edit').value;
      if (text.trim()) viewing.text = text;
      else attachments = attachments.filter((x) => x.id !== viewing.id); // emptied = removed
      renderAttachments();
    }
    viewer.hidden = true;
    viewing = null;
    composerInput.focus();
  }
  document.getElementById('att-viewer-close').addEventListener('click', () => closeViewer());
  document.getElementById('att-viewer-cancel').addEventListener('click', () => closeViewer());
  document.getElementById('att-viewer-save').addEventListener('click', () => closeViewer({ save: true }));
  viewer.addEventListener('click', (e) => { if (e.target === viewer) closeViewer(); });
  window.addEventListener('keydown', (e) => {
    if (viewer.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeViewer(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (viewing?.kind === 'paste' || viewing?.kind === 'notes')) { e.preventDefault(); closeViewer({ save: true }); }
    else if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey) && viewing?.kind === 'notes') { e.preventDefault(); closeViewer({ save: true }); }
  }, true);

  // ── Fake "agent working" simulation ──────────────────────────────────
  // Demo only: sending a message plays out a scripted turn (working
  // indicator, a tool call landing live in both panes, a streamed reply)
  // so the "is it working" indicator we talked about can actually be seen,
  // not just described. Nothing here calls a real agent.
  const composerInput = document.getElementById('composer-input');
  const sendBtn = document.getElementById('send-btn');
  const chatBodyEl = document.querySelector('.chat-body');
  // ── Where you were reading, per session ──────────────────────────────────
  // Saved as you scroll (the store writes it at once), so coming back to a session, or reopening the
  // app, lands on the same spot instead of the bottom. At the bottom means "follow the conversation",
  // which is also what a fresh open does.
  let viewSessionId = null;
  let scrollHold = null; // while a saved spot is being put back, nothing overwrites or overrides it
  const SCROLL_KEY = 'mw:scroll:';
  const SCROLL_INDEX = 'mw:scroll-index';
  let scrollTimer = null;
  function saveScroll() {
    clearTimeout(scrollTimer);
    if (!viewSessionId || scrollHold) return;
    const max = chatBodyEl.scrollHeight - chatBodyEl.clientHeight;
    const top = Math.round(chatBodyEl.scrollTop);
    const viewTop = chatBodyEl.getBoundingClientRect().top;
    const row = [...chatBodyEl.querySelectorAll(':scope > [data-ev]')].find((el) => el.getBoundingClientRect().bottom > viewTop);
    const at = row ? { ev: row.dataset.ev, off: Math.round(row.getBoundingClientRect().top - viewTop) } : {};
    mwStore.setItem(SCROLL_KEY + viewSessionId, JSON.stringify({ top, bottom: max - top < 96, ...at }));
    // Only the most recent sessions keep a spot, so this never grows without end.
    let index = [];
    try { index = JSON.parse(mwStore.getItem(SCROLL_INDEX) || '[]'); } catch { /* none */ }
    if (index[0] !== viewSessionId) {
      index = [viewSessionId, ...index.filter((x) => x !== viewSessionId)];
      index.slice(40).forEach((old) => mwStore.removeItem(SCROLL_KEY + old));
      mwStore.setItem(SCROLL_INDEX, JSON.stringify(index.slice(0, 40)));
    }
  }
  chatBodyEl.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(saveScroll, 250); });
  window.addEventListener('pagehide', saveScroll);
  // Opening the app always lands on the latest message; the saved reading spot is only for coming back to
  // a session while the app is running.
  let launchOpen = true;
  function restoreScroll() {
    if (launchOpen) { launchOpen = false; scrollHold = null; pinToBottomForAMoment(); return; }
    let saved = null;
    try { saved = JSON.parse(mwStore.getItem(SCROLL_KEY + viewSessionId) || 'null'); } catch { /* none */ }
    const keep = !!saved && !saved.bottom && saved.top > 0;
    scrollHold = { keep };
    if (keep) {
      autoFollow = false;
      const put = () => {
        const row = saved.ev != null && chatBodyEl.querySelector(`:scope > [data-ev="${saved.ev}"]`);
        if (row) {
          chatBodyEl.scrollTop += row.getBoundingClientRect().top - chatBodyEl.getBoundingClientRect().top - (saved.off || 0);
          return;
        }
        chatScroller.scrollTo(Math.min(saved.top, chatBodyEl.scrollHeight - chatBodyEl.clientHeight), { instant: true });
      };
      put();
      requestAnimationFrame(put);
      setTimeout(put, 250);
      setTimeout(put, 900);
    }
    setTimeout(() => { scrollHold = null; }, 1500);
  }
  // Rows off screen start at an estimated height and settle as they come into view, which can leave the
  // view a little short of the end. For a moment after opening, keep it on the last message unless the
  // reader scrolls first.
  function pinToBottomForAMoment() {
    const until = performance.now() + 2500; // the fonts load in this time too, and change row heights
    let userMoved = false;
    const stop = () => { userMoved = true; };
    chatBodyEl.addEventListener('wheel', stop, { once: true, passive: true });
    chatBodyEl.addEventListener('pointerdown', stop, { once: true });
    window.addEventListener('keydown', (e) => { if (/^(Page|Arrow|Home|End)/.test(e.key)) stop(); }, { once: true });
    (function hold() {
      if (userMoved || performance.now() > until) return;
      chatBodyEl.scrollTop = chatBodyEl.scrollHeight;
      requestAnimationFrame(hold);
    })();
    document.fonts?.ready.then(() => { if (!userMoved) chatBodyEl.scrollTop = chatBodyEl.scrollHeight; });
  }
  // Whether new content should pull the view down — set from the user's OWN
  // wheel input (where they're actually scrolling TO), never recomputed from
  // post-append geometry.
  let autoFollow = true;
  const chatScroller = smoothScrollify(chatBodyEl, (target, max) => {
    autoFollow = max - target < 96;
  });

  // ── Jump to latest ────────────────────────────────────────────────────────
  // Shows once you are more than half a screen above the end; its dot lights when new rows arrive below
  // while you read. Reading up never pulls you down: only this button, sending, or opening does.
  const jumpBtn = document.getElementById('jump-latest');
  const jumpDot = jumpBtn.querySelector('.jl-dot');
  let jumpRaf = null;
  function updateJump() {
    jumpRaf = null;
    const away = chatBodyEl.scrollHeight - chatBodyEl.scrollTop - chatBodyEl.clientHeight;
    const show = away > chatBodyEl.clientHeight / 2;
    if (jumpBtn.hidden === show) jumpBtn.hidden = !show;
    if (!show) jumpDot.hidden = true;
  }
  const queueJump = () => { if (!jumpRaf) jumpRaf = requestAnimationFrame(updateJump); };
  chatBodyEl.addEventListener('scroll', queueJump, { passive: true });
  new MutationObserver(() => { if (!jumpBtn.hidden) jumpDot.hidden = false; queueJump(); }).observe(chatBodyEl, { childList: true });
  jumpBtn.addEventListener('click', () => {
    autoFollow = true;
    jumpDot.hidden = true;
    chatScroller.scrollTo(chatBodyEl.scrollHeight, { pin: true });
  });

  // Follow content that GROWS, not just content that's added: a streaming
  // reply, a tool card filling in its result, the composer's status strip
  // shrinking the pane. Only during a turn, and not right after a click in
  // the chat, so expanding a card you're reading doesn't yank you away.
  let lastChatClickAt = 0;
  chatBodyEl.addEventListener('pointerdown', () => { lastChatClickAt = performance.now(); });
  const followObserver = new ResizeObserver(() => {
    if (!autoFollow || !realTurnRunning) return;
    if (performance.now() - lastChatClickAt < 600) return;
    chatScroller.scrollTo(chatBodyEl.scrollHeight, { pin: true });
  });
  followObserver.observe(chatBodyEl);
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach((n) => { if (n.nodeType === 1) followObserver.observe(n); });
      m.removedNodes.forEach((n) => { if (n.nodeType === 1) followObserver.unobserve(n); });
    }
  }).observe(chatBodyEl, { childList: true });

  const sendIcon = document.getElementById('send-icon');
  const stopIcon = document.getElementById('stop-icon');

  // The send button IS the stop button while the agent is working and there's
  // nothing typed to send — the button you already know how to find, not a
  // second small control elsewhere that's easy to miss. The moment you start
  // typing it goes back to a send arrow, because typing while busy queues the
  // message (see chat:send in main.js) rather than stopping anything.
  function updateSendButtonMode() {
    const showStop = realTurnRunning && composerInput.value.trim() === '' && !hasAttachments();
    sendIcon.hidden = showStop;
    stopIcon.hidden = !showStop;
    sendBtn.title = needsKey ? 'Connect a provider to start' : showStop ? 'Stop' : 'Send';
    sendBtn.classList.toggle('is-stop', showStop);
    sendBtn.classList.toggle('locked', needsKey);
    sendBtn.setAttribute('aria-disabled', String(needsKey));
  }

  // Smart auto-follow: a new block only pulls the view down when you're
  // already near the bottom. Scrolled up reading an earlier tool call? New
  // activity lands quietly below instead of yanking you back — the thing
  // that makes a fast-moving turn feel like you keep losing your place.
  // `force` (the user's own message, loading a session) always follows.
  // While a whole session is being drawn, nothing scrolls per row: each scroll reads the page's height,
  // which lays out the whole growing page again, and a long session spent minutes doing only that.
  // The drawing scrolls once, at the end.
  let bulkDrawing = false;
  function scrollChatToBottom(force = false) {
    if (bulkDrawing) return;
    if (scrollHold?.keep) return; // a saved reading spot is being put back
    if (!force && !autoFollow) return;
    autoFollow = true;
    chatScroller.scrollTo(chatBodyEl.scrollHeight, { instant: force === 'instant', pin: true });
  }

  // ── Chat view's status strip (in the composer) ──
  const chatStatusEl = document.getElementById('chat-status');
  const csLabel = document.getElementById('cs-label');
  const csTime = document.getElementById('cs-time');
  const csTokens = document.getElementById('cs-tokens');
  let statusTimer = null;
  function fmtElapsed(s) {
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  // ── Live token counter — the same pure math as the CLI's dynamo/liveMeter.ts,
  // ported rather than shared (this file is a plain browser script with no access to
  // the compiled engine). The quantity is OUTPUT ONLY, estimated from streamed
  // characters, for the same reason the CLI counts it that way: input doesn't arrive
  // over time, so it's the only thing that can animate as counting rather than as a
  // jump-then-freeze. Reasoning deltas count too — the provider bills them as output
  // even though this app never shows the reasoning text itself.
  const LIVE_CHARS_PER_TOKEN = 4;
  const LIVE_TICK_MS = 50; // same clock the CLI ticks its status line on
  // Streamed characters only cover what the model SAYS. What it writes into tool calls (edits,
  // commands) never streams as text, so in a tool-heavy turn the estimate falls far behind. When a
  // call finishes its real output count arrives (a usage event), and replaces that call's estimate:
  // doneChars holds the finished calls at their true size, chars the call still in flight.
  let liveMeter = { chars: 0, shownChars: 0, doneChars: 0 };
  let liveMeterTimer = null;
  function meterDelta(count) {
    if (count > 0) liveMeter = { ...liveMeter, chars: liveMeter.chars + count };
  }
  function meterUsage(completionTokens) {
    if (!(completionTokens > 0)) return;
    liveMeter = { ...liveMeter, doneChars: liveMeter.doneChars + completionTokens * LIVE_CHARS_PER_TOKEN, chars: 0 };
  }
  function meterTick() {
    const gap = liveMeter.doneChars + liveMeter.chars - liveMeter.shownChars; // never counts down
    if (gap <= 0) return;
    const step = gap < 70 ? 3 : gap < 200 ? Math.max(8, Math.ceil(gap * 0.15)) : 50;
    liveMeter = { ...liveMeter, shownChars: Math.min(liveMeter.shownChars + step, liveMeter.doneChars + liveMeter.chars) };
  }
  function meterValue() {
    return Math.round(liveMeter.shownChars / LIVE_CHARS_PER_TOKEN);
  }
  // "8123 -> 8.1K", "56000 -> 56K", "540 -> 540" — the CLI's own dynamo/pricing.ts
  // formatTokens, so the figure reads the same shape in both places.
  function fmtLiveTokens(n) {
    if (n >= 10_000) return `${Math.round(n / 1000)}K`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  }
  function renderLiveTokens() {
    const got = meterValue();
    if (got > 0) { csTokens.hidden = false; csTokens.textContent = `· ↓ ${fmtLiveTokens(got)} tokens`; }
  }

  function setStatus(text) {
    csLabel.textContent = text;
    csLabel.title = text;
  }
  function startStatus() {
    const started = Date.now();
    setStatus('Thinking');
    csTime.textContent = '0s';
    liveMeter = { chars: 0, shownChars: 0, doneChars: 0 };
    csTokens.hidden = true;
    csTokens.textContent = '';
    clearInterval(statusTimer);
    statusTimer = setInterval(() => { csTime.textContent = fmtElapsed(Math.floor((Date.now() - started) / 1000)); }, 1000);
    clearInterval(liveMeterTimer);
    liveMeterTimer = setInterval(() => { meterTick(); renderLiveTokens(); }, LIVE_TICK_MS);
    chatStatusEl.classList.add('show');
    updateSendButtonMode();
  }
  function stopStatus() {
    clearInterval(statusTimer);
    statusTimer = null;
    clearInterval(liveMeterTimer);
    liveMeterTimer = null;
    chatStatusEl.classList.remove('show');
  }
  // Marks a turn as running when one starts without a send from this window
  // (a background task finishing wakes the agent on its own).
  function ensureTurnShown() {
    if (realTurnRunning || stoppedByUser) return;
    realTurnRunning = true;
    startStatus();
  }

  // A queued send gets its own bubble with a visible "Queued" badge right
  // away — not silently held back until the engine gets to it. When the
  // engine actually drains it (main.js's steer()), the SAME text arrives
  // again without the queued flag; rather than adding a second, duplicate
  // bubble, that just clears the badge off the one already on screen.
  let pendingQueuedBubbles = [];

  // ── Send it again ──────────────────────────────────────────────────────
  // When a message did not get an answer (the send failed, the agent was stopped, or it was cut off),
  // a "send again" icon sits on that message and on the row that says so. One click sends exactly what
  // was sent, files and pastes included, so nothing has to be typed twice. Only ever for the LAST turn.
  let lastRaw = null; // { text, filePaths, pastes } of the message last sent from this window
  function clearRetry() { chatBodyEl.querySelectorAll('.um-retry, .row-retry, .row-continue').forEach((b) => b.remove()); }
  function retrySend(raw) {
    if (!raw || !raw.text?.trim() || realTurnRunning) return;
    runRealTurn(raw.text, { filePaths: raw.filePaths || [], pastes: raw.pastes || [] });
  }
  function lastUserBubble() {
    const all = chatBodyEl.querySelectorAll('.user-msg:not([data-queued])');
    return all[all.length - 1] || null;
  }
  // What can be sent again: what this window sent, else a plain message read back from a reopened session
  // (one with pastes or files is not offered: those bytes are no longer to hand).
  function rawFor(bubble) {
    if (bubble?._raw) return bubble._raw;
    if (bubble && bubble.dataset.text && !/\[Pasted text \+\d+ lines\]/.test(bubble.dataset.text) && !bubble.classList.contains('has-images')) return { text: bubble.dataset.text, filePaths: [], pastes: [] };
    return lastRaw && !bubble ? lastRaw : null;
  }
  function retryButton(cls, raw) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = 'Send this again';
    b.setAttribute('aria-label', 'Send this again');
    b.innerHTML = ICON_RETRY;
    b.addEventListener('click', (ev) => { ev.stopPropagation(); clearRetry(); retrySend(raw); });
    return b;
  }
  // rowEl: the row that says what happened (an error, "interrupted"), or null when there is only the message.
  function offerRetry(rowEl) {
    const bubble = lastUserBubble();
    const raw = rawFor(bubble) || lastRaw;
    if (!raw || !raw.text?.trim()) return;
    if (bubble && !bubble.querySelector('.um-retry')) bubble.appendChild(retryButton('um-retry show', raw));
    if (rowEl && !rowEl.querySelector('.row-retry')) (rowEl.querySelector('.tool-head') || rowEl.querySelector('.msg-body') || rowEl).appendChild(retryButton('row-retry', raw));
  }
  // The end of the conversation says "(interrupted)": offer to send it again, or to let the agent carry on.
  // Or it ends on a message of yours that never got a reply: one click gets it answered, nothing retyped.
  function offerRetryIfInterrupted() {
    if (realTurnRunning) return;
    const last = chatBodyEl.lastElementChild;
    if (last?.classList.contains('msg') && /\(interrupted\)\s*$/.test(last.textContent || '')) {
      offerRetry(last);
      if (!last.querySelector('.row-continue')) {
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'settings-btn row-continue';
        go.textContent = 'Continue';
        go.title = 'Let the agent carry on from where it was cut off';
        go.addEventListener('click', (ev) => { ev.stopPropagation(); clearRetry(); runRealTurn('Continue from where you stopped.'); });
        (last.querySelector('.msg-body') || last).appendChild(go);
      }
      return;
    }
    if (last?.classList.contains('user-msg') && !last.querySelector('.um-retry')) {
      const fresh = document.createElement('button');
      fresh.type = 'button';
      fresh.className = 'um-retry show';
      fresh.title = 'Get a reply to this message';
      fresh.setAttribute('aria-label', 'Get a reply to this message');
      fresh.innerHTML = ICON_RETRY;
      fresh.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (realTurnRunning) return;
        ensureChatEventListener();
        const ok = await window.mw.chatContinue?.();
        if (!ok) return;
        clearRetry();
        stoppedByUser = false;
        realTurnRunning = true;
        startStatus();
        updateSendButtonMode();
      });
      last.appendChild(fresh);
    }
  }

  function addUserMessage(text, queued = false, expiredImages = [], images = [], files = [], noRewind = false) {
    if (!queued && pendingQueuedBubbles.length > 0 && pendingQueuedBubbles[0].text === text) {
      const { el } = pendingQueuedBubbles.shift();
      el.querySelector('.queued-badge')?.remove();
      return;
    }
    const bubble = document.createElement('div');
    bubble.className = 'user-msg enter';
    bubble.dataset.text = text;
    if (queued) bubble.dataset.queued = '1';
    else if (lastRaw && !lastRaw.claimed) { lastRaw.claimed = true; bubble._raw = lastRaw; }
    // Typed into a running turn (queued) or from before messages were stamped: there is
    // no point in the conversation to go back to, so no Edit, and not counted below.
    if (queued || noRewind) bubble.dataset.noRewind = '1';
    else {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'um-edit';
      edit.title = 'Edit and resend: go back to before this message';
      edit.innerHTML = ICON_EDIT;
      edit.addEventListener('click', (ev) => { ev.stopPropagation(); rewindFromBubble(bubble); });
      bubble.appendChild(edit);
    }
    if (images?.length) {
      bubble.classList.add('has-images');
      bubble.appendChild(imageThumbs(images));
    }
    if (files?.length) {
      bubble.classList.add('has-images');
      bubble.appendChild(fileCards(files));
    }
    const textEl = document.createElement('span');
    // A paste arrives as the engine's `[Pasted text +N lines]` marker (live and on a
    // reload alike) and is drawn as a small chip, not as that literal text.
    text.split(/(\[Pasted text \+\d+ lines\])/).forEach((part) => {
      const m = /^\[Pasted text \+(\d+) lines\]$/.exec(part);
      if (!m) { if (part) textEl.appendChild(document.createTextNode(part)); return; }
      const chip = document.createElement('span');
      chip.className = 'paste-chip';
      chip.textContent = `Pasted text · ${m[1]} lines`;
      textEl.appendChild(chip);
    });
    if (textEl.childNodes.length) bubble.appendChild(textEl);
    // An image the conversation has since dropped from context: a small chip,
    // not the engine's note to the model about it.
    for (const name of expiredImages || []) {
      const chip = document.createElement('span');
      chip.className = 'img-chip expired';
      chip.title = 'This image is no longer in the conversation. Attach it again if the agent needs it.';
      chip.textContent = name;
      bubble.appendChild(chip);
    }
    if (queued) {
      const badge = document.createElement('span');
      badge.className = 'queued-badge';
      badge.textContent = 'Queued';
      bubble.appendChild(badge);
      pendingQueuedBubbles.push({ text, el: bubble });
    }
    chatBodyEl.appendChild(bubble);
    scrollChatToBottom(true);
  }

  // Chat view shows tool calls in full (no separate Workspace pane to point
  // to), so every simulated action gets a matching .tool block alongside its
  // receipt — same pattern as the transcript already written into the page.

  // ── Open in your editor ─────────────────────────────────────────────────
  // Edits, writes and reads carry which files they touched (their call's arguments, live and
  // on reopening). Their row gets a button that opens the file in your editor; an edit opens
  // at the changed line. A read of several files lists them first; one click opens.
  const FILE_TOOLS = new Set(['edit', 'write_file', 'replace_symbol_body', 'read_file']);
  const OPEN_ICON_SVG = '<svg viewBox="0 0 14 14" fill="none"><path d="M8.5 2.5H11.5V5.5M11.5 2.5L6.5 7.5M10 8.5V11A.5.5 0 0 1 9.5 11.5H3A.5.5 0 0 1 2.5 11V4.5A.5.5 0 0 1 3 4H5.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function filesOf(tool, args) {
    if (!FILE_TOOLS.has(tool) || !args) return [];
    const list = tool === 'read_file' ? [].concat(args.paths ?? args.path ?? []) : [args.path];
    return [...new Set(list.filter((p) => typeof p === 'string' && p.trim()))];
  }
  // Where to open: a read's own start line, an edit's first changed line (its diff says "L58-67").
  function lineOf(tool, args, detail) {
    if (tool === 'read_file') return Number.isInteger(args?.offset) && args.offset > 0 ? args.offset : undefined;
    if (tool === 'write_file') return 1;
    const m = /(?:^|· )L(\d+)/.exec(String(detail || '').split('\n', 1)[0]);
    return m ? Number(m[1]) : undefined;
  }
  function addOpenButton(tool, e) {
    const files = filesOf(e.tool, e.args);
    if (!files.length || tool.querySelector('.tool-open')) return;
    tool._files = files;
    tool._fileTool = e.tool;
    tool._fileArgs = e.args;
    const btn = document.createElement('button');
    btn.className = 'tool-open';
    btn.type = 'button';
    btn.title = files.length > 1 ? 'Open a file in your editor' : 'Open in your editor';
    btn.setAttribute('aria-label', btn.title);
    btn.innerHTML = OPEN_ICON_SVG;
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation(); // the header's own click opens and closes the row
      if (tool._files.length === 1) void openFile(tool._files[0], tool._line, btn);
      else openFileMenu(tool, btn);
    });
    tool.querySelector('.tool-head .chev').before(btn);
  }
  async function openFile(file, line, btn) {
    const r = await window.mw.openFile(file, line);
    if (r?.error && btn) {
      btn.classList.add('failed');
      btn.title = r.error;
      setTimeout(() => btn.classList.remove('failed'), 1600);
    }
  }
  const fileMenu = document.createElement('div');
  fileMenu.className = 'qtab-menu file-menu';
  fileMenu.hidden = true;
  document.body.appendChild(fileMenu);
  fileMenu.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { fileMenu.hidden = true; });
  window.addEventListener('blur', () => { fileMenu.hidden = true; });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !fileMenu.hidden) { e.preventDefault(); e.stopImmediatePropagation(); fileMenu.hidden = true; }
  }, true);
  function openFileMenu(tool, btn) {
    closeQtabMenus();
    fileMenu.innerHTML = '';
    for (const file of tool._files) {
      const item = document.createElement('button');
      item.className = 'qtab-menu-item';
      const parts = file.split(/[\\/]/);
      const name = parts.pop();
      item.innerHTML = '<span class="fm-name"></span><span class="fm-dir"></span>';
      item.querySelector('.fm-name').textContent = name;
      item.querySelector('.fm-dir').textContent = parts.join('/');
      item.title = file;
      item.addEventListener('click', () => { fileMenu.hidden = true; void openFile(file, undefined, btn); });
      fileMenu.appendChild(item);
    }
    fileMenu.hidden = false;
    const r = btn.getBoundingClientRect();
    const m = fileMenu.getBoundingClientRect();
    fileMenu.style.left = `${Math.max(8, Math.min(r.right - m.width, window.innerWidth - m.width - 8))}px`;
    fileMenu.style.top = `${r.bottom + 6 + m.height > window.innerHeight ? r.top - m.height - 6 : r.bottom + 6}px`;
  }

  function addToolBlock({ iconPath, headText, tag, bodyHtml, kind = 'meta', state, into = toolHost(), noBody = false, sys = false }) {
    const tool = document.createElement('div');
    tool.className = 'tool enter';
    // `sys`: about the conversation, not a tool call; shown in both views (see .tool.sys).
    if (sys) tool.classList.add('sys');
    // `kind` picks the card's accent colour (read/edit/run/web…, see styles.css);
    // `state` drives the status mark on the right: running spinner, ✓ or ✗.
    tool.dataset.kind = kind;
    if (state) tool.classList.add(state);
    // `noBody`: nothing worth expanding into (see the compaction summary below) — the
    // existing `.tool.no-body` styling (find_tools rows use it too) drops the chevron
    // and hides the collapse, so there's nothing to click into a wall of text.
    if (noBody) tool.classList.add('no-body');
    tool.innerHTML = `
      <div class="tool-head">
        <span class="tool-ico"><svg viewBox="0 0 14 14">${iconPath}</svg></span>
        ${headText}
        ${tag ? `<span class="tag ${tag.cls}">${tag.text}</span>` : ''}
        <span class="tool-status"></span>
        <svg class="chev" viewBox="0 0 8 8"><path d="M3 1.5L5.5 4L3 6.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="tool-collapse"><div class="tool-body">${bodyHtml}</div></div>
    `;
    wireToolToggle(tool);
    wireTruncToggles(tool);
    into.appendChild(tool); // the main chat, a sub-agent's own view, or an open test
    if (into === chatBodyEl) scrollChatToBottom();
    else if (into.classList.contains('lt-steps')) scrollChatToBottom(); // the list follows itself
    return tool;
  }

  // Real tool output is arbitrary text — a file's own content, a shell command,
  // JSON — and was going straight into innerHTML unescaped. A `<` or `&` in
  // that text (routine in code: generics, comparisons, HTML/JSX source) broke
  // the DOM silently, which is a real cause of rows reading as one garbled
  // block, not just a styling problem.
  // A project's name in a label: capped width with "…", full name on hover, so a
  // long name never stretches a switch, tag or button.
  function projName(name) {
    return `<span class="pname" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // The agent writes markdown (**bold**, `code`, lists, fences). Raw HTML in
  // the reply is shown as text, never parsed, so a model echoing `<div>` or a
  // `<script>` from a file can't inject anything into the window.
  marked.use({
    gfm: true,
    breaks: true, // the model's single newlines are meant as line breaks
    renderer: { html: (token) => escapeHtml(token.text ?? token.raw) },
  });

  function renderMarkdown(el, text) {
    el.innerHTML = marked.parse(text);
    addOpenLinks(el);
  }

  // ── Files, folders and sites in what the agent says ────────────────────────
  // A path in inline code (`src/bus.ts`, `C:\Projects\app\`), a path at the start of a line
  // in a plain code block, and every web link get the same open button the tool rows have.
  // A path becomes one only once it is found on disk, so nothing offers to open what is not
  // there. Click: a file in your editor (at `:line` when given), a folder in Explorer, a site in
  // the browser. Right-click: the other ways.
  const LOOKS_LIKE_PATH = /^(?:[A-Za-z]:[\\/]|~[\\/]|%[A-Za-z_]+%|\$env:[A-Za-z_]+|\.{1,2}[\\/]|[\w@.-]+[\\/])[^\n]*$|^[\w@-][\w@.-]*\.[A-Za-z0-9]{1,8}(?::\d+){0,2}$/;
  const pathCache = new Map(); // text → { full, line, kind } | null, for the open project
  function pathCandidates(el) {
    const found = [];
    el.querySelectorAll('code').forEach((code) => {
      if (code.closest('pre') || code.closest('.path-link')) return;
      const t = code.textContent.trim();
      if (t.length > 1 && t.length < 260 && LOOKS_LIKE_PATH.test(t) && !/\s{2,}/.test(t)) found.push({ node: code, text: t });
    });
    // Plain code blocks (no language: a listing, not code): a path opening a line.
    el.querySelectorAll('pre > code').forEach((code) => {
      if (code.children.length || /language-/.test(code.className)) return;
      const lines = code.textContent.split('\n');
      if (!lines.some((l) => LOOKS_LIKE_PATH.test(l.trim().split(/\s{2,}/)[0] || ''))) return;
      code.textContent = '';
      lines.forEach((line, i) => {
        const lead = line.match(/^\s*/)[0];
        const head = line.slice(lead.length).split(/\s{2,}/)[0];
        if (head && LOOKS_LIKE_PATH.test(head)) {
          code.append(lead);
          const span = document.createElement('span');
          span.textContent = head;
          code.append(span);
          code.append(line.slice(lead.length + head.length));
          found.push({ node: span, text: head });
        } else code.append(line);
        if (i < lines.length - 1) code.append('\n');
      });
    });
    return found;
  }
  function addOpenLinks(el) {
    el.querySelectorAll('a[href^="http"]').forEach((a) => {
      if (a.nextElementSibling?.classList.contains('inline-open')) return;
      a.after(openButton({ kind: 'url', full: a.href }));
    });
    // A web address written as code rather than as a link.
    el.querySelectorAll('code').forEach((code) => {
      const t = code.textContent.trim();
      if (code.closest('pre') || !/^https?:\/\/\S+$/.test(t) || code.nextElementSibling?.classList.contains('inline-open')) return;
      code.after(openButton({ kind: 'url', full: t }));
    });
    const found = pathCandidates(el);
    const unknown = [...new Set(found.map((f) => f.text).filter((t) => !pathCache.has(t)))];
    const apply = () => {
      for (const { node, text } of found) {
        const hit = pathCache.get(text);
        if (!hit || !node.isConnected || node.classList.contains('path-link')) continue;
        node.classList.add('path-link');
        node.title = hit.full;
        node.after(openButton(hit));
      }
    };
    apply();
    if (unknown.length && window.mw?.checkPaths) {
      window.mw.checkPaths(unknown).then((real) => {
        for (const t of unknown) pathCache.set(t, real?.[t] || null);
        apply();
      }).catch(() => {});
    }
  }
  function openButton(target) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inline-open';
    btn._target = target;
    const what = target.kind === 'url' ? 'Open in your browser' : target.kind === 'dir' ? 'Open the folder' : 'Open in your editor';
    btn.title = `${what} (right-click for more)`;
    btn.setAttribute('aria-label', what);
    btn.innerHTML = OPEN_ICON_SVG;
    return btn;
  }
  function openTarget(t, how, btn) {
    const done = (r) => {
      if (!r?.error || !btn) return;
      btn.classList.add('failed');
      btn.title = r.error;
      setTimeout(() => btn.classList.remove('failed'), 1600);
    };
    if (t.kind === 'url') { if (how === 'copy') void navigator.clipboard.writeText(t.full); else window.mw.openExternal(t.full); return; }
    if (how === 'editor') { void window.mw.openFile(t.full, t.line).then(done); return; }
    void window.mw.openWith(t.full, how).then(done);
  }
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.inline-open');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const t = btn._target;
    openTarget(t, t.kind === 'dir' ? 'default' : 'editor', btn);
  });
  document.addEventListener('contextmenu', (e) => {
    const btn = e.target.closest('.inline-open') || e.target.closest('.path-link')?.nextElementSibling;
    if (!btn?.classList?.contains('inline-open')) return;
    e.preventDefault();
    const t = btn._target;
    const choices = t.kind === 'url'
      ? [['Open in browser', 'open'], ['Copy link', 'copy']]
      : t.kind === 'dir'
        ? [[FILE_MANAGER, 'default'], ['Open in editor', 'editor']]
        : [['Open in editor', 'editor'], ['Open with default app', 'default'], ['Show in folder', 'reveal']];
    openChoiceMenu(choices, e.clientX, e.clientY, (how) => openTarget(t, how, btn));
  });
  // Words that name the system: Windows' Explorer, macOS' Finder, and on Linux the file manager
  // of whichever desktop it is.
  const PLATFORM = window.mw?.platform || 'win32';
  // Linux: the page draws the window's round corners (main.js), square when maximised or full screen.
  if (PLATFORM === 'linux') {
    document.documentElement.classList.add('round-window');
    window.mw.onWindowSquare?.((square) => document.documentElement.classList.toggle('window-square', square));
  }
  // macOS: the system's own window buttons sit top left (styles.css makes room for them), and shortcuts
  // read ⌘ where they read Ctrl (both keys work).
  const MOD = PLATFORM === 'darwin' ? '⌘' : 'Ctrl';
  if (PLATFORM === 'darwin') {
    document.documentElement.classList.add('mac');
    for (const id of ['side-hide', 'side-open']) {
      const b = document.getElementById(id);
      if (b) b.title = b.title.replace('Ctrl+', '⌘');
    }
    const ctrlSend = document.querySelector('[data-send="ctrl"]');
    if (ctrlSend) ctrlSend.textContent = '⌘+Enter';
    document.querySelectorAll('.att-viewer-hint kbd').forEach((k) => { if (k.textContent === 'Ctrl') k.textContent = '⌘'; });
  }
  const OS_NAME = { win32: 'Windows', darwin: 'macOS' }[PLATFORM] || 'the system';
  const FILE_MANAGER = { win32: 'Open in Explorer', darwin: 'Show in Finder' }[PLATFORM] || 'Open in file manager';
  function openChoiceMenu(choices, x, y, pick) {
    closeQtabMenus();
    fileMenu.innerHTML = '';
    for (const [label, how] of choices) {
      const item = document.createElement('button');
      item.className = 'qtab-menu-item';
      item.textContent = label;
      item.addEventListener('click', () => { fileMenu.hidden = true; pick(how); });
      fileMenu.appendChild(item);
    }
    fileMenu.hidden = false;
    const m = fileMenu.getBoundingClientRect();
    fileMenu.style.left = `${Math.min(x, window.innerWidth - m.width - 8)}px`;
    fileMenu.style.top = `${Math.min(y, window.innerHeight - m.height - 8)}px`;
  }

  // A link must never navigate the app window itself — hand it to the OS browser.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('.md a[href]');
    if (!a) return;
    e.preventDefault();
    window.mw?.openExternal(a.href);
  });

  // A tool's argument (a command, a path) stays on the header's one line: CSS cuts it
  // with an ellipsis where the row runs out, so a wide window shows more of it. This
  // cap only keeps a huge argument out of the page; the full text is on the tooltip.
  function truncateMid(text, max = 400) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  // The tool-head's inner text: name plus an optional, escaped, truncated arg
  // — with the FULL value on the title tooltip, so nothing shown is ever a
  // lie, just short. Every toolStart-shaped row builds its head through this
  // one function so truncation can't be forgotten at a new call site.
  // The engine's display names ("Run", "Update") read as commands; a card reads
  // better as what it IS doing, then what it DID — "Running" becomes "Ran".
  const TOOL_VERBS = {
    Read: ['Reading', 'Read'], Update: ['Editing', 'Edited'], Write: ['Writing', 'Wrote'],
    Run: ['Running', 'Ran'], Search: ['Searching', 'Searched'], Map: ['Mapping', 'Mapped'],
    Fetch: ['Reading', 'Read'], WebSearch: ['Searching the web', 'Searched the web'],
    WindowCapture: ['Capturing', 'Captured'], Viewed: ['Viewing', 'Viewed'],
    Shell: ['Checking shells', 'Checked shells'], Todo: ['Updating todos', 'Updated todos'],
    Skill: ['Loading skill', 'Loaded skill'], Remember: ['Remembering', 'Remembered'],
    Tools: ['Looking for tools', 'Loaded tools'],
  };
  function toolVerb(name, done) {
    const v = TOOL_VERBS[name];
    return v ? v[done ? 1 : 0] : name;
  }
  // Mark a card's outcome — also flips its verb to past tense.
  function setToolState(tool, state) {
    tool.classList.remove('running', 'ok', 'failed');
    tool.classList.add(state);
    const verb = tool.querySelector('.tool-verb');
    if (verb && tool.dataset.name) verb.textContent = toolVerb(tool.dataset.name, state !== 'running');
  }
  // "+3 −1" chips for an edit. The diff's own label has the true counts ("L58-67 · −1 +10",
  // "new file · 91 lines"); the lines below it can be a shortened preview, so counting them
  // is only the fallback. The label itself is not shown (the chips say it).
  function diffStatsHtml(text) {
    let add = 0, del = 0;
    const label = /^[+\- @]/.test(text) ? '' : text.split('\n', 1)[0];
    const counted = label.match(/[−-](\d+)\s*\+(\d+)|\+(\d+)\s*[−-](\d+)/);
    const whole = label.match(/(?:new|whole) file · (\d+) lines?/);
    if (counted) { del = Number(counted[1] ?? counted[4]); add = Number(counted[2] ?? counted[3]); }
    else if (whole) add = Number(whole[1]);
    else for (const line of text.split('\n')) {
      if (/^\+(?!\+\+)/.test(line)) add++;
      else if (/^-(?!--)/.test(line)) del++;
    }
    if (!add && !del) return '';
    return `<span class="diff-stats">${add ? `<span class="a">+${add}</span>` : ''}${del ? `<span class="d">&minus;${del}</span>` : ''}</span>`;
  }

  function toolHeadHtml(name, arg) {
    const safeName = `<span class="tool-verb">${escapeHtml(name)}</span>`;
    if (!arg) return `<span class="tool-head-text">${safeName}</span>`;
    const full = escapeHtml(arg);
    const short = escapeHtml(truncateMid(arg));
    return `<span class="tool-head-text" title="${full}">${safeName} <span class="tool-arg">${short}</span></span>`;
  }

  // A long result (a shell command's real output, a big summary) collapses to
  // a few lines with a fade + "Show more" instead of dumping everything — the
  // chat-view fade ends on the page's own background, not a boxed panel's,
  // since a tool body here is deliberately unboxed.
  // A real +/- diff, colored per line like every editor does it — added lines
  // green, removed red, hunk markers dim, everything else plain. Each line is
  // escaped on its own so the coloring can't be defeated by content inside it.
  function diffLineHtml(text) {
    return text
      .split('\n')
      .map((line) => {
        const safe = escapeHtml(line) || '&nbsp;';
        // The sign gets the colour; the code itself stays readable on the tint.
        const signed = (cls) => `<div class="diff-line ${cls}"><span class="diff-sign">${line[0]}</span>${escapeHtml(line.slice(1)) || '&nbsp;'}</div>`;
        if (/^\+(?!\+\+)/.test(line)) return signed('diff-add');
        if (/^-(?!--)/.test(line)) return signed('diff-del');
        if (/^@@/.test(line)) return `<div class="diff-line diff-hunk">${safe}</div>`;
        return `<div class="diff-line">${safe}</div>`;
      })
      .join('');
  }

  // A command's block: its output, then the outcome line (`✓ 0 · 56.6s` / `✗ 1 · 3.2s`)
  // green or red. The command itself is in the header, so it is not written again here.
  function shellLineHtml(text) {
    return text
      .split('\n')
      .map((line) => {
        const safe = escapeHtml(line) || '&nbsp;';
        if (/^✓ /.test(line)) return `<div class="sh-line sh-ok">${safe}</div>`;
        if (/^✗ /.test(line)) return `<div class="sh-line sh-fail">${safe}</div>`;
        return `<div class="sh-line">${safe}</div>`;
      })
      .join('');
  }

  // Output past this many characters keeps its start and its end on screen, with a line saying how much
  // was left out: a command that prints megabytes (a verbose build) must not put megabytes on the page.
  const OUTPUT_CAP = 120000;
  function capOutput(text) {
    if (text.length <= OUTPUT_CAP) return text;
    const head = text.slice(0, OUTPUT_CAP * 0.7);
    const tail = text.slice(-OUTPUT_CAP * 0.3);
    const gone = text.length - head.length - tail.length;
    const lines = text.slice(head.length, text.length - tail.length).split('\n').length - 1;
    return `${head}\n… ${lines.toLocaleString('en-US')} lines (${Math.round(gone / 1024).toLocaleString('en-US')} KB) not shown …\n${tail}`;
  }
  function truncatedBlock(text, { max = 320, mono = true, diff = false, shell = false } = {}) {
    text = capOutput(String(text ?? ''));
    const inner = diff ? diffLineHtml(text) : shell ? shellLineHtml(text) : escapeHtml(text);
    const wrapClass = diff ? 'diff-block' : shell ? 'sh-block' : mono ? 'dim-l' : 'dim-l prose';
    if (text.length <= max) return `<div class="${wrapClass}">${inner}</div>`;
    return `
      <div class="trunc chat-trunc">
        <div class="trunc-body"><div class="${wrapClass}">${inner}</div></div>
        <div class="trunc-fade"></div>
        <button class="trunc-more" type="button">
          <svg viewBox="0 0 8 8"><path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="trunc-more-label">Show more</span>
        </button>
      </div>`;
  }

  // A finished tool's body, live or replayed. The engine's `detailFull` is the
  // uncut block (its `detail` is sized for a terminal row and ends in
  // "… (N more lines)"), so expanding shows everything.
  // The engine opens a command's output with `$ <command>`. The header already names the
  // command, so that part goes: the whole command when it is known (it can span lines),
  // else just the first line.
  function withoutCommandLine(detail, command) {
    const head = command ? `$ ${command}` : null;
    if (head && detail.startsWith(head)) return detail.slice(head.length).replace(/^\n/, '');
    return detail.startsWith('$ ') ? detail.replace(/^[^\n]*\n?/, '') : detail;
  }

  // What a row already says in its header is not said again under it. An edit's diff opens
  // with a label of its own ("L19 · −1 +1", "2 edits · L19-63", "new file · 91 lines"): the
  // header carries the file and its +/- counts, so the label goes and the lines start at once.
  function withoutDiffLabel(detail) {
    return /^[+\- @]/.test(detail) ? detail : detail.replace(/^[^\n]*\n?/, '');
  }
  // A summary that names the row's own subject ("edited packages/events/src/bus.ts · L18")
  // restates the header when the row has something of its own to show below it.
  function restatesHead(lead, arg) {
    const name = String(arg || '').split(/[\\/]/).pop().trim().toLowerCase();
    return !!name && lead.toLowerCase().includes(name);
  }

  function toolResultHtml(e, arg = e.arg) {
    let detail = e.detailFull || e.detail;
    if (detail && e.detailKind === 'shell') detail = withoutCommandLine(detail, arg);
    if (detail && e.detailKind === 'diff') detail = withoutDiffLabel(detail);
    // Some results explain themselves over several lines, quoting code (an edit that
    // matched in two places shows both). The first line is the sentence; the rest
    // keeps its line breaks and indentation instead of running together.
    const [lead, ...more] = (e.summary || '').split('\n');
    const rest = more.join('\n').replace(/^\n+|\s+$/g, '');
    // Said by the header already: a command's summary, an edit's, and any finished row's
    // that only names its own subject over content of its own. A failure always keeps its words.
    const saidAbove = !!detail && (e.detailKind === 'shell' || (e.ok !== false && (e.detailKind === 'diff' || restatesHead(lead, arg))));
    let html = saidAbove ? '' : truncatedBlock(lead, { mono: false });
    if (rest && !saidAbove) html += `<div class="tool-detail">${truncatedBlock(rest, { max: 600 })}</div>`;
    if (detail) {
      const cls = e.detailKind === 'diff' ? 'is-diff' : e.detailKind === 'shell' ? 'is-shell' : '';
      html += `<div class="tool-detail ${cls}">${truncatedBlock(detail, { max: 600, diff: e.detailKind === 'diff', shell: e.detailKind === 'shell' })}</div>`;
    }
    return html;
  }
  // Rows whose raw engine summary reads as internals ("loaded mcp_server,
  // references", "declined run_command") get their head rewritten to say what
  // happened, and no repeated summary line under it. Returns false for every
  // other row, which keeps the generic rendering. Shared by live and replay.
  function presentSpecialOutcome(tool, e) {
    const s = e.summary || '';
    const verbEl = tool.querySelector('.tool-verb');
    const textEl = tool.querySelector('.tool-head-text');
    const noBody = () => {
      tool.classList.add('no-body');
      tool.querySelector('.tool-body').innerHTML = '';
    };
    if (!e.ok && /^declined \S+$/.test(s)) {
      setToolState(tool, 'failed');
      tool.classList.replace('failed', 'declined');
      verbEl.textContent = 'Declined';
      addToolMeta(tool).textContent = 'by you';
      noBody();
      return true;
    }
    if (tool.dataset.name !== 'Tools' || !e.ok) return false;
    const loaded = /^loaded (.+)$/.exec(s);
    const none = /^no match for "(.*)"$/.exec(s);
    if (!loaded && !none && s !== 'nothing deferred') return false;
    setToolState(tool, 'ok');
    if (loaded) {
      const count = /^(\d+) tools?$/.exec(loaded[1]);
      if (count) {
        verbEl.textContent = `Loaded ${count[1]} tool${count[1] === '1' ? '' : 's'}`;
      } else {
        const names = loaded[1].split(', ').filter(Boolean);
        verbEl.textContent = names.length === 1 ? 'Loaded tool' : 'Loaded tools';
        textEl.insertAdjacentHTML('beforeend', `<span class="tool-chips">${names.map((n) => `<code class="tool-chip">${escapeHtml(n)}</code>`).join('')}</span>`);
      }
    } else if (none) {
      tool.classList.replace('ok', 'none'); // nothing went wrong; nothing was found
      verbEl.textContent = 'Found no tools';
    } else {
      verbEl.textContent = 'All tools already loaded';
    }
    noBody();
    return true;
  }

  // ── Pictures in the chat ─────────────────────────────────────────────
  // Images you attached and screenshots the agent took show as thumbnails;
  // clicking one fills the window with it. This page is a file:// page, so a
  // local picture loads straight from its path.
  function fileUrl(path) {
    return encodeURI(`file:///${String(path).replace(/\\/g, '/').replace(/^\/+/, '')}`).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }
  function baseName(path) { return String(path).split(/[\\/]/).pop(); }
  function imageThumbs(paths) {
    const row = document.createElement('div');
    row.className = 'img-thumbs';
    paths.forEach((path, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'img-thumb';
      btn.title = baseName(path);
      const img = document.createElement('img');
      img.src = fileUrl(path);
      img.alt = baseName(path);
      img.loading = 'lazy';
      img.draggable = false;
      // A picture that's since been moved or deleted: say so instead of a broken icon.
      img.addEventListener('error', () => { btn.classList.add('missing'); btn.disabled = true; btn.title = `${baseName(path)} (no longer on disk)`; btn.textContent = baseName(path); });
      img.addEventListener('load', () => scrollChatToBottom?.(false));
      btn.appendChild(img);
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); openLightbox(paths, i); });
      row.appendChild(btn);
    });
    return row;
  }
  // Files you sent: one card each, opening the file in the viewer to read.
  function fileCards(paths) {
    const row = document.createElement('div');
    row.className = 'file-cards';
    for (const path of paths) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'file-card';
      btn.title = path;
      const ext = extOf(baseName(path));
      btn.innerHTML = `<span class="fc-ico">${FILE_SVG}</span><span class="fc-name">${escapeHtml(baseName(path))}</span>${ext ? `<span class="fc-ext">${escapeHtml(ext)}</span>` : ''}`;
      btn.addEventListener('click', (ev) => { ev.stopPropagation(); openSentFile(path); });
      row.appendChild(btn);
    }
    return row;
  }
  function addToolImages(tool, paths) {
    if (!paths?.length) return;
    tool.classList.remove('no-body');
    tool.querySelector('.tool-body').appendChild(imageThumbs(paths));
  }

  let lightbox = null;
  function openLightbox(paths, index) {
    if (!lightbox) {
      lightbox = document.createElement('div');
      lightbox.className = 'lightbox';
      lightbox.hidden = true;
      lightbox.innerHTML = `
        <img class="lb-img" alt="">
        <div class="lb-bar"><span class="lb-name"></span><span class="lb-meta"></span></div>
        <button class="lb-nav lb-prev" type="button" aria-label="Previous"><svg viewBox="0 0 10 10"><path d="M6.5 2L3.5 5L6.5 8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button class="lb-nav lb-next" type="button" aria-label="Next"><svg viewBox="0 0 10 10"><path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button class="lb-close" type="button" aria-label="Close"><svg viewBox="0 0 10 10"><path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>`;
      document.body.appendChild(lightbox);
      const img = lightbox.querySelector('.lb-img');
      img.addEventListener('load', () => { lightbox.querySelector('.lb-meta').textContent = `${img.naturalWidth} × ${img.naturalHeight}`; });
      // Anywhere but the picture's arrows closes it.
      lightbox.addEventListener('click', (ev) => { if (!ev.target.closest('.lb-nav')) closeLightbox(); });
      lightbox.querySelector('.lb-prev').addEventListener('click', () => stepLightbox(-1));
      lightbox.querySelector('.lb-next').addEventListener('click', () => stepLightbox(1));
      window.addEventListener('keydown', (ev) => {
        if (lightbox.hidden) return;
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); closeLightbox(); }
        else if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepLightbox(-1); }
        else if (ev.key === 'ArrowRight') { ev.preventDefault(); stepLightbox(1); }
      }, true);
    }
    lightbox._paths = paths;
    lightbox._index = index;
    showLightboxImage();
    lightbox.hidden = false;
  }
  function showLightboxImage() {
    const path = lightbox._paths[lightbox._index];
    lightbox.querySelector('.lb-meta').textContent = '';
    lightbox.querySelector('.lb-img').src = fileUrl(path);
    const many = lightbox._paths.length > 1;
    lightbox.querySelector('.lb-name').textContent = many ? `${baseName(path)}  ·  ${lightbox._index + 1} of ${lightbox._paths.length}` : baseName(path);
    lightbox.querySelectorAll('.lb-nav').forEach((b) => { b.hidden = !many; });
  }
  function stepLightbox(d) {
    const n = lightbox._paths.length;
    if (n < 2) return;
    lightbox._index = (lightbox._index + d + n) % n;
    showLightboxImage();
  }
  function closeLightbox() { if (lightbox) lightbox.hidden = true; }

  // ── Web: one block per stretch of web work ───────────────────────────
  // Searches and page reads the agent does back to back become ONE block: what it is doing
  // now, with a single list of pages under it that grows as it goes. A search
  // adds the pages it found; a read marks that page as read (or adds it). Anything else
  // drawn in between (its words, another tool) starts a new block next time.
  // Titles and addresses come from the open web, so they only ever go in as text.
  const WEB_FIRST = 6; // lines that fit before the block folds behind "Show more"
  const WEB_STEP_MS = 450; // one page at a time, slowly enough to read each as it lands
  let openWeb = null; // the block the next web call joins, while nothing else came after it
  const webCalls = new Map(); // call id → { web: block state, start event }

  function siteOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url || ''); }
  }
  function fmtMs(ms) {
    return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  }
  const isUrl = (arg) => /^https?:\/\//i.test(arg || '');
  // Laid out like every other tool: the verb and its subject in the head, a dim line
  // saying what happened, then the pages in the same bordered block a command's output
  // uses, folding behind the same "Show more".
  function openWebBlock(start, live) {
    const block = addToolBlock({
      iconPath: TOOL_ICONS.websearch,
      headText: '<span class="tool-head-text"><span class="tool-verb"></span> <span class="tool-arg"></span></span>',
      bodyHtml: `
        <div class="dim-l prose web-summary"></div>
        <div class="tool-detail is-shell web-detail" hidden>
          <div class="trunc chat-trunc short">
            <div class="trunc-body"><div class="sh-block web-list"></div></div>
            <div class="trunc-fade"></div>
            <button class="trunc-more" type="button">
              <svg viewBox="0 0 8 8"><path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
              <span class="trunc-more-label">Show more</span>
            </button>
          </div>
        </div>`,
      kind: 'websearch',
      state: live ? 'running' : 'ok',
    });
    if (!live) block.classList.remove('enter');
    const web = {
      block,
      list: block.querySelector('.web-list'),
      detail: block.querySelector('.web-detail'),
      trunc: block.querySelector('.chat-trunc'),
      verbEl: block.querySelector('.tool-verb'),
      argEl: block.querySelector('.tool-arg'),
      summaryEl: block.querySelector('.web-summary'),
      meta: addToolMeta(block),
      rows: new Map(), // url → line
      lines: 0,
      pending: 0,
      done: [], // what each finished call did, in order: { search: “q” } or { read: site }
      queue: Promise.resolve(),
    };
    openWeb = web;
    return web;
  }
  /** The block this call belongs to: the open one if nothing came after it, else a new one. */
  function webBlockFor(start, live) {
    if (openWeb && openWeb.block.isConnected && openWeb.block === openWeb.block.parentElement?.lastElementChild) return openWeb;
    sealReply();
    return openWebBlock(start, live);
  }
  function lastChatBlock() {
    let el = chatBodyEl.lastElementChild;
    while (el && el === thinkingPlaceholder) el = el.previousElementSibling;
    return el;
  }
  /** The head says what it is doing now, then what it did; the dim line lists every step. */
  function webHead(web, running) {
    const total = web.rows.size;
    web.meta.textContent = total ? `${total} page${total === 1 ? '' : 's'}` : '';
    const searches = web.done.filter((d) => d.search);
    const reads = web.done.filter((d) => d.read);
    if (running) {
      web.verbEl.textContent = isUrl(running.arg) ? 'Reading' : 'Searching the web';
      web.argEl.textContent = isUrl(running.arg) ? siteOf(running.arg) : running.arg ? `“${running.arg}”` : '';
    } else if (searches.length) {
      web.verbEl.textContent = 'Searched the web';
      web.argEl.textContent = searches.length === 1 ? searches[0].search : `${searches.length} searches`;
    } else {
      web.verbEl.textContent = 'Read';
      web.argEl.textContent = reads.length === 1 ? reads[0].read : `${reads.length} pages`;
    }
    web.summaryEl.textContent = web.done.map((d) => (d.search ? `searched ${d.search}` : `read ${d.read}`)).join(' · ');
    web.summaryEl.hidden = !web.summaryEl.textContent;
    if (!running && web.pending === 0) setToolState(web.block, 'ok');
  }
  function webRow(url, title) {
    const row = document.createElement('div');
    row.className = 'sh-line web-line';
    row.title = url;
    row.innerHTML = '<span class="web-site"></span><span class="web-title"></span><span class="web-tag"></span>';
    row.querySelector('.web-site').textContent = siteOf(url);
    row.querySelector('.web-title').textContent = title && title !== url ? title : '';
    row.addEventListener('click', (ev) => { ev.stopPropagation(); window.mw?.openExternal?.(url); });
    return row;
  }
  /** Add a line: one at a time live, the block folding behind "Show more" once it is long. */
  function addWebRow(web, row, animate) {
    const place = () => {
      web.detail.hidden = false;
      web.lines++;
      // Short, it shows whole; past WEB_FIRST lines it folds exactly like command output.
      web.trunc.classList.toggle('short', web.lines <= WEB_FIRST);
      if (animate) row.classList.add('web-in');
      web.list.appendChild(row);
      if (animate) scrollChatToBottom();
    };
    if (!animate) return place();
    web.queue = web.queue.then(() => new Promise((r) => { place(); setTimeout(r, WEB_STEP_MS); }));
  }

  /** A web call started (live, or replayed with its result at once). */
  function webStart(e, live) {
    const web = webBlockFor(e, live);
    webCalls.set(e.id, { web, start: e });
    web.pending++;
    webHead(web, e);
    setToolState(web.block, 'running');
    return web;
  }
  /** Its result: pages to add, or the page to mark as read. */
  function webEnd(e, animate) {
    const call = webCalls.get(e.id);
    if (!call) return false;
    webCalls.delete(e.id);
    const { web, start } = call;
    web.pending--;
    const w = e.web;
    if (isUrl(start.arg) || w?.kind === 'fetch') web.done.push({ read: siteOf(w?.finalUrl || start.arg) });
    else web.done.push({ search: start.arg ? `“${start.arg}”` : 'the web' });
    if (w?.kind === 'search') {
      for (const src of w.sources) {
        if (web.rows.has(src.url)) continue;
        const row = webRow(src.url, src.title);
        web.rows.set(src.url, row);
        addWebRow(web, row, animate);
      }
    } else if (w?.kind === 'fetch') {
      let row = web.rows.get(w.finalUrl) || web.rows.get(w.url);
      if (!row) {
        row = webRow(w.finalUrl, w.title || '');
        web.rows.set(w.finalUrl, row);
        addWebRow(web, row, animate);
      } else if (w.title) row.querySelector('.web-title').textContent = w.title;
      row.classList.add('read');
      const tag = w.binary ? 'not text' : w.status >= 400 ? String(w.status) : 'read';
      row.querySelector('.web-tag').textContent = tag;
      if (w.status >= 400 || w.binary) row.classList.add('bad');
      const redirected = siteOf(w.url) !== siteOf(w.finalUrl) ? `\nredirected from ${siteOf(w.url)}` : '';
      row.title = `${w.finalUrl}${w.focus ? `\nlooking for: ${w.focus}` : ''}${redirected}`;
    } else {
      // Failed, or a model that cannot search: said in the dim line, like any tool's result.
      web.done[web.done.length - 1].note = e.summary || 'failed';
    }
    webHead(web, null);
    const notes = web.done.filter((d) => d.note).map((d) => d.note);
    if (notes.length) web.summaryEl.textContent += `${web.summaryEl.textContent ? ' · ' : ''}${notes.join(' · ')}`;
    web.summaryEl.hidden = !web.summaryEl.textContent;
    return true;
  }

  // ── Testing an app: one box per turn, one run per test ───────────────
  // While the agent tests an app, its steps, its words, the other work it does meanwhile
  // and a live view of the app sit together in one row: steps on the left, the app on the
  // right. Live is only there while the agent is acting.
  //
  // A turn gets ONE box. Testing again later in the same turn (the agent found a bug,
  // closed the app, fixed the code, and opens it again) does not open a second box: the
  // same box moves down to the bottom and starts a new run, with a tab per run in its head
  // so the earlier runs are still there to compare. Where it moved away from, a small row
  // is left that jumps back to it, so the history does not have a hole in it.
  //
  // Each run's recording is the frames of its app between its first and last step, with
  // long pauses (the model thinking) squeezed to a beat, so a recording is the testing,
  // not the waiting. A reopened session rebuilds the same box, runs and all.
  const TEST_GAP_MS = 700; // a pause longer than this plays as this long
  const TEST_TAIL_MS = 2000; // frames this long after a run's last step still belong to it
  const TEST_STEP_VERBS = {
    look: 'Looking at', click: 'Clicking', type: 'Typing', key: 'Pressing', scroll: 'Scrolling',
    hover: 'Hovering over', back: 'Going back', close: 'Closing',
    wait: 'Waiting for', resize: 'Resizing', inspect: 'Inspecting', steps: 'Running',
  };
  const TEST_START_VERB = { Look: 'look', Click: 'click', Type: 'type', Key: 'key', Scroll: 'scroll', Hover: 'hover', Back: 'back', Wait: 'wait', Resize: 'resize', Inspect: 'inspect', Steps: 'steps', Close: 'close' };
  let turnTest = null; // this turn's box, while the turn lasts
  const testCalls = new Map(); // tool call id → { test, run, step } or { close }
  const liveToTest = new Map(); // live id → box
  const lastFrameByLive = new Map(); // live id → latest frame, for a box not drawn yet

  function fmtClock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function newTestBox(appName) {
    const block = addToolBlock({
      iconPath: TOOL_ICONS.screenshot,
      headText: '<span class="tool-head-text"><span class="tool-verb">Testing</span> <span class="tool-arg"></span></span>',
      bodyHtml: `
        <div class="lt-body">
          <div class="lt-left"></div>
          <div class="lt-view">
            <div class="lt-screen">
              <img class="lt-frame" alt="" draggable="false">
              <div class="lt-empty">Waiting for the app…</div>
              <div class="lt-rec"><i></i>LIVE</div>
              <button class="lt-bigplay" type="button"><span><svg viewBox="0 0 12 12"><path d="M3 1.5L10.5 6L3 10.5Z" fill="currentColor"/></svg></span><em></em></button>
            </div>
            <div class="lt-bar">
              <button class="lt-pp" type="button" disabled></button>
              <div class="lt-track"><div class="lt-rail"></div><div class="lt-fill"></div><div class="lt-marks"></div><div class="lt-knob"></div></div>
              <span class="lt-clock">0:00</span>
            </div>
            <div class="lt-hint"></div>
          </div>
        </div>`,
      kind: 'screenshot',
      state: 'running',
      into: chatBodyEl,
    });
    block.classList.add('uitest');
    const head = block.querySelector('.tool-head');
    const tabs = document.createElement('span');
    tabs.className = 'lt-runs';
    tabs.hidden = true;
    const pill = document.createElement('span');
    pill.className = 'lt-live';
    pill.innerHTML = '<i></i><span>LIVE 0:00</span>';
    const score = document.createElement('span');
    score.className = 'lt-score';
    score.hidden = true;
    for (const el of [tabs, pill, score]) head.insertBefore(el, head.querySelector('.tool-status'));
    const test = {
      block,
      runs: [],
      active: null, // the run steps are going into, until it is closed or the turn ends
      view: null, // the run on screen
      ended: false, // the turn is over: the next test gets a new box
      argEl: block.querySelector('.tool-arg'),
      verbEl: block.querySelector('.tool-verb'),
      tabs,
      pill,
      pillClock: pill.querySelector('span'),
      score,
      left: block.querySelector('.lt-left'),
      screen: block.querySelector('.lt-screen'),
      img: block.querySelector('.lt-frame'),
      empty: block.querySelector('.lt-empty'),
      pp: block.querySelector('.lt-pp'),
      track: block.querySelector('.lt-track'),
      fill: block.querySelector('.lt-fill'),
      knob: block.querySelector('.lt-knob'),
      marks: block.querySelector('.lt-marks'),
      clock: block.querySelector('.lt-clock'),
      hint: block.querySelector('.lt-hint'),
      bigplayLabel: block.querySelector('.lt-bigplay em'),
    };
    test.argEl.textContent = appName || 'the app';
    wireTestPlayer(test);
    turnTest = test;
    return test;
  }

  /** A new run in the box. `streaming` is false when it is drawn from history; `show`
   *  false keeps the run on screen as it is (the box is still moving to where it goes). */
  function newRun(test, streaming, show = true) {
    const stepsEl = document.createElement('div');
    stepsEl.className = 'lt-steps';
    followSteps(stepsEl);
    test.left.appendChild(stepsEl);
    const run = {
      n: test.runs.length + 1,
      stepsEl,
      steps: [],
      sayEl: null,
      lives: [],
      streaming,
      closed: false,
      startWall: Date.now(),
      fromTs: streaming ? Date.now() - 500 : null,
      toTs: Infinity,
      rt: 0, // live recording clock, pauses squeezed
      lastTs: 0,
      lastFrame: null, // the latest live frame, for showing this run again while it is live
      frames: [], // its recording, once loaded
      loaded: false,
      end: 0,
      t: 0,
      playing: false,
    };
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'lt-run';
    tab.innerHTML = `<i></i>Run ${run.n}`;
    tab.addEventListener('click', (ev) => { ev.stopPropagation(); viewRun(test, run); });
    run.tab = tab;
    test.tabs.appendChild(tab);
    test.tabs.hidden = test.runs.length === 0; // shown from the second run on
    test.runs.push(run);
    test.active = run;
    if (streaming) {
      run.tick = setInterval(() => {
        if (run.closed || !test.block.isConnected) { clearInterval(run.tick); return; }
        if (test.view === run) test.pillClock.textContent = `LIVE ${fmtClock(Date.now() - run.startWall)}`;
      }, 1000);
    }
    if (show) viewRun(test, run);
    else drawRunHead(test);
    return run;
  }

  /**
   * The steps list keeps its newest line in view as it grows (a step added, the agent's
   * words streaming in, a row filling in its result), unless you scrolled it up to read.
   */
  function followSteps(list) {
    let stick = true;
    const follow = () => { if (stick && !list.hidden) list.scrollTop = list.scrollHeight; };
    list.addEventListener('scroll', () => { stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40; });
    const grown = new ResizeObserver(follow);
    new MutationObserver((changes) => {
      for (const c of changes) c.addedNodes.forEach((n) => { if (n.nodeType === 1) grown.observe(n); });
      follow();
    }).observe(list, { childList: true });
  }

  /** Put one run on screen: its steps on the left, its live view or recording on the right. */
  function viewRun(test, run) {
    const was = test.view;
    if (was && was !== run) was.playing = false;
    test.view = run;
    for (const r of test.runs) {
      r.stepsEl.hidden = r !== run;
      r.tab.classList.toggle('on', r === run);
    }
    const live = !run.closed && run.streaming;
    test.block.classList.toggle('is-live', live);
    test.pill.hidden = !live;
    test.screen.classList.toggle('replay', !live);
    test.track.classList.toggle('ready', run.loaded && run.frames.length > 0);
    test.pp.disabled = !(run.loaded && run.frames.length > 0);
    testSetPP(run, test);
    drawRunHead(test);
    if (live) {
      test.screen.classList.remove('ended');
      test.hint.textContent = 'Live while the agent tests. Its words while it tests stay in this box.';
      test.pillClock.textContent = `LIVE ${fmtClock(Date.now() - run.startWall)}`;
      if (run.lastFrame) paintFrame(test, run.lastFrame.src, run.lastFrame.w, run.lastFrame.h);
      else { test.img.removeAttribute('src'); test.screen.classList.remove('has-frame'); test.empty.textContent = 'Waiting for the app…'; }
      test.fill.style.width = '100%';
      test.clock.textContent = fmtClock(Date.now() - run.startWall);
    } else if (run.loaded && run.frames.length) {
      test.hint.textContent = 'Recording. Play it, drag the timeline, or click a step to jump to that moment.';
      test.bigplayLabel.textContent = `Replay · ${fmtClock(run.end)}`;
      testShow(test, run, run.t);
      test.screen.classList.toggle('ended', run.t >= run.end);
    } else {
      test.hint.textContent = run.loaded ? 'No recording was kept for this run.' : 'Loading the recording…';
      test.img.removeAttribute('src');
      test.screen.classList.remove('has-frame', 'ended');
      test.empty.textContent = run.loaded ? 'No recording' : 'Loading…';
      test.fill.style.width = '0%';
      test.clock.textContent = '0:00';
    }
    drawTestMarks(test);
  }

  /** The head says what is happening in the run on screen. */
  function drawRunHead(test) {
    const run = test.view;
    if (!run) return;
    const live = !run.closed && run.streaming;
    test.verbEl.textContent = live || (!run.closed && !test.ended) ? 'Testing' : 'Tested';
    const fails = run.steps.filter((s) => s.ok === false).length;
    const done = run.closed || test.ended;
    test.score.hidden = !done;
    if (done) {
      test.score.innerHTML = `<span class="t">${run.steps.length} step${run.steps.length === 1 ? '' : 's'}</span>` +
        `<span class="g">${run.steps.length - fails} passed</span>` + (fails ? `<span class="r">${fails} failed</span>` : '');
    }
    // The row's own ✓/✗ is the latest run's: the state the app was left in.
    const latest = test.runs[test.runs.length - 1];
    const latestFails = latest.steps.some((s) => s.ok === false);
    setToolState(test.block, !latest.closed && !test.ended ? 'running' : latestFails ? 'failed' : 'ok');
    for (const r of test.runs) {
      const bad = r.steps.some((s) => s.ok === false);
      r.tab.dataset.state = !r.closed && !test.ended ? 'live' : bad ? 'bad' : 'ok';
    }
  }

  function paintFrame(test, src, w, h) {
    if (test.img.getAttribute('src') !== src) test.img.src = src;
    test.screen.classList.add('has-frame');
    if (w && h) test.screen.style.aspectRatio = `${w} / ${h}`;
  }

  function testAssignLive(test, run, live) {
    if (!live || run.lives.includes(live)) return;
    run.lives.push(live);
    liveToTest.set(live, test);
    const pending = lastFrameByLive.get(live);
    if (pending && run.streaming && !run.closed) showLiveFrame(test, run, pending);
  }

  function showLiveFrame(test, run, e) {
    if (!run.lastTs) run.lastTs = e.ts;
    run.rt += Math.min(Math.max(0, e.ts - run.lastTs), TEST_GAP_MS);
    run.lastTs = Math.max(run.lastTs, e.ts);
    run.lastFrame = { src: `data:${e.mime};base64,${e.data}`, w: e.width, h: e.height };
    if (test.view !== run) return;
    paintFrame(test, run.lastFrame.src, e.width, e.height);
    test.clock.textContent = fmtClock(Date.now() - run.startWall);
    drawTestMarks(test);
  }

  /** A frame of the app under test arrived: draw it in its run, or keep it for the box
   *  about to be drawn (steps are paced, frames are not). */
  function applyUiLive(e) {
    if (e.kind === 'closed') { testAppClosed(e.live); return; }
    lastFrameByLive.set(e.live, e);
    let test = liveToTest.get(e.live);
    if (!test && turnTest?.active && turnTest.active.streaming && turnTest.active.lives.length === 0) {
      test = turnTest;
      testAssignLive(test, test.active, e.live);
      return;
    }
    const run = test?.active;
    if (run && run.streaming && !run.closed && run.lives.includes(e.live)) showLiveFrame(test, run, e);
    else if (run && run.streaming && !run.closed && test === turnTest) {
      testAssignLive(test, run, e.live); // the same run moved to another page of the app
    }
  }

  /** The app went away on its own (you closed it, or it quit): the run says so. */
  function testAppClosed(live) {
    const test = liveToTest.get(live);
    const run = test?.runs.find((r) => r.lives.includes(live));
    if (!run || run.appClosed) return;
    run.appClosed = true;
    run.streaming = false;
    const note = document.createElement('div');
    note.className = 'lt-closed enter';
    note.textContent = 'The app was closed.';
    run.stepsEl.appendChild(note);
    if (test.view === run) {
      test.pill.hidden = true;
      test.block.classList.remove('is-live');
      test.screen.classList.add('replay');
      test.hint.textContent = 'The app was closed. The agent carries on without it.';
    }
  }

  function stepLineHtml(action, target, input, pending) {
    const verb = TEST_STEP_VERBS[action] || action;
    const el = (s) => `<span class="el">${escapeHtml(s)}</span>`;
    const what = (s) => `<span class="what">${escapeHtml(s)}</span>`;
    if (pending !== undefined) return `<b>${escapeHtml(verb)}</b> ${pending ? what(pending) : ''}`;
    if (action === 'look') return input ? `<b>Opening</b> ${el(input.replace(/^https?:\/\//, '').replace(/\/$/, ''))}` : `<b>Looking at</b> ${what('the screen')}`;
    if (action === 'type') return `<b>Typing</b> ${what(`“${input ?? ''}” into`)} ${target ? el(target) : ''}`;
    if (action === 'key') return `<b>Pressing</b> ${what(input ?? 'a key')}${target ? ` ${what('in')} ${el(target)}` : ''}`;
    if (action === 'scroll') return `<b>Scrolling</b> ${what(input ?? 'down')}${target ? ` ${what('in')} ${el(target)}` : ''}`;
    if (action === 'back') return '<b>Going back</b>';
    if (action === 'wait') return `<b>Waiting for</b> ${what(`“${input ?? ''}”`)}`;
    if (action === 'resize') return `<b>Resizing</b> ${what(`the view to ${input ?? 'a new size'}`)}`;
    return `<b>${escapeHtml(verb)}</b> ${target ? el(target) : ''}`;
  }

  function addStepRow(test, run, html, animate) {
    run.sayEl = null;
    const row = document.createElement('div');
    row.className = `lt-step${animate ? ' enter' : ''}`;
    row.innerHTML = `<span class="lt-st run"></span><div class="lt-main"><div class="lt-line">${html}<span class="lt-t"></span></div></div>`;
    run.stepsEl.appendChild(row);
    const step = { row, rt: run.rt, ok: null, ui: null };
    run.steps.push(step);
    row.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!run.loaded || !run.frames.length) return;
      if (test.view !== run) viewRun(test, run);
      testSeek(test, run, step.rt, true);
    });
    return step;
  }

  function setStepResult(test, run, step, ui, fallback) {
    const ok = ui ? ui.ok : false;
    step.ok = ok;
    step.ui = ui || null;
    const mark = step.row.querySelector('.lt-st');
    mark.className = `lt-st ${ok ? 'ok' : 'bad'}`;
    mark.textContent = ok ? '✓' : '✕';
    if (ui) step.row.querySelector('.lt-line').innerHTML = `${stepLineHtml(ui.action, ui.target, ui.input)}<span class="lt-t"></span>`;
    const main = step.row.querySelector('.lt-main');
    main.querySelectorAll('.lt-why').forEach((w) => w.remove());
    const why = ui ? ui.why : fallback;
    if (why) main.insertAdjacentHTML('beforeend', `<div class="lt-why ${ok ? '' : 'bad'}">${escapeHtml(why)}</div>`);
    if (ui?.warn && ok) main.insertAdjacentHTML('beforeend', `<div class="lt-why warn">⚠ ${escapeHtml(ui.warn)}</div>`);
    if (ui?.dialogs?.length) main.insertAdjacentHTML('beforeend', `<div class="lt-why">${escapeHtml(ui.dialogs.join(' · '))}</div>`);
    if (ui && run.fromTs === null) run.fromTs = ui.startedAt - 500;
    if (test.view === run) { drawTestMarks(test); drawRunHead(test); }
  }

  /** Looking again turned up a page error: the step before it only looked fine. */
  function flipStep(test, run, step, why) {
    step.ok = false;
    const mark = step.row.querySelector('.lt-st');
    mark.className = 'lt-st bad flip';
    mark.textContent = '✕';
    const main = step.row.querySelector('.lt-main');
    main.querySelectorAll('.lt-why:not(.warn)').forEach((w) => w.remove());
    main.insertAdjacentHTML('beforeend', `<div class="lt-why bad">${escapeHtml(why)}</div>`);
    if (test.view === run) { drawTestMarks(test); drawRunHead(test); }
  }

  /** The box this step belongs in: this turn's, moved to the bottom as a new run when the
   *  last run was closed, or a new box for the first test of the turn. */
  function testForStep(appName, streaming, animate) {
    let test = turnTest && !turnTest.ended && turnTest.block.isConnected ? turnTest : null;
    if (!test) {
      test = newTestBox(appName);
      newRun(test, streaming);
      return test;
    }
    if (!test.active) {
      // While the box moves it still shows the run it is leaving; the new run takes the
      // screen once it has arrived.
      const moving = moveTestToBottom(test, animate, () => viewRun(test, test.runs[test.runs.length - 1]));
      newRun(test, streaming, !moving);
    }
    return test;
  }

  function isLastInChat(el) {
    let last = chatBodyEl.lastElementChild;
    while (last && last === thinkingPlaceholder) last = last.previousElementSibling;
    return last === el;
  }

  /**
   * Testing again: the box comes down to where the conversation is now. Where it was, a
   * small row stays behind that names the runs that happened there and jumps back to
   * them, so the history reads in order and nothing looks missing.
   */
  function moveTestToBottom(test, animate, arrived) {
    const block = test.block;
    if (isLastInChat(block)) return false;
    const runsHere = test.runs.filter((r) => !r.marker);
    const marker = testMarker(test, runsHere);
    block.before(marker);
    runsHere.forEach((r) => { r.marker = marker; });
    const place = () => chatBodyEl.insertBefore(block, thinkingPlaceholder?.parentElement === chatBodyEl ? thinkingPlaceholder : null);
    if (!animate || typeof block.animate !== 'function') {
      place();
      marker.classList.remove('enter');
      return false;
    }
    // Leaves by folding away (its height closing while it fades, so what is below slides
    // up rather than jumping), while the marker grows into the space; then it arrives at
    // the bottom, rising into place, with the chat following it down.
    const h = block.offsetHeight;
    const gap = parseFloat(getComputedStyle(chatBodyEl).rowGap) || 0;
    block.classList.add('lt-moving');
    block.style.overflow = 'hidden';
    const leave = block.animate(
      [
        { height: `${h}px`, opacity: 1, marginBottom: '0px' },
        { height: '0px', opacity: 0, marginBottom: `${-gap}px` },
      ],
      { duration: 280, easing: 'cubic-bezier(.4,0,.2,1)' },
    );
    leave.onfinish = () => {
      block.style.overflow = '';
      place();
      arrived?.();
      block.animate(
        [{ opacity: 0, transform: 'translateY(18px)' }, { opacity: 1, transform: 'none' }],
        { duration: 320, easing: 'cubic-bezier(.22,.61,.36,1)' },
      ).onfinish = () => block.classList.remove('lt-moving');
      // Follows it down only if the reader is still at the bottom: a long run moves blocks
      // constantly, and forcing the view down each time made scrolling up impossible.
      scrollChatToBottom();
    };
    return true;
  }

  /** The row left where a box used to be. */
  function testMarker(test, runs) {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'lt-moved enter';
    const fails = runs.reduce((n, r) => n + r.steps.filter((s) => s.ok === false).length, 0);
    const steps = runs.reduce((n, r) => n + r.steps.length, 0);
    const label = runs.length === 1 ? `Run ${runs[0].n}` : `Runs ${runs[0].n}–${runs[runs.length - 1].n}`;
    marker.innerHTML = `
      <span class="lt-moved-ico"><svg viewBox="0 0 14 14">${TOOL_ICONS.screenshot}</svg></span>
      <span class="lt-moved-text"><b>Tested</b> <span class="arg"></span> · ${label} · ${steps} step${steps === 1 ? '' : 's'}${fails ? ` · <span class="bad">${fails} failed</span>` : ''}</span>
      <span class="lt-moved-go">continued below<svg viewBox="0 0 10 10"><path d="M5 2V8M2.5 5.5L5 8L7.5 5.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
    marker.querySelector('.arg').textContent = test.argEl.textContent;
    marker.addEventListener('click', () => {
      viewRun(test, runs[0]);
      test.block.classList.remove('collapsed');
      test.block.scrollIntoView({ behavior: 'smooth', block: 'start' });
      test.block.classList.remove('lt-flash');
      void test.block.offsetWidth;
      test.block.classList.add('lt-flash');
    });
    return marker;
  }

  /** A `ui` call started: its step joins this turn's box. */
  function testStart(e, live) {
    const action = TEST_START_VERB[e.name] || 'look';
    if (action === 'close') {
      sealReply(); // its words so far are finished; whatever it says next is new
      testCalls.set(e.id, { close: true });
      return;
    }
    sealReply(); // words after this step start a new line under it
    // Other work landed after the box since its last step (a row the run did not close,
    // like a web search): this step starts a new run below it rather than reaching back.
    if (turnTest?.active && afterBox(turnTest).some((n) => !isAgentMsg(n))) closeRun();
    const test = testForStep(e.arg, live, true);
    const run = test.active;
    pullNarrationIn(test, run);
    // A frame may already be waiting from before this run was drawn.
    if (run.lives.length === 0) {
      const waiting = [...lastFrameByLive.keys()].filter((l) => !liveToTest.has(l));
      if (waiting.length === 1) testAssignLive(test, run, waiting[0]);
    }
    const step = addStepRow(test, run, stepLineHtml(action, null, null, e.arg || ''), true);
    drawRunHead(test);
    testCalls.set(e.id, { test, run, step, batch: e.name === 'Steps', rows: [] });
  }

  /** A call that runs several steps shows each one as it happens, one row after another. */
  function batchProgress(call, text) {
    const lines = String(text).split('\n').filter((l) => /^\d+\. /.test(l));
    for (let i = call.rows.length; i < lines.length; i++) {
      dropBatchHead(call);
      const bad = /^\d+\. Could not/.test(lines[i]);
      const row = addStepRow(call.test, call.run, `<span class="what">${escapeHtml(lines[i].replace(/^\d+\. /, ''))}</span>`, true);
      const mark = row.row.querySelector('.lt-st');
      mark.className = `lt-st ${bad ? 'bad' : 'ok'}`;
      mark.textContent = bad ? '✕' : '✓';
      row.ok = !bad;
      call.rows.push(row);
    }
    if (call.test.view === call.run) { drawTestMarks(call.test); drawRunHead(call.test); }
  }

  /** The row that said "4 steps" gives way to the steps themselves. */
  function dropBatchHead(call) {
    if (!call.step) return;
    call.step.row.remove();
    call.run.steps = call.run.steps.filter((x) => x !== call.step);
    call.step = null;
  }

  /** The finished batch: every step drawn as it was, with why it failed. */
  function finishBatch(call, e) {
    const { test, run } = call;
    const subs = e.ui?.steps;
    if (!subs?.length) { // nothing to draw it from: the one row says how it went
      if (call.step) applyStepResult(test, run, call.step, e.ui, e.summary);
      return;
    }
    dropBatchHead(call);
    subs.forEach((s, i) => {
      const row = call.rows[i] || addStepRow(test, run, '', !call.replay);
      call.rows[i] = row;
      setStepResult(test, run, row, { live: e.ui.live, action: s.action, target: s.target, input: s.input, ok: s.ok, why: s.why, app: e.ui.app, startedAt: e.ui.startedAt, endedAt: e.ui.endedAt }, undefined);
    });
    testAssignLive(test, run, e.ui.live);
    if (e.ui.app) test.argEl.textContent = e.ui.app;
    if (e.ui.errors?.length) {
      const last = [...call.rows].reverse().find((r) => r.ok);
      if (last) flipStep(test, run, last, e.ui.errors[0]);
    }
  }

  /** A step still under way says what it is waiting on (an app still building). */
  function testProgress(e) {
    const call = testCalls.get(e.id);
    if (call?.batch) { batchProgress(call, e.text); return; }
    if (!call?.step) return;
    const main = call.step.row.querySelector('.lt-main');
    let line = main.querySelector('.lt-wait');
    if (!line) {
      line = document.createElement('div');
      line.className = 'lt-why lt-wait';
      main.appendChild(line);
    }
    line.textContent = e.text;
  }

  /** Its result: the step turns green or red, and says why. */
  function testEnd(e) {
    const call = testCalls.get(e.id);
    if (!call) return false;
    testCalls.delete(e.id);
    if (call.close) {
      closeRun('close');
      return true;
    }
    if (call.batch) {
      finishBatch(call, e);
      return true;
    }
    const { test, run, step } = call;
    if (e.quiet) {
      step.row.remove();
      run.steps = run.steps.filter((x) => x !== step);
      return true;
    }
    applyStepResult(test, run, step, e.ui, e.summary);
    return true;
  }

  function applyStepResult(test, run, step, ui, summary) {
    if (ui) {
      testAssignLive(test, run, ui.live);
      if (ui.app) test.argEl.textContent = ui.app;
    }
    setStepResult(test, run, step, ui, ui ? undefined : summary);
    if (ui && ui.action === 'look' && ui.errors?.length) {
      const prev = run.steps[run.steps.length - 2];
      if (prev && prev.ok) flipStep(test, run, prev, ui.errors[0]);
    }
  }

  function drawTestMarks(test) {
    const run = test.view;
    if (!run) return;
    const recorded = run.loaded && run.frames.length;
    const end = recorded ? Math.max(run.end, 1) : Math.max(run.rt, 1);
    test.marks.innerHTML = run.steps
      .map((s) => `<div class="lt-mk ${s.ok === null ? 'run' : s.ok ? 'ok' : 'bad'}" style="left:${Math.min(100, (s.rt / end) * 100)}%"></div>`)
      .join('');
  }

  /**
   * The run on screen is over: the agent closed the app, you sent a message, or the turn
   * ended. Whatever came after its last step (closing words, a note written, a check
   * run) goes back out to the chat, where the answer and the rest of the work belong.
   */
  function closeRun() {
    const test = turnTest;
    const run = test?.active;
    if (!run) return;
    if (currentReplyMsg && test.block.contains(currentReplyMsg)) sealReply();
    test.active = null;
    run.closed = true;
    run.sayEl = null;
    clearInterval(run.tick);
    const lastStep = [...run.steps].reverse().find((s) => s.ui);
    run.toTs = run.streaming ? Date.now() + TEST_TAIL_MS : (lastStep ? lastStep.ui.endedAt + TEST_TAIL_MS : Infinity);
    // Everything after its last step is no longer testing (a summary, a note written, a
    // check run): it goes back out to the chat, in order, like any other turn's work.
    const lastStepRow = run.steps.at(-1)?.row;
    const tail = [];
    for (let n = lastStepRow ? lastStepRow.nextElementSibling : null; n; n = n.nextElementSibling) {
      if (!n.classList.contains('lt-closed')) tail.push(n);
    }
    let at = test.block;
    for (const n of tail) {
      n.remove();
      let out = n;
      if (n.classList.contains('lt-say')) {
        out = buildMsgEl();
        if (!run.streaming) out.classList.remove('enter');
        const body = document.createElement('div');
        body.className = 'md';
        renderMarkdown(body, n._text || n.textContent);
        out.querySelector('.msg-body').appendChild(body);
      }
      at.after(out);
      at = out;
    }
    if (test.view === run) viewRun(test, run);
    else drawRunHead(test);
    void loadRecording(test, run);
  }

  /** The turn is over: its box is done, and the next test starts a new one. */
  function endTest() {
    if (!turnTest) return;
    closeRun();
    turnTest.ended = true;
    drawRunHead(turnTest);
    turnTest = null;
  }

  /** Fetch a run's frames from disk and make its recording playable. */
  async function loadRecording(test, run) {
    let frames = [];
    for (const live of run.lives) {
      try {
        const list = await window.mw?.recording?.(live);
        if (Array.isArray(list)) frames = frames.concat(list);
      } catch {
        // No recording for this one; the steps still stand.
      }
    }
    // Only this run's stretch: the same app can be tested again in a later run.
    const from = run.fromTs ?? -Infinity;
    frames = frames.filter((f) => f.ts >= from && f.ts <= run.toTs).sort((a, b) => a.ts - b.ts);
    let rt = 0;
    let lastTs = frames[0]?.ts ?? 0;
    run.frames = frames.map((f) => {
      rt += Math.min(Math.max(0, f.ts - lastTs), TEST_GAP_MS);
      lastTs = f.ts;
      return { path: f.path, ts: f.ts, rt, w: f.w, h: f.h };
    });
    for (const s of run.steps) {
      if (!s.ui) continue;
      const i = run.frames.findIndex((f) => f.ts >= s.ui.startedAt);
      s.rt = i >= 0 ? run.frames[i].rt : (run.frames.at(-1)?.rt ?? 0);
      const t = s.row.querySelector('.lt-t');
      if (t && run.frames.length) t.textContent = fmtClock(s.rt);
    }
    run.end = run.frames.at(-1)?.rt ?? 0;
    run.t = run.end;
    run.loaded = true;
    // Preload so scrubbing does not wait on the disk for each frame.
    run.preload = run.frames.map((f) => { const im = new Image(); im.src = fileUrl(f.path); return im; });
    if (test.view === run) viewRun(test, run);
  }

  function testFrameAt(run, t) {
    let lo = 0, hi = run.frames.length - 1, at = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (run.frames[mid].rt <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return run.frames[at];
  }

  function testShow(test, run, t) {
    run.t = Math.max(0, Math.min(run.end, t));
    if (test.view !== run) return;
    const f = testFrameAt(run, run.t);
    if (f) paintFrame(test, fileUrl(f.path), f.w, f.h);
    const k = run.end ? run.t / run.end : 1;
    test.fill.style.width = `${k * 100}%`;
    test.knob.style.left = `${k * 100}%`;
    test.clock.textContent = `${fmtClock(run.t)} / ${fmtClock(run.end)}`;
    let current = null;
    for (const s of run.steps) if (s.rt <= run.t + 1) current = s;
    run.steps.forEach((s) => s.row.classList.toggle('now', s === current));
  }

  function testSetPP(run, test) {
    test.pp.innerHTML = run.playing
      ? '<svg viewBox="0 0 12 12"><rect x="2.5" y="2" width="2.6" height="8" rx=".6" fill="currentColor"/><rect x="6.9" y="2" width="2.6" height="8" rx=".6" fill="currentColor"/></svg>'
      : '<svg viewBox="0 0 12 12"><path d="M3 1.8L10.2 6L3 10.2Z" fill="currentColor"/></svg>';
  }

  function testPlay(test, run) {
    if (!run.frames.length) return;
    if (run.t >= run.end - 30) run.t = 0;
    test.screen.classList.remove('ended');
    run.playing = true;
    testSetPP(run, test);
    const from = run.t;
    let start = 0;
    const tick = (now) => {
      if (!run.playing || test.view !== run || !test.block.isConnected) return;
      if (!start) start = now;
      const t = from + (now - start);
      if (t >= run.end) {
        testShow(test, run, run.end);
        run.playing = false;
        testSetPP(run, test);
        test.screen.classList.add('ended');
        return;
      }
      testShow(test, run, t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function testPause(test, run) {
    run.playing = false;
    testSetPP(run, test);
  }

  function testSeek(test, run, t, pause) {
    if (!run.frames.length) return;
    const was = run.playing;
    run.playing = false;
    test.screen.classList.toggle('ended', t >= run.end);
    testShow(test, run, t);
    if (was && !pause) testPlay(test, run);
    else testSetPP(run, test);
  }

  function wireTestPlayer(test) {
    test.pp.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const run = test.view;
      if (run) run.playing ? testPause(test, run) : testPlay(test, run);
    });
    test.block.querySelector('.lt-bigplay').addEventListener('click', (ev) => { ev.stopPropagation(); if (test.view) testPlay(test, test.view); });
    let dragging = false;
    const seekFrom = (ev) => {
      const run = test.view;
      const r = test.track.getBoundingClientRect();
      testSeek(test, run, ((ev.clientX - r.left) / r.width) * run.end, true);
    };
    test.track.addEventListener('pointerdown', (ev) => {
      const run = test.view;
      if (!run || !run.loaded || !run.frames.length) return;
      ev.stopPropagation();
      dragging = true;
      test.track.setPointerCapture(ev.pointerId);
      seekFrom(ev);
    });
    test.track.addEventListener('pointermove', (ev) => { if (dragging) seekFrom(ev); });
    test.track.addEventListener('pointerup', () => { dragging = false; });
    test.block.querySelector('.lt-view').addEventListener('click', (ev) => ev.stopPropagation());
  }

  /** Where a new tool row goes: always the chat. Any other work (an edit, a command, a
   *  read) ends the stretch of testing, so the run closes; testing again later is a new
   *  run, and the box comes down to it. */
  function toolHost() {
    if (turnTest?.active) closeRun();
    return chatBodyEl;
  }

  /** What sits in the chat after the test box, in order. */
  function afterBox(test) {
    const out = [];
    for (let n = test.block.nextElementSibling; n; n = n.nextElementSibling) {
      if (n !== thinkingPlaceholder) out.push(n);
    }
    return out;
  }
  function isAgentMsg(n) {
    return n.classList.contains('msg') && !n.classList.contains('user-msg');
  }

  /**
   * A step is starting in an open run: what the agent said since the last step was a
   * line between steps, so it moves into the run, above the new step. Only agent words
   * are moved, and only when nothing else came after the box.
   */
  function pullNarrationIn(test, run) {
    if (!run) return;
    const tail = afterBox(test);
    if (tail.length === 0 || !tail.every(isAgentMsg)) return;
    for (const n of tail) {
      const say = document.createElement('div');
      say.className = 'lt-say';
      say.innerHTML = `${AGENT_MARK_SVG}<div class="md"></div>`;
      say._text = n._text ?? n.querySelector('.msg-body')?.textContent ?? '';
      renderMarkdown(say.querySelector('.md'), say._text);
      n.remove();
      run.stepsEl.appendChild(say);
    }
    run.sayEl = null;
  }

  /** The agent is speaking while a run is open: its words go into the run. */
  function testSayTarget() {
    const run = turnTest?.active;
    if (!run) return null;
    // A new line whenever anything landed after the current one (a step, or other work
    // like an edit): words after it belong after it, not glued onto the line above.
    if (!run.sayEl || run.sayEl !== run.stepsEl.lastElementChild) {
      const say = document.createElement('div');
      say.className = 'lt-say enter';
      say.innerHTML = `${AGENT_MARK_SVG}<div class="md"></div>`;
      say._text = '';
      run.stepsEl.appendChild(say);
      run.sayEl = say;
    }
    return run.sayEl;
  }
  /** Replay: that message is complete; the next one gets its own line. */
  function testSayDone() {
    if (turnTest?.active) turnTest.active.sayEl = null;
  }

  /** A saved session: the same box, drawn from its steps, with its recordings. */
  function replayTestStep(e) {
    const action = TEST_START_VERB[e.name] || e.ui?.action || 'look';
    if (action === 'close') { closeRun(); return; }
    const test = testForStep(e.ui?.app || e.arg, false, false);
    const run = test.active;
    if (action === 'steps') {
      finishBatch({ test, run, step: null, rows: [], replay: true }, e);
      return;
    }
    const step = addStepRow(test, run, stepLineHtml(action, null, null, e.arg || ''), false);
    applyStepResult(test, run, step, e.ui, e.summary);
  }

  // A short dim fact on the right of a row's head ("lines 1–745 · 3 reads").
  function addToolMeta(tool) {
    const meta = document.createElement('span');
    meta.className = 'tool-meta';
    tool.querySelector('.tool-head').insertBefore(meta, tool.querySelector('.tool-status'));
    return meta;
  }
  function addDiffStats(tool, e) {
    if (e.detailKind !== 'diff') return;
    const stats = diffStatsHtml(e.detailFull || e.detail || '');
    if (stats) tool.querySelector('.tool-status').insertAdjacentHTML('beforebegin', stats);
  }

  function wireTruncToggles(root) {
    root.querySelectorAll('.trunc').forEach((trunc) => {
      const btn = trunc.querySelector('.trunc-more');
      const label = btn.querySelector('.trunc-more-label');
      const moreText = label.textContent;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation(); // inside a clickable .tool-head — don't also toggle collapse
        toggleTrunc(trunc, label, moreText);
      });
    });
  }

  const TOOL_ICONS = {
    read: '<path d="M2 5.5H9M6 2.5L9 5.5L6 8.5" stroke="currentColor" stroke-width="1.1" fill="none"/>',
    search: '<circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M9 9L12 12" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>',
    edit: '<path d="M9 2L12 5L5 12H2V9L9 2Z" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linejoin="round"/>',
    write: '<path d="M9 2L12 5L5 12H2V9L9 2Z" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linejoin="round"/>',
    run: '<path d="M4.5 3.5L11 7L4.5 10.5V3.5Z" fill="currentColor"/>',
    websearch: '<circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M2 7H12M7 2C5.5 3.6 5.5 10.4 7 12M7 2C8.5 3.6 8.5 10.4 7 12" stroke="currentColor" stroke-width="1.1" fill="none"/>',
    // A window with a pointer in it: looking at an app, or using one.
    screenshot: '<rect x="1.5" y="2.5" width="11" height="8.5" rx="1.2" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M1.5 5H12.5" stroke="currentColor" stroke-width="1.1"/><path d="M6.5 6.5V10.5L7.6 9.4L8.6 11.3L9.4 10.9L8.4 9H10Z" fill="currentColor"/>',
    agent: '<circle cx="4.5" cy="7" r="1.6" stroke="currentColor" stroke-width="1.1" fill="none"/><circle cx="10" cy="4" r="1.6" stroke="currentColor" stroke-width="1.1" fill="none"/><circle cx="10" cy="10" r="1.6" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M6 6.3L8.5 4.7M6 7.7L8.5 9.3" stroke="currentColor" stroke-width="1.1"/>',
  };
  const DEFAULT_TOOL_ICON = '<circle cx="7" cy="7" r="2" fill="currentColor"/>';

  let realTurnRunning = false;
  const openToolBlocks = new Map();
  // agentId -> { block, rail, rows: Map<toolId, rowEl> } — a spawned sub-agent's
  // own tool calls nest under its block instead of joining the main stream.
  const openSubagents = new Map();
  // Consecutive "discovery" calls (reads, searches — anything the engine marks
  // `group: true`, mirroring the CLI's own discovery group in toolDisplay.ts)
  // fold into ONE block with a growing list inside it, instead of each getting
  // its own full-width row — 6 reads in a row was filling the whole screen.
  let openGroup = null; // { block, list, countEl, count }
  const openGroupRows = new Map();
  // Lookup and todo calls not drawn yet (see toolStart): id → start event.
  const heldLookups = new Map();

  /**
   * A result the engine marks quiet never stays on screen, the same as in the CLI: a step
   * the agent resolves by itself (an edit that did not match, retried) is not something
   * the user can act on. The model still gets the whole result.
   */
  function dropQuietTool(id) {
    const merged = mergedReadIds.get(id);
    if (merged) {
      mergedReadIds.delete(id);
      merged.pending--;
      merged.count--;
      merged.metaEl.textContent = readMetaText(merged);
      setReadRecState(merged);
      return;
    }
    const forgetRec = (rec) => { for (const [k, v] of readRecs) if (v === rec) readRecs.delete(k); };
    const row = openGroupRows.get(id);
    if (row) {
      openGroupRows.delete(id);
      const g = row._group;
      if (row._readRec) forgetRec(row._readRec);
      row.remove();
      g.count--;
      if (g.count <= 0) {
        g.block.remove();
        if (openGroup === g) openGroup = null;
      } else {
        g.countEl.textContent = ` — ${g.count} step${g.count > 1 ? 's' : ''}`;
        if (![...openGroupRows.values()].some((r) => r._group === g)) setToolState(g.block, g.failed ? 'failed' : 'ok');
      }
      return;
    }
    const tool = openToolBlocks.get(id);
    if (tool) {
      openToolBlocks.delete(id);
      if (tool._readRec) forgetRec(tool._readRec);
      tool.remove();
    }
  }

  // toolStart/subagentStart are PACED (see below) but their matching end event
  // is not — a fast call's end can genuinely arrive before its start has been
  // drawn yet. Dropping it left the start's block stuck on "running…" forever
  // once it finally rendered; this holds the end until the start catches up.
  const renderedIds = new Set();
  const pendingEndResults = new Map();
  let currentReplyMsg = null;
  let currentReplyP = null;
  let currentReplyText = '';
  let removeChatEventListener = null;

  function ensureChatEventListener() {
    if (removeChatEventListener || !window.mw?.onChatEvent) return;
    removeChatEventListener = window.mw.onChatEvent(handleChatEvent);
  }

  // Same sparkle everywhere the agent speaks — a live reply and a replayed one
  // should look like the same thing, not two different renderers.
  const AGENT_MARK_SVG = '<svg class="msg-mark" viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.5" fill="currentColor"/></svg>';

  function buildMsgEl() {
    const msg = document.createElement('div');
    msg.className = 'msg enter';
    msg.innerHTML = AGENT_MARK_SVG + '<div class="msg-body"></div>';
    return msg;
  }

  // Shown the instant a turn starts, right where the reply will land — not a
  // separate status pill elsewhere on screen. The first real content (text OR
  // a tool call) replaces or removes it in place, so it reads as "the agent is
  // about to say something here," not a disconnected loading state.
  let thinkingPlaceholder = null;

  function addThinkingPlaceholder() {
    const msg = buildMsgEl();
    msg.querySelector('.msg-body').innerHTML = '<p class="thinking-dots"><span></span><span></span><span></span></p>';
    chatBodyEl.appendChild(msg);
    thinkingPlaceholder = msg;
    msg.classList.add('live'); // about to speak: the dot blinks until it is done
    // Not forced: a run adds one every turn, and someone reading further up must stay there.
    // (Their own message scrolls to the bottom by itself, in addUserMessage.)
    scrollChatToBottom();
  }

  function removeThinkingPlaceholder() {
    if (!thinkingPlaceholder) return;
    thinkingPlaceholder.remove();
    thinkingPlaceholder = null;
  }

  function beginReply() {
    if (currentReplyMsg) return;
    // Live words always start in the chat, even while a test is open: nothing tells yet
    // whether they are a line between two steps or the answer. The next step pulls them
    // into the test (pullNarrationIn); the answer never has one, so it never moves.
    if (thinkingPlaceholder) {
      // Swap in place — the placeholder BECOMES the reply, not a second block
      // appearing next to it.
      currentReplyMsg = thinkingPlaceholder;
      thinkingPlaceholder = null;
      currentReplyMsg.classList.add('live');
      currentReplyMsg.querySelector('.msg-body').innerHTML = '';
    } else {
      currentReplyMsg = buildMsgEl();
      currentReplyMsg.classList.add('live');
      chatBodyEl.appendChild(currentReplyMsg);
    }
    currentReplyP = document.createElement('div');
    currentReplyP.className = 'md';
    currentReplyText = '';
    currentReplyMsg.querySelector('.msg-body').appendChild(currentReplyP);
  }

  // Deltas arrive many per frame; re-parse the whole reply at most once a frame.
  let replyRenderQueued = false;
  function queueReplyRender() {
    if (replyRenderQueued) return;
    replyRenderQueued = true;
    // A long reply is drawn whole each time; past ~20K characters, a few times a second is plenty.
    const draw = () => {
      replyRenderQueued = false;
      if (currentReplyP) renderMarkdown(currentReplyP, currentReplyText);
      scrollChatToBottom();
    };
    if (currentReplyText.length > 20000) setTimeout(draw, 200); else requestAnimationFrame(draw);
  }

  // Words that waited behind a paced row are let into the reply as a fast catch-up instead of one
  // block: a share of what is left each frame, so a long backlog flows in in roughly a fifth of a
  // second and the words still streaming in behind it join the same flow, in order.
  let drainBuf = '';
  let drainRaf = null;
  function drainStep() {
    drainRaf = null;
    if (!drainBuf) return;
    const n = drainBuf.length <= 60 ? drainBuf.length : Math.max(60, Math.ceil(drainBuf.length * 0.22));
    const chunk = drainBuf.slice(0, n);
    drainBuf = drainBuf.slice(n);
    renderChatEvent({ type: 'text', delta: chunk });
    if (drainBuf) drainRaf = requestAnimationFrame(drainStep);
  }
  /** Add words to the reply through the flow. The first piece lands at once, so the reply exists
   *  the moment its slot comes up (what arrives next must find it, not start another). */
  function drainText(text) {
    drainBuf += text;
    if (drainRaf) { cancelAnimationFrame(drainRaf); drainRaf = null; }
    drainStep();
  }
  /** Whatever is still on its way goes in now: before anything seals the reply. */
  function flushDrain() {
    if (drainRaf) { cancelAnimationFrame(drainRaf); drainRaf = null; }
    if (!drainBuf) return;
    const rest = drainBuf;
    drainBuf = '';
    renderChatEvent({ type: 'text', delta: rest });
  }

  // A reply seals the moment the next thing lands (a tool call, or the next
  // message) so two replies in the same turn (e.g. after a steered message)
  // don't run their text together in one paragraph.
  function sealReply() {
    flushDrain(); // the words still flowing in belong to THIS reply
    if (currentReplyP) renderMarkdown(currentReplyP, currentReplyText); // flush a frame-pending render
    if (currentReplyMsg) currentReplyMsg._text = currentReplyText; // what a test step may pull in
    currentReplyMsg?.classList.remove('live'); // done speaking: the dot stops and stays
    currentReplyMsg = null;
    currentReplyP = null;
    // NOT the queued reveal's text: a reply waiting in the pace queue behind a
    // tool row is sealed-past by that row when the row draws, and wiping its
    // buffer here is what drew an empty bubble in its place.
    removeThinkingPlaceholder();
    openGroup = null; // whatever comes next is not part of the group that was open
    openWeb = null;
  }

  // ── Reveal pacing — same idea as the CLI's revealPace.ts ─────────────────
  // A turn's events don't arrive evenly (a model can fan out and finish four
  // tool calls within milliseconds of each other), and without a beat that
  // looks like nothing happened and then a wall of rows landed at once. Each
  // block in the queue below waits a flat 2s behind the one before it —
  // unconditional, so a fast turn still reads as work happening rather than
  // an instant dump. Text is the deliberate exception: once a reply starts
  // streaming it stays live, because a quick reply should still look quick —
  // only the reply's FIRST token waits for a turn in the queue like everything
  // else.
  const REVEAL_GAP_MS = 2000;
  const PACED_TYPES = new Set(['toolStart', 'activity', 'compactionStart', 'compaction', 'compactionEnd', 'notice', 'error', 'subagentStart', 'done']);
  let revealQueue = [];
  let revealTimer = null;
  // The reply whose first words are waiting in the queue: its OWN text, not a
  // shared buffer, so nothing that runs before it can empty it.
  let pendingText = null; // { text, fn }
  let lastQueuedFn = null;

  function pumpReveal() {
    if (revealTimer || revealQueue.length === 0) return;
    revealTimer = setTimeout(() => {
      revealTimer = null;
      const fn = revealQueue.shift();
      fn();
      pumpReveal();
    }, REVEAL_GAP_MS);
  }

  // Everything waiting in the pace queue, drawn now, in order.
  function flushReveal() {
    clearTimeout(revealTimer);
    revealTimer = null;
    while (revealQueue.length) revealQueue.shift()();
  }

  function paceReveal(fn) {
    revealQueue.push(fn);
    lastQueuedFn = fn;
    pumpReveal();
  }

  // ── Approval dock — the desktop side of ctx.requestApproval ─────────────
  // One at a time, same as the CLI: a tool that needs to ask (a Sentinel gate,
  // a forbidden-path lift, ask_user) blocks on this until the user answers.
  // Same gesture as the CLI's ApprovalBox: ↑/↓ to move, Enter to choose, a
  // number picks and commits in one key, Esc declines. A typed answer is one
  // more row in the list, so "No" is reachable exactly like the others.
  const approvalDock = document.getElementById('approval-dock');
  const approvalTitle = document.getElementById('approval-title');
  const approvalQuestion = document.getElementById('approval-question');
  const approvalDetail = document.getElementById('approval-detail');
  const approvalOptions = document.getElementById('approval-options');
  const approvalHint = document.getElementById('approval-hint');
  let approval = null; // { id, rows, sel, input, shownAt }
  const APPROVAL_KEY_GRACE_MS = 700;

  // "Action: Shell execution / Command: $ … / File: …" reads better as labelled
  // rows than as a raw block. Anything not in that shape stays plain text.
  function renderApprovalDetail(detail) {
    approvalDetail.innerHTML = '';
    const lines = String(detail).split('\n');
    const pairs = [];
    for (const line of lines) {
      const m = /^([A-Z][\w ]{0,20}):\s(.*)$/.exec(line);
      if (m) pairs.push([m[1], m[2]]);
      else if (pairs.length) pairs[pairs.length - 1][1] += '\n' + line;
      else { pairs.length = 0; break; }
    }
    if (!pairs.length) {
      const pre = document.createElement('div');
      pre.className = 'ad-plain';
      pre.textContent = detail;
      approvalDetail.appendChild(pre);
      return;
    }
    for (const [k, v] of pairs) {
      const row = document.createElement('div');
      row.className = 'ad-row';
      const key = document.createElement('span');
      key.className = 'ad-k';
      key.textContent = k;
      const val = document.createElement('span');
      val.className = k === 'Command' || k === 'File' || k === 'Tool' ? 'ad-v mono' : 'ad-v';
      val.textContent = k === 'Command' ? v.replace(/^\$ /, '') : v;
      row.append(key, val);
      approvalDetail.appendChild(row);
    }
  }

  function setApprovalSel(i) {
    if (!approval) return;
    const n = approval.rows.length;
    approval.sel = (i + n) % n;
    approval.rows.forEach((r, j) => r.classList.toggle('on', j === approval.sel));
    const row = approval.rows[approval.sel];
    const onText = row === approval.textRow;
    if (onText) approval.input.focus();
    else if (document.activeElement === approval.input) approval.input.blur();
    approvalHint.innerHTML = onText
      ? '<kbd>Enter</kbd> send · empty just says no · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Esc</kbd> decline'
      : `<kbd>↑</kbd><kbd>↓</kbd> or <kbd>1</kbd>–<kbd>${n}</kbd> · <kbd>Enter</kbd> choose · <kbd>Esc</kbd> decline`;
  }

  // undefined → main.js resolves it to APPROVAL_DISMISSED, which every gate
  // treats as a refusal (Sentinel fails safe: an unclear answer never runs).
  function answerApproval(choice) {
    if (!approval) return;
    const { id } = approval;
    approval = null;
    approvalDock.hidden = true;
    approvalDock.parentElement.classList.remove('asking');
    syncComposerLock();
    window.mw.approvalRespond(id, choice);
  }

  function commitApprovalRow() {
    const row = approval.rows[approval.sel];
    if (row === approval.textRow) {
      const v = approval.input.value.trim();
      answerApproval(v ? ` text:${v}` : undefined);
    } else {
      answerApproval(row.dataset.choice);
    }
  }

  function showApprovalRequest({ id, question, options, detail, detailTitle, freeText, kind }) {
    // One box for every decision the agent waits on; the badge says which kind.
    approvalDock.dataset.kind = kind || 'permission';
    approvalTitle.textContent = kind === 'plan' ? 'Plan' : kind === 'question' ? 'Question' : (detailTitle || 'Approval');
    approvalQuestion.textContent = question;
    approvalDetail.classList.toggle('is-plan', kind === 'plan');
    if (detail && kind === 'plan') {
      // A plan is the thing being agreed to: shown in full, formatted, scrollable.
      approvalDetail.innerHTML = '';
      const md = document.createElement('div');
      md.className = 'md';
      renderMarkdown(md, detail);
      approvalDetail.appendChild(md);
      approvalDetail.hidden = false;
      approvalDetail.scrollTop = 0;
    } else if (detail) { renderApprovalDetail(detail); approvalDetail.hidden = false; }
    else approvalDetail.hidden = true;

    approvalOptions.innerHTML = '';
    const rows = [];
    let textRow = null;
    let input = null;
    const addRow = (label) => {
      const row = document.createElement('div');
      row.className = 'ad-opt';
      row.setAttribute('role', 'option');
      row.innerHTML = `<span class="ad-num">${rows.length + 1}</span><span class="ad-label"></span>`;
      row.querySelector('.ad-label').textContent = label;
      const idx = rows.length;
      row.addEventListener('mouseenter', () => { if (approval && approval.sel !== idx) setApprovalSel(idx); });
      rows.push(row);
      approvalOptions.appendChild(row);
      return row;
    };
    options.forEach((opt) => {
      const row = addRow(opt);
      row.dataset.choice = opt;
      row.addEventListener('click', () => answerApproval(opt));
    });
    if (freeText) {
      textRow = addRow(freeText.label);
      textRow.classList.add('ad-text');
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'ad-input';
      input.placeholder = freeText.placeholder || '';
      input.spellcheck = false;
      textRow.appendChild(input);
      textRow.addEventListener('click', (e) => {
        if (e.target === input) return;
        if (approval.sel === rows.indexOf(textRow)) commitApprovalRow();
        else setApprovalSel(rows.indexOf(textRow));
      });
      input.addEventListener('focus', () => { if (approval && approval.rows[approval.sel] !== textRow) setApprovalSel(rows.indexOf(textRow)); });
    }

    approval = { id, rows, sel: 0, textRow, input, shownAt: performance.now() };
    approvalDock.hidden = false;
    approvalDock.parentElement.classList.add('asking'); // Esc means decline now, not stop
    // The input goes inert while a decision is open, like the CLI's: a keystroke
    // meant for the prompt must never land in the message box instead.
    composerInput.disabled = true;
    composerInput.blur();
    setApprovalSel(0);
    scrollChatToBottom(true);
  }

  window.addEventListener('keydown', (e) => {
    if (!approval || !settingsOverlay.hidden) return;
    // A box that appears while you are typing must not be answered by the Enter
    // (or digit) you were already pressing for something else: that approved a
    // permission or answered a question nobody had read. Keys that choose are
    // ignored for a moment after it appears; arrows and Esc still work.
    if (performance.now() - approval.shownAt < APPROVAL_KEY_GRACE_MS && (e.key === 'Enter' || /^[1-9]$/.test(e.key))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    const onText = approval.rows[approval.sel] === approval.textRow;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setApprovalSel(approval.sel + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commitApprovalRow();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation(); // declining a prompt is not also "stop the turn"
      answerApproval(undefined);
    } else if (!onText && /^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const i = Number(e.key) - 1;
      if (i >= approval.rows.length) return;
      e.preventDefault();
      if (approval.rows[i] === approval.textRow) setApprovalSel(i); // typing row: land on it, don't send empty
      else { setApprovalSel(i); commitApprovalRow(); }
    }
  }, true);

  // ── Background shells (the CLI's [BG] bar + /shells) ────────────────────
  // A chip in the chat header while anything runs; its menu lists every shell
  // with a live clock, its log on demand, and Stop. The log is a PEEK: looking
  // at it never takes output away from the agent's own next read.
  const shellsWrap = document.getElementById('shells-wrap');
  const shellsChip = document.getElementById('shells-chip');
  const shellsLabel = document.getElementById('shells-label');
  const shellsMenu = document.getElementById('shells-menu');
  const shellsList = document.getElementById('shells-list');
  let shells = [];
  const openLogs = new Set(); // shell ids whose log is expanded
  let shellsTick = null;

  function shellState(sh) {
    if (sh.status === 'running') return sh.stalled ? { cls: 'warn', text: sh.stalled === 'prompt' ? 'waiting for input?' : 'quiet for a while' } : { cls: 'run', text: 'running' };
    if (sh.status === 'killed') return { cls: 'dim', text: sh.stoppedBy === 'user' ? 'stopped by you' : 'stopped' };
    if (sh.exitCode === 0) return { cls: 'ok', text: 'finished' };
    return { cls: 'bad', text: sh.exitCode == null ? `ended${sh.signal ? ` (${sh.signal})` : ''}` : `exit ${sh.exitCode}` };
  }
  // Split on top-level `;` / `&&` (not inside quotes): the last part is what runs.
  function splitShellCommand(cmd) {
    const parts = [];
    let cur = '', quote = null;
    for (let i = 0; i < cmd.length; i++) {
      const c = cmd[i];
      if (quote) { cur += c; if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; cur += c; continue; }
      if (c === ';' || (c === '&' && cmd[i + 1] === '&')) {
        if (c === '&') i++;
        if (cur.trim()) parts.push(cur.trim());
        cur = '';
        continue;
      }
      cur += c;
    }
    if (cur.trim()) parts.push(cur.trim());
    if (parts.length <= 1) return { main: cmd.trim(), setup: '' };
    return { main: parts[parts.length - 1], setup: parts.slice(0, -1).join('; ') };
  }
  function shellClock(sh) {
    const end = sh.finishedAt ?? Date.now();
    return fmtElapsed(Math.max(0, Math.floor((end - sh.startedAt) / 1000)));
  }

  function renderShells() {
    const running = shells.filter((s) => s.status === 'running');
    shellsWrap.hidden = running.length === 0;
    if (shellsWrap.hidden) shellsMenu.hidden = true;
    shellsLabel.textContent = `${running.length} running`;
    shellsChip.classList.toggle('stalled', running.some((s) => s.stalled));
    // Running first, newest first within each group.
    const ordered = [...shells].sort((a, b) => (a.status === 'running') !== (b.status === 'running') ? (a.status === 'running' ? -1 : 1) : b.id - a.id);
    const keep = new Set(ordered.map((s) => String(s.id)));
    shellsList.querySelectorAll('.shell-row').forEach((row) => { if (!keep.has(row.dataset.id)) row.remove(); });
    ordered.forEach((sh) => {
      let row = shellsList.querySelector(`.shell-row[data-id="${sh.id}"]`);
      if (!row) {
        row = document.createElement('div');
        row.className = 'shell-row';
        row.dataset.id = String(sh.id);
        row.innerHTML = `
          <div class="shell-main">
            <span class="shell-dot"></span>
            <div class="shell-text">
              <div class="shell-cmd"></div>
              <div class="shell-setup"></div>
              <div class="shell-sub">
                <span class="shell-state"></span>
                <span class="shell-port"></span>
                <span class="shell-clock"></span>
              </div>
            </div>
            <div class="shell-actions">
              <button class="shell-btn" data-act="log" title="Show output">
                <svg viewBox="0 0 14 14"><rect x="1.5" y="2.5" width="11" height="9" rx="1.5" stroke="currentColor" stroke-width="1.1" fill="none"/><path d="M4 6L5.8 7.5L4 9M7.2 9H10" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span>Log</span>
              </button>
              <button class="shell-btn stop" data-act="stop" title="Stop this command">
                <svg viewBox="0 0 14 14"><rect x="3.5" y="3.5" width="7" height="7" rx="1.2" fill="currentColor"/></svg>
                <span>Stop</span>
              </button>
            </div>
          </div>
          <pre class="shell-log" hidden></pre>`;
        // The command that matters is usually the last one: "cd …; $env:X = …;
        // npm run tauri dev" leads with what is running, the setup dimmed below.
        const { main, setup } = splitShellCommand(sh.command);
        row.querySelector('.shell-cmd').textContent = main;
        row.querySelector('.shell-setup').textContent = setup;
        row.querySelector('.shell-setup').hidden = !setup;
        row.title = sh.command;
        row.querySelector('[data-act="log"]').addEventListener('click', () => toggleShellLog(sh.id));
        row.querySelector('[data-act="stop"]').addEventListener('click', async (ev) => {
          ev.currentTarget.disabled = true;
          await window.mw.killShell(sh.id);
        });
      }
      const st = shellState(sh);
      row.querySelector('.shell-dot').className = `shell-dot ${st.cls}`;
      row.querySelector('.shell-state').textContent = st.text;
      row.querySelector('.shell-state').className = `shell-state ${st.cls}`;
      row.querySelector('.shell-clock').textContent = shellClock(sh);
      const port = row.querySelector('.shell-port');
      port.textContent = sh.port ? `localhost:${sh.port}` : '';
      port.hidden = !sh.port;
      row.querySelector('[data-act="stop"]').hidden = sh.status !== 'running';
      shellsList.appendChild(row); // re-append keeps the sorted order
    });
    // Tick the clocks once a second while anything runs — the motion is the
    // point: it says the command is still working, not wedged.
    if (running.length > 0 && !shellsTick) {
      shellsTick = setInterval(() => {
        shellsList.querySelectorAll('.shell-row').forEach((row) => {
          const sh = shells.find((s) => String(s.id) === row.dataset.id);
          if (sh) row.querySelector('.shell-clock').textContent = shellClock(sh);
        });
        if (!shellsMenu.hidden) openLogs.forEach((id) => refreshShellLog(id));
      }, 1000);
    } else if (running.length === 0 && shellsTick) {
      clearInterval(shellsTick);
      shellsTick = null;
    }
  }

  async function refreshShellLog(id) {
    const row = shellsList.querySelector(`.shell-row[data-id="${id}"]`);
    if (!row) return;
    const r = await window.mw.shellLog(id);
    const pre = row.querySelector('.shell-log');
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
    pre.textContent = r ? `${r.clipped ? '… earlier output not shown\n' : ''}${r.tail.trimEnd() || '(no output yet)'}` : '(this command is gone)';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }
  function toggleShellLog(id) {
    const row = shellsList.querySelector(`.shell-row[data-id="${id}"]`);
    const pre = row.querySelector('.shell-log');
    pre.hidden = !pre.hidden;
    row.querySelector('[data-act="log"]').classList.toggle('on', !pre.hidden);
    if (pre.hidden) openLogs.delete(id);
    else { openLogs.add(id); refreshShellLog(id).then(() => { pre.scrollTop = pre.scrollHeight; }); }
  }

  shellsChip.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.qtab-menu').forEach((m) => { if (m !== shellsMenu) m.hidden = true; });
    shellsMenu.hidden = !shellsMenu.hidden;
  });
  shellsMenu.addEventListener('click', (e) => e.stopPropagation()); // Stop/Log must not close it
  document.addEventListener('click', () => { shellsMenu.hidden = true; });

  window.mw?.onShellsChanged?.((list) => { shells = list; renderShells(); });
  window.mw?.listShells?.().then((list) => { shells = list || []; renderShells(); });

  // ── Run button: runs the project the way it's meant to be run ─────────────
  // main.js reads the project (Tauri, Electron, dev script, cargo, go, Django)
  // and starts it as a background shell, so it sits in the shells chip and the
  // agent can read its output. "Running" is a live shell with that command.
  const runBtn = document.getElementById('run-btn');
  let runTarget = null;
  let runBusy = false;
  function runningShell() {
    return runTarget && shells.find((s) => s.status === 'running' && s.command === runTarget.command);
  }
  function renderRunButton() {
    if (!runBtn) return;
    const live = runningShell();
    runBtn.classList.toggle('off', !runTarget);
    runBtn.classList.toggle('live', !!live);
    runBtn.classList.toggle('busy', runBusy);
    const label = !runTarget
      ? 'Nothing to run found. Click to set a command in Settings'
      : live
        ? `Stop ${runTarget.kind}${live.port ? ` · localhost:${live.port}` : ''}`
        : `Run ${runTarget.kind} · ${runTarget.dir ? `${runTarget.dir}: ` : ''}${runTarget.command} · Change it in Settings > General`;
    runBtn.title = label;
    runBtn.setAttribute('aria-label', label);
  }
  async function refreshRun() {
    runTarget = (await window.mw?.runStatus?.()) || null;
    renderRunButton();
    if (!runEditing) renderRunSettings();
  }
  runBtn?.addEventListener('click', async () => {
    if (!runTarget) { openSettingsAt('general'); document.getElementById('run-cmd-row')?.scrollIntoView({ block: 'center' }); return; } // nothing found: set one in Settings
    if (runBusy) return;
    runBusy = true;
    renderRunButton();
    let res = null;
    try {
      res = await window.mw.runToggle();
    } finally {
      runBusy = false;
      renderRunButton();
    }
    if (res?.error) runBtn.title = res.error;
  });
  window.mw?.onShellsChanged?.(() => renderRunButton());
  refreshRun();

  // Settings > General > Run button: the command the Run button starts for the open
  // project. Detected by default; Edit saves your own for this project, used every
  // time after; Remove goes back to the detected one.
  const runRow = document.getElementById('run-cmd-row');
  let runEditing = false;
  let runError = null;
  function renderRunSettings() {
    if (!runRow) return;
    const t = runTarget;
    const detected = t?.detected;
    const project = currentProjectCwd ? currentProjectCwd.split(/[\/]/).pop() : 'this project';
    if (runEditing) {
      runRow.innerHTML = `
        <div class="run-edit">
          <div class="settings-row-label"><span class="t">Run command for ${projName(project)}</span><span class="d">What the Run button starts in this project, every time.</span></div>
          <input type="text" class="km-input mono" id="run-cmd" placeholder="e.g. npm run dev" value="${escapeHtml(t?.command ?? '')}" spellcheck="false" autocomplete="off">
          <input type="text" class="km-input mono" id="run-dir" placeholder="Folder inside the project to run it in (optional)" value="${escapeHtml(t?.dir ?? '')}" spellcheck="false" autocomplete="off">
          <div class="run-hint">${detected ? `Detected: <span class="mono">${escapeHtml(detected.command)}</span>${detected.dir ? ` in ${escapeHtml(detected.dir)}` : ''}` : 'Nothing detected in this project.'}</div>
          ${runError ? `<div class="run-err">${escapeHtml(runError)}</div>` : ''}
          <div class="run-edit-actions">
            <button class="settings-btn ghost" id="run-cancel">Cancel</button>
            <button class="settings-btn" id="run-save">Save</button>
          </div>
        </div>`;
      const cmd = runRow.querySelector('#run-cmd');
      cmd.focus();
      const save = async () => {
        const res = await window.mw.runSet(cmd.value, runRow.querySelector('#run-dir').value);
        if (res?.error) { runError = res.error; return renderRunSettings(); }
        runEditing = false; runError = null;
        await refreshRun();
      };
      runRow.querySelector('#run-save').addEventListener('click', save);
      runRow.querySelector('#run-cancel').addEventListener('click', () => { runEditing = false; runError = null; renderRunSettings(); });
      runRow.querySelectorAll('input').forEach((i) => i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') { e.stopPropagation(); runEditing = false; runError = null; renderRunSettings(); }
      }));
      return;
    }
    runRow.innerHTML = `
      <div class="settings-row">
        <div class="settings-row-label">
          <span class="t">Run command for ${projName(project)}</span>
          <span class="d">${t
            ? `<span class="mono">${escapeHtml(t.command)}</span>${t.dir ? ` in ${escapeHtml(t.dir)}` : ''} · ${t.custom ? 'yours' : 'detected'}`
            : 'Nothing detected. Set one so the Run button can start your app.'}</span>
        </div>
        <div class="run-actions">
          ${t?.custom ? '<button class="settings-btn ghost danger-text" id="run-remove" title="Go back to the detected command">Remove</button>' : ''}
          <button class="settings-btn ghost" id="run-edit">${t ? 'Edit' : 'Set command'}</button>
        </div>
      </div>`;
    runRow.querySelector('#run-edit').addEventListener('click', () => { runEditing = true; runError = null; renderRunSettings(); });
    runRow.querySelector('#run-remove')?.addEventListener('click', async () => { await window.mw.runClear(); await refreshRun(); });
  }


  // ── Sub-agents: a bar above the chat, and a view per agent ───────────────
  // Every sub-agent working for this turn gets a chip in the bar with what it is
  // doing right now. Opening one swaps the chat area for that agent's own view:
  // its task, each tool call as it happens, its notes, its result. When the agent
  // you are watching finishes, you are taken back to Main. The main chat keeps
  // its compact block for each agent too, and clicking that block opens the view.
  const agentsBar = document.getElementById('agents-bar');
  const agents = new Map(); // id -> { n, task, readOnly, status, last, body, list, rows, working }
  let agentCount = 0;
  let viewingAgent = null; // agent id, or null for Main
  let viewingMarathon = false; // the marathon's own view is open
  let marathonPane = null; // built with the Marathon code below
  // { phase, line, todos } while a marathon run is on screen, else null.
  let marathonView = null;
  const MB_LIVE = new Set(['running', 'verifying']);
  const mainPlaceholder = document.getElementById('composer-input').placeholder;

  function agentVerbLine(name, arg) {
    return `${toolVerb(name, false)}${arg ? ` ${truncateMid(arg, 34)}` : ''}`;
  }

  function agentStart(e) {
    const n = ++agentCount;
    const body = document.createElement('div');
    body.className = 'agent-body';
    body.hidden = true;
    body.innerHTML = `
      <div class="agent-scroll"><div class="agent-list"></div></div>`;
    const list = body.querySelector('.agent-list');
    // Its task, as the message it was given.
    const task = document.createElement('div');
    task.className = 'agent-task';
    task.innerHTML = '<span class="agent-task-label">Task</span><div class="agent-task-text md"></div>';
    renderMarkdown(task.querySelector('.agent-task-text'), e.task);
    list.appendChild(task);
    const working = document.createElement('div');
    working.className = 'agent-working';
    working.innerHTML = '<span class="thinking-dots"><span></span><span></span><span></span></span><span>Working</span>';
    list.appendChild(working);
    chatBodyEl.after(body);
    agents.set(e.id, { n, task: e.task, readOnly: e.readOnly, status: 'running', last: 'Starting', body, list, rows: new Map(), working });
    renderAgentsBar();
  }

  function agentTool(e, phase) {
    const a = agents.get(e.agentId);
    if (!a) return;
    if (phase === 'start') {
      a.last = agentVerbLine(e.name, e.arg);
      const row = addToolBlock({
        iconPath: TOOL_ICONS[e.kind] || DEFAULT_TOOL_ICON,
        headText: toolHeadHtml(toolVerb(e.name, false), e.arg),
        bodyHtml: '', kind: e.kind, state: 'running', into: a.list,
      });
      row.dataset.name = e.name;
      row.classList.add('no-body');
      a.list.appendChild(a.working); // "Working" stays last
      a.rows.set(e.toolId, row);
      followAgent(a);
    } else {
      const row = a.rows.get(e.toolId);
      if (!row) return;
      setToolState(row, e.ok ? 'ok' : 'failed');
      if (!e.ok && e.summary) {
        row.classList.remove('no-body');
        row.querySelector('.tool-body').innerHTML = toolResultHtml({ summary: e.summary });
      }
      a.rows.delete(e.toolId);
    }
    renderAgentsBar();
  }

  function agentEnd(e) {
    const a = agents.get(e.id);
    if (!a) return;
    a.status = e.ok ? 'done' : 'failed';
    a.last = e.ok ? 'Finished' : 'Stopped with an error';
    a.working.remove();
    const result = document.createElement('div');
    result.className = `agent-result ${e.ok ? 'ok' : 'failed'}`;
    result.innerHTML = `<div class="agent-result-head">${e.ok ? 'Result' : 'Stopped'}</div><div class="md"></div>`;
    renderMarkdown(result.querySelector('.md'), e.summary || (e.ok ? 'Done.' : 'It stopped before finishing.'));
    a.list.appendChild(result);
    // Watching it as it finishes: you stay here with its result. The tabs go away
    // only when you send Main a new message (resetAgents).
    followAgent(a);
    renderAgentsBar();
  }

  function followAgent(a) {
    const scroller = a.body.querySelector('.agent-scroll');
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80) scroller.scrollTop = scroller.scrollHeight;
  }

  function renderAgentsBar() {
    const mbTab = !!marathonView && marathonView.phase !== 'armed';
    agentsBar.hidden = agents.size === 0 && !mbTab;
    const focusedKey = document.activeElement?.closest?.('.agent-chip')?.dataset.key;
    agentsBar.innerHTML = '';
    const chip = (key, html, cls) => {
      const b = document.createElement('button');
      b.className = `agent-chip ${cls}`;
      b.dataset.key = key;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(key === 'marathon' ? viewingMarathon : (viewingAgent ?? 'main') === key && !viewingMarathon));
      b.innerHTML = html;
      b.addEventListener('click', () => (key === 'main' ? showMain() : key === 'marathon' ? showMarathon() : showAgent(key)));
      agentsBar.appendChild(b);
      return b;
    };
    chip('main', '<span class="ac-text"><span class="ac-name">Main</span></span>', 'main' + (viewingAgent == null && !viewingMarathon ? ' active' : ''));
    if (mbTab) {
      const v = marathonView;
      const st = MB_LIVE.has(v.phase) ? 'running' : v.phase === 'done' ? 'done' : 'failed';
      const el = chip('marathon', `
        <span class="ac-status"></span>
        <span class="ac-text"><span class="ac-name">Marathon</span><span class="ac-last"></span></span>`,
        `${st}${viewingMarathon ? ' active' : ''}`);
      const total = v.todos.length;
      const done = v.todos.filter((t) => t.status === 'completed').length;
      el.querySelector('.ac-last').textContent = total ? `${done} of ${total}` : (v.line || '');
      el.title = v.line || 'Marathon';
    }
    agents.forEach((a, id) => {
      const el = chip(id, `
        <span class="ac-status"></span>
        <span class="ac-text"><span class="ac-name">Agent ${a.n}</span><span class="ac-last"></span></span>`,
        `${a.status}${viewingAgent === id ? ' active' : ''}`);
      el.querySelector('.ac-last').textContent = a.last;
      el.title = a.task;
    });
    if (focusedKey) agentsBar.querySelector(`.agent-chip[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
  }

  function showAgent(id) {
    const a = agents.get(id);
    if (!a) return;
    viewingAgent = id;
    viewingMarathon = false;
    if (marathonPane) marathonPane.hidden = true;
    chatBodyEl.hidden = true;
    agents.forEach((x, xid) => { x.body.hidden = xid !== id; });
    // Watching only: Main runs its agents, so nothing can be typed, sent or stopped here.
    document.getElementById('composer-input').placeholder = `Viewing Agent ${a.n} · read only`;
    syncComposerLock();
    const scroller = a.body.querySelector('.agent-scroll');
    scroller.scrollTop = scroller.scrollHeight;
    renderAgentsBar();
  }

  function showMain() {
    viewingAgent = null;
    viewingMarathon = false;
    if (marathonPane) marathonPane.hidden = true;
    agents.forEach((x) => { x.body.hidden = true; });
    chatBodyEl.hidden = false;
    document.getElementById('composer-input').placeholder = mainPlaceholder;
    syncComposerLock();
    renderAgentsBar();
  }

  // The one rule for whether the composer takes input: not while a decision is
  // open (the dock owns the keys), and not while watching an agent (read only:
  // no typing, no send, no stop, no attaching). Everything that locks or unlocks
  // it goes through here, so answering a question can't unlock an agent view.
  function syncComposerLock() {
    const watching = viewingAgent != null || viewingMarathon;
    const input = document.getElementById('composer-input');
    input.disabled = watching || !!approval;
    document.getElementById('send-btn').disabled = watching;
    document.getElementById('attach-btn').disabled = watching;
    document.querySelector('.composer').classList.toggle('read-only', watching);
    if (!input.disabled) input.focus();
  }

  // A new message to Main starts a new set of agents.
  function resetAgents() {
    showMain();
    agents.forEach((a) => a.body.remove());
    agents.clear();
    agentCount = 0;
    renderAgentsBar();
  }

  // ←/→ move between chips (the bar is one tab stop), Enter or Space opens.
  agentsBar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    const chips = [...agentsBar.querySelectorAll('.agent-chip')];
    const i = chips.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? chips.length - 1
      : (i + (e.key === 'ArrowRight' ? 1 : -1) + chips.length) % chips.length;
    chips[next]?.focus();
    e.preventDefault();
  });
  // Esc while watching an agent goes back to Main before it means anything else.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (viewingAgent == null && !viewingMarathon)) return;
    if (!document.getElementById('att-viewer').hidden) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    showMain();
  }, true);

  // ── Empty chat: centred composer until the first message ────────────────
  // One class on the chat pane; the CSS moves the SAME composer, so whatever
  // is half-typed or attached rides along. Leaving happens on the first real
  // event of a turn (your message, or the agent waking on its own).
  const paneChatEl = document.querySelector('.pane-chat');
  const heroProjectEl = document.getElementById('chat-hero-project');
  let chatEmpty = false;

  function setChatEmpty(empty, { animate }) {
    heroProjectEl.textContent = projLabel.textContent || 'this project';
    document.getElementById('chat-hero-in').hidden = noProject;
    if (empty === chatEmpty && paneChatEl.classList.contains('is-empty') === empty) return;
    chatEmpty = empty;
    if (!animate) paneChatEl.classList.add('instant');
    paneChatEl.classList.toggle('is-empty', empty);
    if (!animate) {
      // Force the new layout to be computed WITHOUT transitions, then turn them
      // back on straight away: the values are already settled, so nothing animates.
      // (Waiting a frame instead left .instant stuck on wherever frames don't run.)
      void paneChatEl.offsetHeight;
      paneChatEl.classList.remove('instant');
    }
    if (empty) composerInput.focus();
  }

  const WORK_EVENTS = new Set(['text', 'toolStart', 'activity', 'subagentStart', 'compaction', 'approvalRequest']);
  function handleChatEvent(e) {
    // Feed the live token counter at the RAW event, before any reveal pacing — it
    // tracks the model's real streaming speed, not the display's paced-out one.
    // Reasoning has nothing else to do with it here (never rendered), so it returns.
    if (e.type === 'textHeld') { meterDelta(e.n); return; }
    if (e.type === 'reasoning') { meterDelta(e.delta.length); return; }
    // Words that only led to unseen tools: the working line says them, the chat does not.
    if (e.type === 'narrationNote') { showNarrationNote(e.text); return; }
    else if (e.type === 'usage') meterUsage(e.completionTokens);
    // The context meter's reading: not part of the conversation, drawn at once.
    if (e.type === 'context') { if (!compacting) applyContext(e); return; }
    if (e.type === 'queue') { onQueueEvent(e.items); return; }
    // The meter follows a compaction as it happens; its chat row waits its turn below.
    if (e.type === 'compactionStart') {
      setCompacting(true);
      // An automatic one runs before the turn's first word: it starts the working strip
      // itself, and says so now rather than when its row draws.
      if (!manualCompacting) {
        ensureTurnShown();
        setStatus('Compacting the conversation');
      }
    }
    if (e.type === 'compactionEnd') { setCompacting(false); void refreshContext(); }
    // A compaction from the button is not a turn: no working strip that no "done" would end.
    if (manualCompacting && (e.type.startsWith('compaction') || e.type === 'activity')) {
      renderChatEvent(e);
      return;
    }
    // A turn you did not start (the agent waking for a background command) also ends the empty state.
    if (chatEmpty && e.type !== 'modeChanged' && e.type !== 'done') setChatEmpty(false, { animate: true });
    // A command's own status line ("shell #1 … finished") is not the agent working: the turn it may wake
    // shows itself with its first event, and with no provider connected nothing would ever end it.
    if (WORK_EVENTS.has(e.type) && !(e.type === 'activity' && e.shell)) ensureTurnShown();
    // The user's own message (typed or queued) is feedback for something THEY
    // just did — it renders immediately, never held in the pacer queue.
    // A decision the agent is waiting on: draw everything already queued FIRST, so no
    // row can appear after the box, as if work carried on behind an open question.
    if (e.type === 'approvalRequest') {
      flushReveal();
      renderChatEvent(e);
      return;
    }
    // A queued message going in (at a step, or as the next turn) waits behind whatever
    // is still being revealed, so it lands after the answer it followed, not above it.
    // One typed into an idle chat has nothing ahead of it and shows at once.
    if (e.type === 'userMessage' && (revealQueue.length > 0 || pendingText)) {
      paceReveal(() => { renderChatEvent(e); queueLanded(); });
      return;
    }
    if (e.type === 'userMessage' || e.type === 'modeChanged') {
      renderChatEvent(e);
      return;
    }
    if (e.type === 'text') {
      // A reply is only still streaming if nothing is waiting to be drawn after it. Words
      // that arrive while a tool row is still in the queue are the NEXT reply (the model
      // spoke again after that tool ran), and streaming them into the old one glued two
      // messages together: "…works now.Fixed: the overlay…".
      if (currentReplyMsg && revealQueue.length > 0) {
        if (pendingText && pendingText.fn === lastQueuedFn) pendingText.text += e.delta;
        else {
          const slot = { text: e.delta, fn: null };
          slot.fn = () => {
            if (pendingText === slot) pendingText = null;
            sealReply();
            drainText(slot.text);
          };
          pendingText = slot;
          paceReveal(slot.fn);
        }
        return;
      }
      if (!currentReplyMsg && pendingText && pendingText.fn === lastQueuedFn) {
        pendingText.text += e.delta; // still waiting at the back of the queue — keep buffering
      } else if (!currentReplyMsg) {
        // A new reply, or words written after something else was queued behind
        // the waiting one (a tool call): its own slot, so it lands in order.
        const slot = { text: e.delta, fn: null };
        slot.fn = () => {
          if (pendingText === slot) pendingText = null;
          drainText(slot.text);
        };
        pendingText = slot;
        paceReveal(slot.fn);
      } else {
        if (drainRaf) drainText(e.delta); // behind words still flowing in: after them, in order
        else renderChatEvent(e); // already live — stream it, no further pacing
      }
      return;
    }
    if (PACED_TYPES.has(e.type)) {
      paceReveal(() => renderChatEvent(e));
      return;
    }
    renderChatEvent(e);
  }

  // Call right after a start event actually renders (block/row now exists),
  // so a same-id end event that arrived earlier — while the start was still
  // sitting in the pace queue — gets applied now instead of being lost.
  function markRenderedAndCatchUp(id, applier) {
    renderedIds.add(id);
    const pending = pendingEndResults.get(id);
    if (pending) {
      pendingEndResults.delete(id);
      applier(pending);
    }
  }

  // ── Reads of one file fold into ONE row for the rest of the turn ──
  // The agent often reads a file in slices (1–180, then 180–449, then
  // 446–745), sometimes with a sentence in between. Each slice used to be its
  // own row; now the first row for that file stays and updates in place with
  // the merged line ranges and how many reads it took. Hover shows each read.
  const readRecs = new Map();      // file arg -> rec
  const mergedReadIds = new Map(); // toolId -> rec it was folded into
  function resetReadRecs() { readRecs.clear(); mergedReadIds.clear(); }



  function readRangeOf(summary) {
    const m = /lines? (\d+)\s*[–-]\s*(\d+)/.exec(summary || '');
    if (m) return [Number(m[1]), Number(m[2])];
    if (/\(\d+ lines?\)/.test(summary || '')) return 'whole';
    return null;
  }
  function readMetaText(rec) {
    let where = '';
    if (rec.whole) where = 'whole file';
    else if (rec.ranges.length) {
      const merged = [];
      for (const r of [...rec.ranges].sort((a, b) => a[0] - b[0])) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else merged.push([...r]);
      }
      where = `lines ${merged.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ')}`;
    }
    return [where, rec.count > 1 ? `${rec.count} reads` : ''].filter(Boolean).join(' · ');
  }
  function newReadRec(kind, el, metaEl, pending) {
    return { kind, el, metaEl, pending, count: 1, ranges: [], whole: false, failed: false, summaries: [] };
  }
  function recordRead(rec, e) {
    const r = readRangeOf(e.summary);
    if (r === 'whole') rec.whole = true;
    else if (r) rec.ranges.push(r);
    if (!e.ok) rec.failed = true;
    if (e.summary) rec.summaries.push(e.summary);
    rec.metaEl.textContent = readMetaText(rec);
    rec.el.title = rec.summaries.join('\n');
  }
  function setReadRecState(rec) {
    const state = rec.pending > 0 ? 'running' : rec.failed ? 'failed' : 'ok';
    if (rec.kind === 'card') { setToolState(rec.el, state); return; }
    rec.el.querySelector('.dot').classList.toggle('pulsing', state === 'running');
    rec.el.classList.toggle('err', state === 'failed');
    const g = rec.el._group;
    if (state === 'running') setToolState(g.block, 'running');
    else if (![...openGroupRows.values()].some((r) => r._group === g) && ![...mergedReadIds.values()].some((x) => x.el._group === g)) {
      setToolState(g.block, g.failed || rec.failed ? 'failed' : 'ok');
    }
  }

  function applyToolEnd(e) {
    if (testEnd(e)) return;
    if (e.quiet) { dropQuietTool(e.id); return; }
    if (webEnd(e, true)) return;
    const mergedRec = mergedReadIds.get(e.id);
    if (mergedRec) {
      mergedReadIds.delete(e.id);
      mergedRec.pending--;
      recordRead(mergedRec, e);
      setReadRecState(mergedRec);
      return;
    }
    const groupRow = openGroupRows.get(e.id);
    if (groupRow && groupRow._readRec) {
      openGroupRows.delete(e.id);
      if (!e.ok) groupRow._group.failed = true;
      groupRow._readRec.pending--;
      recordRead(groupRow._readRec, e);
      setReadRecState(groupRow._readRec);
      return;
    }
    if (groupRow) {
      groupRow.querySelector('.dot').classList.remove('pulsing');
      groupRow.classList.toggle('err', !e.ok);
      if (e.summary) groupRow.title = e.summary;
      openGroupRows.delete(e.id);
      const g = groupRow._group;
      if (!e.ok) g.failed = true;
      if (![...openGroupRows.values()].some((r) => r._group === g)) setToolState(g.block, g.failed ? 'failed' : 'ok');
      return;
    }
    const tool = openToolBlocks.get(e.id);
    if (!tool) return;
    if (tool._readRec) {
      openToolBlocks.delete(e.id);
      tool._readRec.pending--;
      recordRead(tool._readRec, e);
      setReadRecState(tool._readRec);
      if (!e.ok) { tool.querySelector('.tool-body').innerHTML = toolResultHtml(e); wireTruncToggles(tool); }
      return;
    }
    openToolBlocks.delete(e.id);
    if (tool._files) tool._line = lineOf(tool._fileTool, tool._fileArgs, e.detailFull || e.detail);
    if (presentSpecialOutcome(tool, e)) return;
    setToolState(tool, e.ok ? 'ok' : 'failed');
    addDiffStats(tool, e);
    tool.querySelector('.tool-body').innerHTML = toolResultHtml(e, tool.querySelector('.tool-head-text')?.title);
    wireTruncToggles(tool);
    addToolImages(tool, e.images);
  }

  function applySubagentEnd(e) {
    agentEnd(e);
    const agent = openSubagents.get(e.id);
    if (!agent) return;
    setToolState(agent.block, e.ok ? 'ok' : 'failed');
    openSubagents.delete(e.id);
  }

  function statusFor(e) {
    switch (e.type) {
      case 'text': return 'Writing';
      case 'toolStart':
        // A tool search's argument is the search itself, not something being acted on.
        if (e.name === 'Tools') return `Looking for tools${e.arg ? ` for “${truncateMid(e.arg, 50)}”` : ''}`;
        return `${toolVerb(e.name, false)}${e.arg ? ` ${truncateMid(e.arg, 60)}` : ''}`;
      case 'toolEnd': case 'subagentEnd': case 'userMessage': return 'Thinking';
      case 'subagentStart': return 'Sub-agent working';
      case 'approvalRequest': return 'Waiting for your approval';
      case 'compactionStart': case 'compaction': return 'Compacting the conversation';
      default: return null;
    }
  }

  // The agent's words about what it is doing now, when they lead to nothing the chat shows. They
  // hold the working line until it says or does something visible.
  let noteHolds = false;
  function showNarrationNote(text) {
    const line = String(text).replace(/\s+/g, ' ').trim();
    const first = (/^.+?[.!?](?=\s|$)/.exec(line)?.[0] || line);
    if (!realTurnRunning) ensureTurnShown();
    setStatus(first.length > 140 ? first.slice(0, 139) + '…' : first);
    noteHolds = true;
  }

  function renderChatEvent(e) {
    if (e.type === 'toolStart' || e.type === 'toolEnd') marathonMirror(e);
    if (e.type === 'text' || e.type === 'done' || e.type === 'userMessage' || e.type === 'approvalRequest' || e.type === 'error') noteHolds = false;
    if (realTurnRunning && !(e.type === 'userMessage' && e.queued) && !(noteHolds && (e.type === 'toolStart' || e.type === 'toolEnd'))) {
      const st = statusFor(e);
      if (st && csLabel.textContent !== st) setStatus(st);
    }
    switch (e.type) {
      case 'userMessage':
        addUserMessage(e.text, e.queued, [], e.images, e.files);
        // A queued message is just recorded for later — the turn currently
        // running is still going, so its reply-in-progress / thinking
        // placeholder must NOT be torn down for it. Only a message that's
        // actually starting fresh work seals the previous state and shows a
        // new "about to answer" placeholder.
        if (!e.queued) {
          endTest();
          sealReply();
          resetReadRecs();
          resetAgents();
          addThinkingPlaceholder();
          // A turn is starting: working from now, also when it was not started from the
          // composer (a message that was waiting for a compaction to finish).
          ensureTurnShown();
        }
        break;
      case 'text':
        beginReply();
        currentReplyText += e.delta;
        if (currentReplyMsg && currentReplyMsg.classList.contains('lt-say')) {
          currentReplyMsg._text = currentReplyText;
        }
        queueReplyRender();
        break;
      case 'uiLive':
        applyUiLive(e);
        break;
      case 'toolProgress':
        testProgress(e);
        break;
      case 'toolStart': {
        if (e.tool === 'ui') {
          testStart(e, true);
          markRenderedAndCatchUp(e.id, applyToolEnd);
          break;
        }
        // Search and the code lookups are how the agent finds its way around, and the todo
        // list is the agent's own note to itself; their results always come back quiet and
        // the CLI never shows them. Held until the result says so, so the row cannot flash
        // in and out while it runs.
        if ((e.kind === 'search' || e.name === 'Todo') && !e.released) { heldLookups.set(e.id, e); break; }
        if (e.kind === 'websearch') {
          webStart(e, true);
          markRenderedAndCatchUp(e.id, applyToolEnd);
          break;
        }
        if (e.kind === 'read' && e.arg && readRecs.has(e.arg)) {
          sealReply(); // the agent's next words still start a new paragraph
          const rec = readRecs.get(e.arg);
          rec.count++;
          rec.pending++;
          mergedReadIds.set(e.id, rec);
          rec.metaEl.textContent = readMetaText(rec);
          setReadRecState(rec);
          markRenderedAndCatchUp(e.id, applyToolEnd);
          break;
        }
        if (e.group) {
          if (!openGroup) {
            sealReply();
            const block = addToolBlock({
              iconPath: TOOL_ICONS.search,
              headText: '<span class="tool-head-text"><span class="tool-verb">Exploring</span><span class="tool-group-count"></span></span>',
              bodyHtml: '<div class="tool-group-list"></div>',
              kind: 'search',
            });
            openGroup = { block, list: block.querySelector('.tool-group-list'), countEl: block.querySelector('.tool-group-count'), count: 0, failed: false };
          }
          setToolState(openGroup.block, 'running');
          openGroup.count++;
          openGroup.countEl.textContent = ` — ${openGroup.count} step${openGroup.count > 1 ? 's' : ''}`;
          const row = document.createElement('div');
          row.className = 'tool-group-row';
          const rowLabel = `${toolVerb(e.name, true)}${e.arg ? ` ${truncateMid(e.arg, 46)}` : ''}`;
          row.innerHTML = `<span class="dot pulsing"></span><span class="tgr-text" title="${escapeHtml(e.arg || e.name)}">${escapeHtml(rowLabel)}</span><span class="tgr-meta"></span>`;
          row._group = openGroup;
          if (e.kind === 'read' && e.arg) {
            row._readRec = newReadRec('group', row, row.querySelector('.tgr-meta'), 1);
            readRecs.set(e.arg, row._readRec);
          }
          openGroup.list.appendChild(row);
          openGroupRows.set(e.id, row);
          scrollChatToBottom();
        } else {
          sealReply();
          // A tool search's argument is the SEARCH, not a tool's name — shown as
          // "for …" beside the verb, never as if it were what got loaded.
          const isToolSearch = e.name === 'Tools';
          const tool = addToolBlock({
            iconPath: TOOL_ICONS[e.kind] || DEFAULT_TOOL_ICON,
            headText: toolHeadHtml(toolVerb(e.name, false), isToolSearch ? null : e.arg),
            bodyHtml: '',
            kind: e.kind,
            state: 'running',
          });
          tool.dataset.name = e.name;
          if (isToolSearch && e.arg) addToolMeta(tool).textContent = `for “${truncateMid(e.arg, 40)}”`;
          if (e.kind === 'read' && e.arg) {
            tool._readRec = newReadRec('card', tool, addToolMeta(tool), 1);
            readRecs.set(e.arg, tool._readRec);
          }
          addOpenButton(tool, e);
          openToolBlocks.set(e.id, tool);
        }
        // The matching end may already have arrived while this start was
        // sitting in the pace queue (a fast call, or a backlog of earlier
        // blocks ahead of it) — catch up immediately instead of leaving the
        // block on "running…" with no end event ever coming for it.
        markRenderedAndCatchUp(e.id, applyToolEnd);
        break;
      }
      case 'toolEnd':
        // A held lookup: nothing was drawn for it. Quiet (every search is) stays that
        // way; anything else is drawn now, start and result together.
        if (heldLookups.has(e.id)) {
          const start = heldLookups.get(e.id);
          heldLookups.delete(e.id);
          if (e.quiet) break;
          renderChatEvent({ ...start, released: true });
        }
        if (!renderedIds.has(e.id)) { pendingEndResults.set(e.id, e); break; }
        applyToolEnd(e);
        break;
      case 'activity':
        sealReply();
        addToolBlock({ iconPath: DEFAULT_TOOL_ICON, headText: `<span class="tool-head-text">${escapeHtml(e.line)}</span>`, bodyHtml: '', sys: !e.shell });
        break;
      case 'compactionStart': {
        // Drawn from where the meter stood: the bar then shrinks to where it lands.
        sealReply();
        const from = ctxLast?.limit ? Math.min(100, (ctxLast.used / ctxLast.limit) * 100) : 100;
        // Compacting again with nothing in between (the button pressed repeatedly): the same row
        // runs again and keeps its first "before", instead of stacking a row per press.
        const again = lastChatBlock();
        if (again?.classList.contains('cmp-row')) {
          compactRow = again;
          compactRow.querySelector('.tool-head-text').textContent = 'Compacting the conversation';
          setToolState(compactRow, 'running');
          break;
        }
        compactRow = addToolBlock({
          iconPath: DEFAULT_TOOL_ICON,
          headText: '<span class="tool-head-text">Compacting the conversation</span>',
          sys: true,
          bodyHtml: `<div class="cmp-bar"><div class="cmp-fill" style="width:${from}%"></div></div><div class="dim-l cmp-num">Summarizing older turns so the agent can keep going</div>`,
          state: 'running',
        });
        compactRow.classList.add('cmp-row', 'open');
        break;
      }
      case 'compaction': {
        sealReply();
        // Against the same bar the meter shows, so the two numbers agree.
        const bar = ctxLast?.limit || e.window;
        const numbers = `${fmtTokens(e.before)} &rarr; ${fmtTokens(e.after)} of ${fmtTokens(bar)} tokens`;
        if (!compactRow) {
          addToolBlock({ iconPath: DEFAULT_TOOL_ICON, headText: '<span class="tool-head-text">Compacted the conversation</span>', bodyHtml: `<div class="dim-l">${numbers}</div>`, sys: true });
          break;
        }
        const row = compactRow;
        compactRow = null;
        row._before ??= e.before; // repeated compactions read as one: first before → latest after
        row._times = (row._times || 0) + 1;
        row.querySelector('.tool-head-text').textContent = row._times > 1 ? `Compacted the conversation · ${row._times} times` : 'Compacted the conversation';
        row.querySelector('.cmp-num').innerHTML = `${fmtTokens(row._before)} &rarr; ${fmtTokens(e.after)} of ${fmtTokens(bar)} tokens`;
        setToolState(row, 'ok');
        requestAnimationFrame(() => { row.querySelector('.cmp-fill').style.width = `${Math.min(100, (e.after / bar) * 100)}%`; });
        break;
      }
      case 'compactionEnd':
        // Ended without a result: it did not succeed, and the engine has said why.
        if (compactRow) {
          compactRow.querySelector('.tool-head-text').textContent = 'Compaction did not finish';
          compactRow.querySelector('.cmp-num').textContent = 'The conversation was kept as it was';
          setToolState(compactRow, 'failed');
          compactRow = null;
        }
        break;
      case 'notice':
        sealReply();
        addToolBlock({ iconPath: DEFAULT_TOOL_ICON, headText: `<span class="tool-head-text">${escapeHtml(e.title)}</span>`, bodyHtml: truncatedBlock(e.body, { mono: false }), sys: true });
        break;
      case 'error':
        sealReply();
        offerRetry(addToolBlock({ iconPath: DEFAULT_TOOL_ICON, headText: toolHeadHtml('Error', e.text), bodyHtml: '', kind: 'error', state: 'failed', sys: true }));
        break;
      case 'subagentStart': {
        sealReply();
        const block = addToolBlock({
          iconPath: TOOL_ICONS.agent || DEFAULT_TOOL_ICON,
          headText: toolHeadHtml(`Sub-agent${e.readOnly ? ' (read-only)' : ''}`, e.task),
          bodyHtml: '<div class="subagent-rail"></div>',
          kind: 'agent',
          state: 'running',
        });
        openSubagents.set(e.id, { block, rail: block.querySelector('.subagent-rail'), rows: new Map() });
        agentStart(e);
        const open = document.createElement('button');
        open.className = 'agent-open';
        open.textContent = 'Open';
        open.title = 'Watch this agent';
        open.addEventListener('click', (ev) => { ev.stopPropagation(); showAgent(e.id); });
        block.querySelector('.tool-head').insertBefore(open, block.querySelector('.tool-status'));
        markRenderedAndCatchUp(e.id, applySubagentEnd);
        break;
      }
      case 'subToolStart': {
        agentTool(e, 'start');
        const agent = openSubagents.get(e.agentId);
        if (!agent) break;
        const row = document.createElement('div');
        row.className = 'subagent-row';
        row.innerHTML = `<span class="dot pulsing"></span><span class="srt" title="${escapeHtml(e.arg || '')}">${escapeHtml(e.name)}${e.arg ? ` &mdash; ${escapeHtml(truncateMid(e.arg, 40))}` : ''}</span>`;
        agent.rail.appendChild(row);
        agent.rows.set(e.toolId, row);
        scrollChatToBottom();
        break;
      }
      case 'subToolEnd': {
        agentTool(e, 'end');
        const agent = openSubagents.get(e.agentId);
        const row = agent?.rows.get(e.toolId);
        if (!row) break;
        row.querySelector('.dot').classList.remove('pulsing');
        row.classList.toggle('err', !e.ok);
        agent.rows.delete(e.toolId);
        break;
      }
      case 'subagentEnd':
        if (!renderedIds.has(e.id)) { pendingEndResults.set(e.id, e); break; }
        applySubagentEnd(e);
        break;
      case 'approvalRequest':
        showApprovalRequest(e);
        break;
      case 'approvalsDismissed':
        // Esc stopped the turn: the question it was waiting on is gone with it.
        if (approval) {
          approval = null;
          approvalDock.hidden = true;
          approvalDock.parentElement.classList.remove('asking');
          syncComposerLock();
        }
        break;
      case 'modeChanged':
        applyModeState(e.mode);
        break;
      case 'limitsChanged':
        void refreshLimitBars();
        void refreshLimitMeter();
        break;
      case 'todos': case 'marathon':
        marathonEvent(e);
        break;
      case 'done':
        stoppedByUser = false;
        setTimeout(offerRetryIfInterrupted, 60); // after the last words are drawn
        marathonTurnEnded();
        endTest();
        sealReply();
        testCalls.clear();
        openToolBlocks.clear();
        heldLookups.clear();
        openSubagents.clear();
        openGroupRows.clear();
        renderedIds.clear();
        pendingEndResults.clear();
        stopStatus();
        realTurnRunning = false;
        updateSendButtonMode();
        break;
    }
  }

  // ── Marathon ────────────────────────────────────────────────────────────
  // The flag button arms it; the next message sent is the goal. The checklist box shows
  // the model's own task list (todo_write) as it works: waiting is dim, the active one is
  // orange and turning, finished is a green tick. It only ever DISPLAYS: main.js owns the run.
  const marathonBtn = document.getElementById('marathon-btn');
  const marathonBox = document.getElementById('marathon-box');
  const mbLine = document.getElementById('mb-line');
  const mbCount = document.getElementById('mb-count');
  // The full checklist lives in its own view, opened from the one-line box (like a sub-agent).
  marathonPane = document.createElement('div');
  marathonPane.className = 'agent-body marathon-view';
  marathonPane.hidden = true;
  marathonPane.innerHTML = `
    <div class="agent-scroll"><div class="agent-list"><div class="mb-list" id="mb-list"></div><div class="mb-empty">The list appears once the plan is made.</div></div></div>`;
  const mbScroll = marathonPane.querySelector('.agent-scroll');
  chatBodyEl.after(marathonPane);
  const mbList = marathonPane.querySelector('#mb-list');
  // What the agent did under each task: its tool calls, drawn the way a sub-agent's are.
  const mbSections = new Map(); // task text -> { el, head, rows }
  const mbRows = new Map(); // tool id -> its row
  let mbActiveKey = '__plan';
  function mbSection(key, attach) {
    let sec = mbSections.get(key);
    if (!sec) {
      const el = document.createElement('div');
      el.className = 'mb-task';
      const head = document.createElement('div');
      const rows = document.createElement('div');
      rows.className = 'mb-task-rows';
      el.append(head, rows);
      sec = { el, head, rows };
      mbSections.set(key, sec);
    }
    return sec;
  }
  function resetMarathonLog() {
    mbSections.forEach((s) => s.el.remove());
    mbSections.clear();
    mbRows.clear();
    mbActiveKey = '__plan';
  }
  // Called for every tool event of the main chat: while a marathon runs, mirror it under the task
  // that is being worked on.
  function marathonMirror(e) {
    if (!marathonView || !MB_LIVE.has(marathonView.phase)) return;
    if (e.type === 'toolStart') {
      if (e.name === 'Todo' || e.tool === 'ui') return;
      const active = marathonView.todos.find((t) => t.status === 'in_progress');
      const sec = mbSection(active ? active.content : mbActiveKey, true);
      const row = addToolBlock({
        iconPath: TOOL_ICONS[e.kind] || DEFAULT_TOOL_ICON,
        headText: toolHeadHtml(toolVerb(e.name, false), e.arg),
        bodyHtml: '', kind: e.kind, state: 'running', into: sec.rows,
      });
      row.classList.add('no-body');
      mbRows.set(e.id, row);
      while (sec.rows.childElementCount > 60) sec.rows.firstElementChild.remove();
      drawMarathon();
    } else if (e.type === 'toolEnd') {
      const row = mbRows.get(e.id);
      if (!row) return;
      mbRows.delete(e.id);
      setToolState(row, e.ok === false ? 'failed' : 'ok');
      if (e.ok === false && e.summary) {
        row.classList.remove('no-body');
        row.querySelector('.tool-body').innerHTML = toolResultHtml({ summary: e.summary });
      }
    }
  }
  function showMarathon() {
    // Only once the task has started: armed, there is nothing to show, and no tab to come back by.
    if (!marathonView || marathonView.phase === 'armed') return;
    viewingMarathon = true;
    viewingAgent = null;
    agents.forEach((x) => { x.body.hidden = true; });
    chatBodyEl.hidden = true;
    marathonPane.hidden = false;
    document.getElementById('composer-input').placeholder = 'Viewing Marathon · read only';
    syncComposerLock();
    renderAgentsBar();
    mbScroll.scrollTop = mbScroll.scrollHeight;
  }
  const mbResume = document.getElementById('mb-resume');
  const mbClose = document.getElementById('mb-close');
  let marathonArmed = false;

  function setMarathonArmed(on) {
    marathonArmed = on;
    marathonBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on && !marathonView) marathonView = { phase: 'armed', line: 'Your next message is the goal.', todos: [] };
    else if (!on && marathonView?.phase === 'armed') marathonView = null;
    drawMarathon();
  }

  function drawMarathon() {
    const v = marathonView;
    document.querySelector('.cbox')?.classList.toggle('runner', !!v && MB_LIVE.has(v.phase));
    marathonBox.hidden = !v;
    if (!v) { if (viewingMarathon) showMain(); resetMarathonLog(); renderAgentsBar(); return; }
    renderAgentsBar();
    marathonPane.dataset.live = MB_LIVE.has(v.phase) ? '1' : '0';
    const total = v.todos.length;
    mbCount.textContent = total ? `${v.todos.filter((t) => t.status === 'completed').length} of ${total}` : '';
    marathonBox.dataset.phase = v.phase;
    marathonBox.dataset.live = MB_LIVE.has(v.phase) ? '1' : '0';
    mbLine.textContent = v.line;
    mbLine.title = v.line;
    mbResume.hidden = v.phase !== 'paused';
    mbClose.hidden = !(v.phase === 'paused' || ['done', 'blocked', 'stuck', 'budgetExceeded'].includes(v.phase));
    // One section per task, kept between redraws so what was done under it stays.
    const keep = new Set();
    const sections = [];
    if (mbSection('__plan', false).rows.childElementCount) sections.push(['__plan', { content: 'Planning', status: 'completed' }]);
    for (const t of v.todos) sections.push([t.content, t]);
    for (const [key, t] of sections) {
      keep.add(key);
      const sec = mbSection(key, true);
      const state = t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'wait';
      sec.head.className = `mb-item ${state}`;
      sec.head.textContent = '';
      const mark = document.createElement('span');
      mark.className = 'mb-mark';
      if (state === 'done') mark.textContent = '✓';
      else if (state === 'wait') mark.textContent = '○';
      const text = document.createElement('span');
      text.textContent = state === 'active' ? (t.activeForm || t.content) : t.content;
      sec.head.append(mark, text);
      mbList.append(sec.el);
      if (state === 'active') mbActiveKey = key;
    }
    for (const [key, sec] of mbSections) if (!keep.has(key)) { sec.el.remove(); mbSections.delete(key); }

  }

  function marathonEvent(e) {
    const prev = marathonView || { phase: 'running', line: '', todos: [] };
    if (e.type === 'todos') {
      marathonView = { ...prev, todos: e.items };
    } else {
      const ev = e.event;
      const phase =
        ev.type === 'finished' ? ev.status :
        ev.type === 'paused' ? 'paused' :
        ev.type === 'verifying' || ev.type === 'verifyStep' ? 'verifying' : 'running';
      // A new goal starts with a clean list; anything else keeps the one it has.
      if (ev.type === 'started') resetMarathonLog();
      marathonView = { ...prev, phase, line: e.text, todos: ev.type === 'started' ? [] : prev.todos };
    }
    if (marathonArmed && e.type === 'marathon') { marathonArmed = false; marathonBtn.setAttribute('aria-pressed', 'false'); }
    drawMarathon();
  }

  // A turn ended without the run saying how (an error): it is stopped, not still going.
  function marathonTurnEnded() {
    if (marathonView && MB_LIVE.has(marathonView.phase)) {
      marathonView = { ...marathonView, phase: 'paused', line: 'Stopped' };
      drawMarathon();
    }
  }

  // Find a run again after a reload or a session switch.
  async function restoreMarathon() {
    if (realTurnRunning || !window.mw?.marathonGet) return;
    const m = await window.mw.marathonGet();
    if (m && m.status === 'running') marathonView = { phase: 'paused', line: 'Stopped. Resume to carry on.', todos: m.todos };
    else if (m) marathonView = { phase: m.status, line: '', todos: m.todos };
    else marathonView = marathonArmed ? marathonView : null;
    drawMarathon();
  }

  marathonBtn.addEventListener('click', () => {
    if (realTurnRunning) return; // a goal starts a run; there is nothing to arm mid-turn
    setMarathonArmed(!marathonArmed);
  });
  marathonBox.addEventListener('click', () => showMarathon());
  marathonBox.addEventListener('keydown', (e) => { if (e.target === marathonBox && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showMarathon(); } });
  mbResume.addEventListener('click', async (e) => {
    e.stopPropagation();
    const r = await window.mw.marathonResume();
    if (r?.ok) {
      ensureChatEventListener();
      realTurnRunning = true;
      startStatus();
      marathonView = { ...marathonView, phase: 'running', line: 'Carrying on' };
      drawMarathon();
    }
  });
  mbClose.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.mw.marathonClear();
    marathonView = null;
    drawMarathon();
  });

  function runRealTurn(userText, { filePaths = [], pastes = [] } = {}) {
    ensureChatEventListener();
    stoppedByUser = false;
    lastRaw = { text: userText, filePaths, pastes };
    clearRetry(); // a new turn: the old "send again" buttons are done with
    // Armed and idle: this message is the goal. Queued into a running turn it is just a message.
    const asGoal = marathonArmed && !realTurnRunning;
    if (viewingMarathon) showMain();
    // The finished run stays on screen until something new starts: this message.
    if (!asGoal && marathonView && ['done', 'blocked', 'stuck', 'budgetExceeded'].includes(marathonView.phase)) {
      void window.mw.marathonClear();
      marathonView = null;
      drawMarathon();
    }
    if (!realTurnRunning) {
      realTurnRunning = true;
      startStatus();
    }
    if (asGoal) {
      resetMarathonLog();
      marathonView = { phase: 'running', line: 'Starting', todos: [] };
      setMarathonArmed(false);
    }
    // The userMessage event (sent back from main.js) is what actually renders
    // the bubble — for both a fresh send and one queued into a running turn —
    // so there is exactly one code path for "a message was sent", not two.
    window.mw.chatSend(userText, filePaths, pastes, asGoal);
  }

  // When the last message went out. The empty-composer button means "stop", and a
  // turn starts the instant a message sends and the box clears, so a double-click on
  // send landed its second click on "stop" and cancelled the message it had just sent.
  let lastSendAt = 0;
  const STOP_AFTER_SEND_MS = 1000;
  sendBtn.addEventListener('click', () => {
    const text = composerInput.value.trim();
    if (needsKey) return; // nothing to send with; the button says "Connect a provider to start"
    if ((text || hasAttachments()) && viewingAgent == null && noProject) {
      void openProjectFirst().then((ok) => { if (ok) sendBtn.click(); });
      return;
    }
    // Attachments alone are a message (an image, a paste) — only a truly empty
    // composer means stop.
    if (!text && !hasAttachments()) {
      if (realTurnRunning && performance.now() - lastSendAt > STOP_AFTER_SEND_MS) stopNow();
      return;
    }
    lastSendAt = performance.now();
    if (viewingAgent != null) return; // an agent view is read only
    composerInput.value = '';
    composerInput.style.height = 'auto';
    updateSendButtonMode();
    setChatEmpty(false, { animate: true }); // the first message: glide down now, not after the round trip
    runRealTurn(text, takeAttachments());
  });

  // Esc stops. An open menu, dialog or picture viewer gets its own Esc first (the guards below).
  //
  // One press, and it is absolute, the same as the CLI: the turn stops and so does
  // everything it has running, background commands and the app being tested included
  // (main.js). With no turn running, it still stops background commands that are.
  // Not gated on what this window THINKS is running: a turn the agent started on its own, or a
  // message the model has not answered yet, may have drawn nothing so far. main.js knows.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.repeat) return;
    if (!settingsOverlay.hidden || !approvalDock.hidden) return;
    if (document.querySelector('.qtab-menu:not([hidden])')) return;
    if (lightbox && !lightbox.hidden) return; // the picture viewer closes on its own Esc
    e.preventDefault();
    stopNow();
  });

  // Stop is immediate on screen: whatever already arrived is drawn, the working strip goes,
  // the button is Send again. The engine's own "done" follows and changes nothing further.
  // Until it does, stray events from the stopped turn do not bring the working strip back.
  let stoppedByUser = false;
  function stopNow() {
    window.mw.chatCancel();
    if (!realTurnRunning) return;
    stoppedByUser = true;
    flushReveal();
    sealReply();
    offerRetry(null);
    stopStatus();
    realTurnRunning = false;
    updateSendButtonMode();
  }

  // Send key from Settings > General. 'enter': Enter sends, Shift+Enter is a
  // new line. 'ctrl': Ctrl+Enter sends and a plain Enter is a new line.
  let sendKey = 'enter';
  composerInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const send = sendKey === 'ctrl' ? (e.ctrlKey || e.metaKey) : !e.shiftKey;
    if (!send) return;
    e.preventDefault();
    // A held key repeats, and Enter in an empty box is never "stop": that is the
    // stop button's job (or Esc). Otherwise the repeat of the Enter that just sent
    // a message cancelled it before it reached the model.
    if (e.repeat) return;
    if (!composerInput.value.trim() && !hasAttachments()) return;
    sendBtn.click();
  });

  // ── Queue box: messages sent while the agent works ─────────────────────
  // main.js owns the queue and says what is in it after every change. Nothing here
  // reaches the chat until it is actually sent (taken in at a step, or sent as the
  // next turn); then the box empties.
  const queueBox = document.getElementById('queue-box');
  const qbList = document.getElementById('qb-list');
  const qbSend = document.getElementById('qb-send');
  const QB_MAX = 3;
  let queued = [];
  let queueLatest = [];
  // Sent, but their line is still waiting in the reveal pacer: they stay in the box
  // until they appear in the chat, so a message is never on screen in neither place.
  let queueInFlight = [];
  let queuePulling = false; // taken back to edit: gone from the queue, not sent
  function onQueueEvent(items) {
    const next = items || [];
    const gone = queueLatest.filter((a) => !next.some((b) => b.id === a.id));
    if (gone.length && !queuePulling && (revealQueue.length > 0 || pendingText)) queueInFlight.push(...gone);
    queueLatest = next;
    renderQueue([...queueInFlight, ...next]);
  }
  function queueLanded() {
    if (queueInFlight.length === 0) return;
    queueInFlight = [];
    renderQueue(queueLatest);
  }
  function renderQueue(items) {
    queued = items || [];
    queueBox.hidden = queued.length === 0;
    qbList.innerHTML = '';
    for (const it of queued.slice(0, QB_MAX)) {
      const row = document.createElement('div');
      row.className = 'qb-item';
      row.textContent = it.text || '';
      const n = (it.files?.length || 0) + (it.images || 0);
      if (n && !it.files?.length) {
        const att = document.createElement('span');
        att.className = 'qb-att';
        att.textContent = `${it.text ? '  ' : ''}+${n} attached`;
        row.appendChild(att);
      } else if (it.files?.length) {
        const att = document.createElement('span');
        att.className = 'qb-att';
        att.textContent = `${it.text ? '  ' : ''}${it.files.map((f) => f.name ?? f).join(', ')}`;
        row.appendChild(att);
      }
      qbList.appendChild(row);
    }
    if (queued.length > QB_MAX) {
      const more = document.createElement('div');
      more.className = 'qb-more';
      more.textContent = `and ${queued.length - QB_MAX} more`;
      qbList.appendChild(more);
    }
    qbSend.disabled = false;
  }
  // The whole queue back into the composer, as typed, the draft kept after it: the
  // only way to change your mind about something already queued.
  async function pullQueue() {
    queuePulling = true;
    let items;
    try {
      items = await window.mw?.queuePull?.();
    } finally {
      queuePulling = false;
    }
    if (!items || items.length === 0) return;
    const text = items.map((i) => i.text || '').filter(Boolean).join('\n');
    const draft = composerInput.value;
    composerInput.value = draft ? `${text}\n${draft}` : text;
    for (const i of items) {
      for (const p of i.filePaths || []) {
        const name = p.split(/[\\/]/).pop();
        const image = /\.(png|jpe?g|gif|webp|bmp)$/i.test(p);
        attachments.push({ id: ++attachSeq, kind: image ? 'image' : 'file', name, path: p, url: image ? `file:///${p.replace(/\\/g, '/')}` : null });
      }
      for (const t of i.pastes || []) attachments.push({ id: ++attachSeq, kind: 'paste', name: 'Pasted text', text: t });
    }
    renderAttachments();
    composerInput.style.height = 'auto';
    composerInput.style.height = `${composerInput.scrollHeight}px`;
    composerInput.focus();
    composerInput.setSelectionRange(text.length, text.length);
    updateSendButtonMode();
  }
  document.getElementById('qb-edit').addEventListener('click', pullQueue);
  qbSend.addEventListener('click', () => {
    qbSend.disabled = true;
    void window.mw?.queueSendNow?.();
  });
  // ↑ with the caret on the first line takes the queue back, as in the CLI.
  composerInput.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' || e.isComposing || queued.length === 0) return;
    if (composerInput.value.slice(0, composerInput.selectionStart).includes('\n')) return;
    e.preventDefault();
    void pullQueue();
  });

  // ── Context meter (composer) ─────────────────────────────────────────
  // Fills toward the bar the engine auto-compacts at, from the engine's own figure
  // (contextFill), so 100% here is when the compaction fires. Pushed after every
  // model call, compaction and turn end; asked for when a session or model changes.
  const ctxMeter = document.getElementById('ctx-meter');
  const ctxFill = document.getElementById('ctx-fill');
  const ctxPct = document.getElementById('ctx-pct');
  const ctxTipPct = document.getElementById('ctx-tip-pct');
  const ctxTipFill = document.getElementById('ctx-tip-fill');
  const ctxTipNum = document.getElementById('ctx-tip-num');
  const CTX_WARN = 90; // the engine's warn bar: 90% of the way to compacting
  function fmtTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : String(n);
  }
  // The card opens to the right of the meter; in a narrow window that runs off the screen,
  // so it is nudged back in whenever it is about to show.
  const ctxTip = document.getElementById('ctx-tip');
  function keepCtxTipOnScreen() {
    ctxTip.style.left = '0px';
    const r = ctxTip.getBoundingClientRect();
    const over = r.right - (window.innerWidth - 8);
    if (over > 0) ctxTip.style.left = `${-Math.min(over, Math.max(0, r.left - 8))}px`;
  }
  ctxMeter.addEventListener('mouseenter', keepCtxTipOnScreen);
  ctxMeter.addEventListener('focusin', keepCtxTipOnScreen);
  window.addEventListener('resize', () => { if (ctxMeter.classList.contains('pinned')) keepCtxTipOnScreen(); });
  let ctxLast = null; // the latest reading, where a compaction row starts from
  let compactRow = null; // the chat row of the compaction under way
  function applyContext(c) {
    if (!c || !(c.limit > 0)) { ctxMeter.hidden = true; return; }
    ctxLast = c;
    const pct = Math.max(0, Math.min(100, Math.round((c.used / c.limit) * 100)));
    ctxMeter.hidden = false;
    ctxMeter.classList.toggle('warn', pct >= CTX_WARN);
    ctxMeter.setAttribute('aria-valuenow', String(pct));
    ctxFill.style.width = ctxTipFill.style.width = `${pct}%`;
    ctxPct.textContent = `${pct}%`;
    ctxTipPct.textContent = `${pct}% full`;
    ctxTipNum.textContent = `${fmtTokens(c.used)} of ${fmtTokens(c.limit)} tokens`;
  }
  async function refreshContext() {
    try { applyContext(await window.mw?.contextFill?.()); } catch { /* keeps the last reading */ }
  }

  // Compacting, automatic or from the button: the meter sweeps while it runs. The
  // button compacts now, whatever the size; it waits while the agent is working,
  // since a turn is using the conversation it would rewrite.
  const ctxCompactBtn = document.getElementById('ctx-compact');
  const ctxCompactWhy = document.getElementById('ctx-compact-why');
  let compacting = false;
  let manualCompacting = false;
  function setCompacting(on) {
    compacting = on;
    ctxMeter.classList.toggle('compacting', on);
    if (on) { ctxPct.textContent = '···'; ctxTipPct.textContent = 'Compacting…'; }
    syncCompactBtn();
  }
  function syncCompactBtn() {
    const busy = realTurnRunning && !manualCompacting;
    ctxCompactBtn.disabled = compacting || busy;
    ctxCompactBtn.textContent = compacting ? 'Compacting…' : 'Compact now';
    ctxCompactWhy.textContent = compacting ? 'Summarizing older turns' : busy ? 'When the agent is idle' : "Don't wait until it's full";
  }
  ctxMeter.addEventListener('mouseenter', syncCompactBtn);
  ctxMeter.addEventListener('focusin', syncCompactBtn);
  ctxCompactBtn.addEventListener('click', async () => {
    if (compacting || realTurnRunning) return;
    manualCompacting = true;
    syncCompactBtn();
    try {
      const r = await window.mw.compactNow();
      if (r?.busy) ctxCompactWhy.textContent = 'When the agent is idle';
    } catch { /* the error arrives as a chat event */ }
    manualCompacting = false;
    if (compacting) setCompacting(false); // it ended even if no end event came
    syncCompactBtn();
    void refreshContext();
  });

  // ── Settings > Analytics ─────────────────────────────────────────────
  // The CLI's anonymous launch count, same flag file, so one switch covers both.
  const anSwitch = document.getElementById('an-switch');
  const anDesc = document.getElementById('an-desc');
  function applyAnalytics(a) {
    if (!a) return;
    anSwitch.classList.toggle('on', a.enabled);
    anSwitch.setAttribute('aria-checked', String(a.enabled));
    anDesc.textContent = a.enabled ? 'On. Sent once each time Mindweave opens' : a.paused ? 'Off for now. We are building a better way to count, and nothing is sent' : 'Off. Nothing is sent';
  }
  window.mw?.getAnalytics?.().then(applyAnalytics);
  // The generic switch handler has already flipped it; what the engine saved is
  // the truth, so the switch is set from its answer.
  anSwitch.addEventListener('click', async () => applyAnalytics(await window.mw.setAnalytics(anSwitch.classList.contains('on'))));
  document.querySelectorAll('#panel-analytics .pd-link').forEach((b) => {
    b.insertAdjacentHTML('beforeend', ` ${EXT_SVG}`);
    b.addEventListener('click', () => window.mw.openExternal(b.dataset.url));
  });

  // ── Feedback (sidebar) ──────────────────────────────────────────────
  // The CLI's /feedback: the engine builds and checks the payload and judges
  // delivery. The pop-over shows what goes with the message before Send, which
  // is the confirmation; a draft survives closing it until it is sent.
  const fbBtn = document.getElementById('feedback-btn');
  const fbPop = document.getElementById('fb-pop');
  const fbForm = document.getElementById('fb-form');
  const fbDone = document.getElementById('fb-done');
  const fbText = document.getElementById('fb-text');
  const fbNote = document.getElementById('fb-note');
  const fbError = document.getElementById('fb-error');
  const fbCount = document.getElementById('fb-count');
  const fbSend = document.getElementById('fb-send');
  const PLATFORM_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  let fbInfo = { max: 4000 };
  let fbSending = false;
  let fbDoneTimer = null;
  window.mw?.feedbackInfo?.().then((info) => {
    fbInfo = info;
    fbNote.textContent =
      `Sent along: the version (${info.version}) and your system (${PLATFORM_NAMES[info.platform] ?? info.platform}). ` +
      'Never your conversation, code or keys. For a reply, put your email in the message.';
    fbSync();
  });
  function fbSync() {
    const n = fbText.value.trim().length;
    const over = n > fbInfo.max;
    fbCount.textContent = n > fbInfo.max * 0.8 ? `${n} / ${fbInfo.max}` : '';
    fbCount.classList.toggle('over', over);
    fbSend.disabled = fbSending || n === 0 || over;
  }
  function fbPlace() {
    const r = fbBtn.getBoundingClientRect();
    fbPop.style.left = `${Math.round(r.right + 8)}px`;
    fbPop.style.right = 'auto';
    fbPop.style.top = 'auto';
    fbPop.style.bottom = `${Math.max(8, Math.round(window.innerHeight - r.bottom))}px`;
  }
  function fbOpen() {
    closeQtabMenus();
    clearTimeout(fbDoneTimer);
    fbForm.hidden = false;
    fbDone.hidden = true;
    fbError.hidden = true;
    fbPlace();
    fbPop.hidden = false;
    fbBtn.classList.add('open');
    fbSync();
    fbText.focus();
  }
  function fbClose() {
    clearTimeout(fbDoneTimer);
    fbPop.hidden = true;
    fbBtn.classList.remove('open');
  }
  async function fbSendNow() {
    const text = fbText.value.trim();
    if (fbSending || !text || text.length > fbInfo.max) return;
    fbSending = true;
    fbError.hidden = true;
    fbSend.textContent = 'Sending…';
    fbSync();
    let result;
    try {
      result = await window.mw.sendFeedback(text);
    } catch (err) {
      result = { ok: false, message: `Feedback could not be sent (${err?.message || err}).` };
    }
    fbSending = false;
    fbSend.textContent = 'Send';
    if (result.ok) {
      fbText.value = '';
      fbForm.hidden = true;
      fbDone.hidden = false;
      fbDoneTimer = setTimeout(fbClose, 2400);
    } else {
      // The engine's own sentence, with its "open an issue" address made clickable.
      const url = fbInfo.issuesUrl;
      fbError.innerHTML = escapeHtml(result.message).replace(escapeHtml(url ?? '\u0000'), `<button type="button">${escapeHtml(url ?? '')}</button>`);
      fbError.querySelector('button')?.addEventListener('click', () => window.mw.openExternal(url));
      fbError.hidden = false;
    }
    fbSync();
  }
  fbBtn.addEventListener('click', () => (fbPop.hidden ? fbOpen() : fbClose()));
  document.getElementById('fb-cancel').addEventListener('click', fbClose);
  fbSend.addEventListener('click', fbSendNow);
  fbText.addEventListener('input', fbSync);
  fbText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); fbSendNow(); }
  });
  document.addEventListener('mousedown', (e) => {
    if (!fbPop.hidden && !fbPop.contains(e.target) && !fbBtn.contains(e.target)) fbClose();
  });
  // Captured first, so Esc here closes the pop-over and never also stops a turn.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !fbPop.hidden) { e.preventDefault(); e.stopImmediatePropagation(); fbClose(); }
  }, true);
  window.addEventListener('resize', () => { if (!fbPop.hidden) fbPlace(); });

  // ── Settings > General ───────────────────────────────────────────────
  // Name, level and style are saved to the engine's profile and reach the agent
  // on your next message. Each level/style button is a real instruction; click
  // the selected one again to clear it and leave the agent's default.
  const prefName = document.getElementById('pref-name');
  const prefSend = document.getElementById('pref-send');
  const prefSendDesc = document.getElementById('pref-send-desc');
  const prefLevel = document.getElementById('pref-level');
  const prefLevelDesc = document.getElementById('pref-level-desc');
  const prefStyle = document.getElementById('pref-style');
  const prefStyleDesc = document.getElementById('pref-style-desc');
  const prefLogin = document.getElementById('pref-login');
  const LEVEL_DESC = {
    '': 'Not set. The agent judges from how you write',
    beginner: 'Plain words, terms explained, exact steps',
    intermediate: 'Skips the basics, explains non-obvious choices',
    expert: 'Terse and technical, only trade-offs and risks',
  };
  const STYLE_DESC = {
    '': "Not set. The agent's default length",
    concise: 'Short: the answer first, no recap',
    balanced: 'The result, then only the details that matter',
    detailed: 'Reasoning, what changed and why, what to check',
  };
  const THEME_DESC = {
    system: `Follows ${OS_NAME}: light or dark, whichever it is set to`,
    light: 'Always light',
    dark: 'Always dark',
  };
  let prefs = null;
  function applyPrefs(p) {
    if (!p) return;
    prefs = p;
    sendKey = p.sendKey;
    if (document.activeElement !== prefName) prefName.value = p.name;
    prefSend.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.send === sendKey));
    prefSendDesc.textContent = sendKey === 'ctrl'
      ? `${MOD}+Enter sends, Enter adds a new line`
      : 'Enter sends, Shift+Enter adds a new line';
    prefLevel.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === p.level));
    prefLevelDesc.textContent = LEVEL_DESC[p.level] ?? LEVEL_DESC[''];
    prefStyle.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.v === p.style));
    prefStyleDesc.textContent = STYLE_DESC[p.style] ?? STYLE_DESC[''];
    const theme = p.theme || 'system';
    document.querySelectorAll('#pref-theme button').forEach((b) => b.classList.toggle('active', b.dataset.theme === theme));
    document.getElementById('pref-theme-desc').textContent = THEME_DESC[theme];
    prefLogin.classList.toggle('on', !!p.openAtLogin);
    prefLogin.setAttribute('aria-checked', String(!!p.openAtLogin));
  }
  window.mw?.getPrefs?.().then(applyPrefs);
  document.querySelectorAll('#pref-theme button').forEach((b) => {
    b.addEventListener('click', async () => applyPrefs(await window.mw.setPrefs({ theme: b.dataset.theme })));
  });
  prefSend.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', async () => applyPrefs(await window.mw.setPrefs({ sendKey: b.dataset.send })));
  });
  for (const [seg, key] of [[prefLevel, 'level'], [prefStyle, 'style']]) {
    seg.querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', async () => {
        const value = prefs?.[key] === b.dataset.v ? '' : b.dataset.v;
        applyPrefs(await window.mw.setPrefs({ [key]: value }));
      });
    });
  }
  // The generic switch handler has already flipped it; the saved state is the
  // truth, so it's set from what Windows reports back, not from the click.
  prefLogin.addEventListener('click', async () => {
    applyPrefs(await window.mw.setPrefs({ openAtLogin: prefLogin.classList.contains('on') }));
  });
  // Saved when you leave the field or press Enter, not per keystroke.
  async function saveName() {
    applyPrefs(await window.mw.setPrefs({ name: prefName.value }));
  }
  prefName.addEventListener('change', saveName);
  prefName.addEventListener('keydown', (e) => { if (e.key === 'Enter') prefName.blur(); });

  // The open project's MINDWEAVE.md: a card with a preview; clicking it (or Edit) opens it in
  // the viewer as an editor, and Upload loads a file's text into that same
  // editor so you see it before it replaces anything.
  const notesCard = document.getElementById('notes-card');
  const notesMeta = document.getElementById('notes-meta');
  const notesPreview = document.getElementById('notes-preview');
  let notes = null;
  function ago(ms) {
    const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 60) return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }
  function renderNotes(n) {
    if (!n) return;
    notes = n;
    const text = n.text.trim();
    const lines = text ? text.split('\n').length : 0;
    notesMeta.textContent = text
      ? `${lines} line${lines === 1 ? '' : 's'} · edited ${ago(n.modifiedAt)}`
      : n.exists ? 'Empty' : 'Not created yet';
    document.getElementById('notes-desc').textContent = currentProjectCwd
      ? `In ${currentProjectCwd.split(/[\\/]/).pop()}, read by the agent every session`
      : "The project's notes, read by the agent every session";
    notesPreview.classList.toggle('empty', !text);
    notesPreview.textContent = text
      ? text.split('\n').filter((l) => l.trim()).slice(0, 4).join('\n')
      : 'Nothing here yet. Click to write what the agent should know about this project, like "we use pnpm" or "keep commits small".';
  }
  function refreshNotes() { window.mw?.getUserNotes?.().then(renderNotes); }
  refreshNotes();
  document.getElementById('open-settings').addEventListener('click', refreshNotes);

  // Any text file in the same editor (rules, skills): `onSave(text)` resolves true
  // when saved, false to keep the editor open (the page shows why).
  function openFileEditor(title, path, text, onSave) {
    openNotesEditor(text, null, { title, path, onSave });
  }

  function openNotesEditor(text, source, file = null) {
    // An upload counts as a change until it's saved, so closing it asks too.
    viewing = { kind: 'notes', original: source ? null : text, file };
    viewer.dataset.kind = 'notes';
    viewer.classList.add('over-settings');
    viewerIco.hidden = false;
    viewerIco.innerHTML = FILE_SVG;
    viewerName.textContent = file ? file.title : 'MINDWEAVE.md';
    viewerFoot.hidden = false;
    viewerBody.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'att-edit';
    ta.value = text;
    ta.spellcheck = false;
    ta.placeholder = file ? '' : 'What the agent should know about this project, in plain Markdown.';
    const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
    const syncMeta = () => {
      const n = ta.value.split('\n').length;
      viewerMeta.textContent = file ? file.path : `${source ? `from ${source} · ` : ''}${n} line${n === 1 ? '' : 's'}`;
    };
    ta.addEventListener('input', () => { syncMeta(); fit(); });
    ta.addEventListener('mousemove', (e) => {
      ta.style.cursor = e.offsetX > ta.clientWidth - 16 ? 'default' : '';
    });
    syncMeta();
    viewerBody.appendChild(ta);
    viewer.hidden = false;
    setTimeout(() => { fit(); ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);
  }
  async function closeNotesEditor({ save } = {}) {
    const ta = viewerBody.querySelector('.att-edit');
    const text = ta?.value ?? '';
    const finish = () => {
      viewer.hidden = true;
      viewer.classList.remove('over-settings');
      viewing = null;
    };
    if (save) {
      if (viewing.file) {
        if (await viewing.file.onSave(text)) finish();
        return;
      }
      renderNotes(await window.mw.saveUserNotes(text));
      return finish();
    }
    // Closing with changes asks first, so a stray Escape can't throw them away.
    if (text !== viewing.original) {
      confirmAction(`Discard your changes to ${viewing.file ? viewing.file.title : 'MINDWEAVE.md'}?`, finish);
      return;
    }
    finish();
  }
  document.getElementById('notes-edit').addEventListener('click', (e) => { e.stopPropagation(); openNotesEditor(notesText()); });
  const notesText = () => (notes?.text.trim() ? notes.text : '');
  notesCard.addEventListener('click', () => openNotesEditor(notesText()));
  notesCard.addEventListener('keydown', (e) => {
    if (e.target === notesCard && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openNotesEditor(notesText()); }
  });
  document.getElementById('notes-upload').addEventListener('click', async (e) => {
    e.stopPropagation();
    const picked = await window.mw.pickUserNotes();
    if (!picked) return;
    if (picked.error) { notesMeta.textContent = picked.error; return; }
    openNotesEditor(picked.text, picked.name);
  });

  // The box grows with what you type instead of scrolling internally —
  // reset to auto first so shrinking (deleting a line) is measured
  // correctly, not stuck at whatever the tallest height was.
  function autoGrow() {
    composerInput.style.height = 'auto';
    composerInput.style.height = `${composerInput.scrollHeight}px`;
  }
  composerInput.addEventListener('input', autoGrow);
  composerInput.addEventListener('input', updateSendButtonMode);

  // ── The unsent message survives anything ─────────────────────────────
  // Text and attachments are saved per project moments after every change
  // (main.js, drafts.json), so a restart, a crash or a project switch leaves the
  // message waiting in the box. Sending clears it. Files come back by their path;
  // pasted text comes back whole.
  let draftTimer = null;
  let draftCwd = null; // the project the box's current content belongs to
  function draftNow() {
    return {
      text: composerInput.value,
      attachments: attachments.map((a) => (a.kind === 'paste'
        ? { kind: 'paste', name: a.name, text: a.text }
        : { kind: a.kind, name: a.name, path: a.path, size: a.size })),
    };
  }
  function scheduleDraftSave() {
    if (!window.mw?.setDraft || !draftCwd) return;
    clearTimeout(draftTimer);
    const cwd = draftCwd;
    draftTimer = setTimeout(() => window.mw.setDraft(cwd, draftNow()), 300);
  }
  async function flushDraft() {
    clearTimeout(draftTimer);
    if (window.mw?.setDraft && draftCwd) await window.mw.setDraft(draftCwd, draftNow());
  }
  async function restoreDraft(cwd, { onlyIfEmpty = false } = {}) {
    draftCwd = cwd;
    const d = window.mw?.getDraft ? await window.mw.getDraft(cwd) : null;
    // At startup the saved draft can arrive after you have already started typing;
    // what you typed wins, and is saved as the draft from here on.
    if (onlyIfEmpty && (composerInput.value.trim() || attachments.length)) { scheduleDraftSave(); return; }
    attachments.forEach((a) => a.url && a.url.startsWith('blob:') && URL.revokeObjectURL(a.url));
    composerInput.value = d?.text ?? '';
    attachments = (d?.attachments ?? []).map((a) => ({
      ...a,
      id: ++attachSeq,
      // A restored image previews straight from its file; this page is itself a file:// page.
      url: a.kind === 'image' && a.path ? encodeURI(`file:///${a.path.replace(/\\/g, '/')}`) : null,
    }));
    renderAttachments();
    autoGrow();
    updateSendButtonMode();
  }
  composerInput.addEventListener('input', scheduleDraftSave);
  // Leaving the window (closing it, reloading) writes whatever is pending right away.
  window.addEventListener('beforeunload', () => { clearTimeout(draftTimer); if (draftCwd) window.mw?.setDraftSync?.(draftCwd, draftNow()); });

  // ── Edit and resend (rewind) ─────────────────────────────────────────
  // The core lists the messages it can go back to, newest first, and they line up one
  // for one with the bubbles that can be rewound, counted from the bottom. Counting from
  // the bottom also survives compaction, which only ever removes the oldest.
  function rewindProblem(text) {
    addToolBlock({ iconPath: DEFAULT_TOOL_ICON, headText: toolHeadHtml('Rewind', text), bodyHtml: '', kind: 'error', state: 'failed', sys: true });
    scrollChatToBottom(true);
  }
  async function rewindFromBubble(bubble) {
    if (realTurnRunning) { rewindProblem('Stop the agent first. Rewinding happens between turns.'); return; }
    const bubbles = [...chatBodyEl.querySelectorAll('.user-msg:not([data-no-rewind])')];
    const fromEnd = bubbles.length - 1 - bubbles.indexOf(bubble);
    const points = await window.mw.rewindPoints();
    const point = points[fromEnd];
    if (!point) { rewindProblem("That message isn't in the conversation any more."); return; }
    const what = changeSummary(point);
    const hasFiles = what !== '';
    const shell = point.ranShell ? ' Commands the agent ran are not undone.' : '';
    const intro = hasFiles
      ? `Go back to before this message? Since then: ${what}.${shell}`
      : `Go back to before this message? It returns to the box to edit, and everything after it is removed.${shell}`;
    chooseAction(intro, [
      { label: 'Cancel' },
      ...(hasFiles ? [{ label: 'Files only', onPick: () => void applyRewind(point, 'files') }] : []),
      { label: hasFiles ? 'Conversation only' : 'Rewind', primary: !hasFiles, onPick: () => void applyRewind(point, 'conversation') },
      ...(hasFiles ? [{ label: 'Conversation and files', primary: true, onPick: () => void applyRewind(point, 'both') }] : []),
    ]);
  }

  // "2 files +12 −3, 1 memory": what the turns since a message changed.
  const STATE_NOUN = {
    memory: ['memory', 'memories'], rule: ['rule', 'rules'], skill: ['skill', 'skills'],
    permission: ['permission list', 'permission lists'], mcp: ['MCP config', 'MCP configs'],
  };
  function stateSummary(counts) {
    return Object.entries(counts || {})
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${STATE_NOUN[k]?.[n === 1 ? 0 : 1] ?? k}`)
      .join(', ');
  }
  function changeSummary(p) {
    const parts = [];
    if (p.files > 0) parts.push(`${p.files} file${p.files === 1 ? '' : 's'} +${p.added} −${p.removed}`);
    const state = stateSummary(p.state);
    if (state) parts.push(state);
    return parts.join(', ');
  }

  async function applyRewind(point, mode) {
    const r = await window.mw.rewindTo(point.at, mode);
    if (r?.error) { rewindProblem(r.error); return; }
    // Files only: the conversation stays exactly as it is on screen.
    if (mode !== 'files') renderReplay(r.replay);
    const warn = [
      r.conflicts.length && `left alone, changed since: ${r.conflicts.map(baseName).join(', ')}`,
      r.failed.length && `could not be put back: ${r.failed.map(baseName).join(', ')}`,
      r.skipped.length && `too large to have been kept: ${r.skipped.map(baseName).join(', ')}`,
      r.notRestored.length && `changed before the app was reopened, so still changed: ${r.notRestored.map(baseName).join(', ')}`,
      r.ranShell && 'commands the agent ran are not undone',
    ].filter(Boolean);
    const counts = {};
    for (const { kind } of r.restoredState) counts[kind] = (counts[kind] || 0) + 1;
    const took = [
      r.restored.length && `put back ${r.restored.length} file${r.restored.length === 1 ? '' : 's'}`,
      stateSummary(counts) && `took back ${stateSummary(counts)}`,
    ].filter(Boolean).join(' · ');
    const head = mode === 'files' ? 'Files rolled back to before your message' : 'Rewound to before your message';
    addToolBlock({
      iconPath: DEFAULT_TOOL_ICON,
      headText: `<span class="tool-head-text">${head}${took ? ` · ${escapeHtml(took)}` : ''}</span>`,
      bodyHtml: warn.length ? `<div class="dim-l prose">${warn.map(escapeHtml).join('<br>')}</div>` : '',
      sys: true,
    });
    scrollChatToBottom(true);
    if (mode === 'files') return; // the message stays where it is; nothing to edit
    // The message back in the box as it was sent: text, pastes and files in the tray.
    const m = r.message;
    attachments.forEach((a) => a.url && a.url.startsWith('blob:') && URL.revokeObjectURL(a.url));
    attachments = [
      ...m.pastes.map((text) => ({ id: ++attachSeq, kind: 'paste', name: 'Pasted text', text })),
      ...m.files.map((path) => ({ id: ++attachSeq, kind: 'file', name: baseName(path), path })),
      ...m.images.map((path) => ({ id: ++attachSeq, kind: 'image', name: baseName(path), path, url: fileUrl(path) })),
    ];
    composerInput.value = m.text;
    renderAttachments();
    autoGrow();
    updateSendButtonMode();
    scrollChatToBottom('instant');
    composerInput.focus();
    composerInput.setSelectionRange(composerInput.value.length, composerInput.value.length);
  }

  // ── Replaying a loaded session's history ─────────────────────────────
  // Same shapes runTurn's live TurnEvents use (see turnRunner.ts's ReplayEvent),
  // so a session switch and a live turn share the rendering, not two versions
  // of "what a tool call looks like".
  // ── A long session draws only its recent part ─────────────────────────────
  // Drawing every row of a marathon-sized session put tens of thousands of elements on the page
  // (about a gigabyte of memory, and scrolling at a crawl). So a session opens on its last
  // REPLAY_WINDOW events, and a "Show earlier" bar at the top brings the rest in, a chunk at a time,
  // without moving what you are looking at. A long run that keeps going trims its oldest rows the
  // same way (trimLiveChat). Nothing is lost: it is all in the session file.
  const REPLAY_WINDOW = 400;
  const REPLAY_CHUNK = 400;
  const LIVE_MAX_BLOCKS = 900; // a live run past this many rows...
  const LIVE_KEEP_BLOCKS = 500; // ...keeps this many
  let replayAll = [];
  let replayStart = 0;
  // Start at a message of yours where possible, so the first thing on screen is what was asked.
  function replayStartFor(events, want) {
    if (want <= 0) return 0;
    for (let i = want; i < Math.min(events.length, want + 200); i++) if (events[i].type === 'userMessage') return i;
    return want;
  }
  function earlierBar(hidden) {
    const bar = document.createElement('div');
    bar.className = 'earlier-bar';
    bar.innerHTML = '<button type="button" class="settings-btn">Show earlier</button><span></span>';
    bar.querySelector('span').textContent = hidden ? hidden.toLocaleString('en-US') + ' earlier ' + (hidden === 1 ? 'row' : 'rows') + ' not shown' : 'Earlier rows not shown';
    bar.querySelector('button').addEventListener('click', showEarlier);
    return bar;
  }
  async function showEarlier() {
    if (realTurnRunning) {
      const note = chatBodyEl.querySelector('.earlier-bar span');
      if (note) note.textContent = 'Available when this turn finishes';
      return;
    }
    // After a live trim, what is on screen is newer than the history held here: fetch it again and
    // redraw. Otherwise only the older chunk is drawn, above the rows already there.
    let whole = false;
    if (chatBodyEl.querySelector('.earlier-bar.live') && window.mw?.sessionReplay) {
      replayAll = await window.mw.sessionReplay();
      replayStart = Math.max(0, replayAll.length - REPLAY_WINDOW);
      whole = true;
    }
    // Keep the first row on screen where it is while rows are added above it: each drawn row knows the
    // history entry it came from (data-ev), so the same row is found again after the redraw.
    const anchor = chatBodyEl.querySelector(':scope > [data-ev]');
    const anchorEv = anchor?.dataset.ev;
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    const newStart = replayStartFor(replayAll, Math.max(0, replayStart - REPLAY_CHUNK));
    if (whole) drawReplay(newStart); else drawReplay(newStart, replayStart);
    const same = anchorEv != null && chatBodyEl.querySelector(`:scope > [data-ev="${anchorEv}"]`);
    if (same) chatBodyEl.scrollTop += same.getBoundingClientRect().top - before;
    endTest();
    offerRetryIfInterrupted();
  }
  function trimLiveChat() {
    const blocks = chatBodyEl.children.length;
    if (blocks <= LIVE_MAX_BLOCKS || !autoFollow) return; // never while you are reading further up
    const cut = blocks - LIVE_KEEP_BLOCKS;
    let removed = 0;
    for (const el of [...chatBodyEl.children]) {
      if (removed >= cut) break;
      if (el.classList.contains('earlier-bar')) continue;
      el.remove();
      removed++;
    }
    let bar = chatBodyEl.querySelector('.earlier-bar');
    if (!bar) { bar = earlierBar(0); chatBodyEl.prepend(bar); }
    bar.classList.add('live');
    bar.querySelector('span').textContent = 'Earlier rows not shown';
  }
  let trimTimer = null;
  new MutationObserver(() => {
    if (trimTimer || chatBodyEl.children.length <= LIVE_MAX_BLOCKS) return;
    trimTimer = setTimeout(() => { trimTimer = null; trimLiveChat(); }, 2000);
  }).observe(chatBodyEl, { childList: true });

  function renderReplay(events) {
    scrollHold = { keep: false }; // drawing rewinds the scroll: nothing is saved from it
    void refreshContext(); // this session's own reading
    void restoreMarathon(); // and its own run, if it has one
    // Only a session where nothing has been said yet gets the centred composer.
    // Any history at all opens in the normal layout, with no glide on the way in.
    setChatEmpty(events.length === 0, { animate: false });
    resetAgents(); // another session's agents are not this one's
    replayAll = events;
    drawReplay(replayStartFor(events, events.length - REPLAY_WINDOW));
    endTest();
    scrollChatToBottom('instant');
    restoreScroll(); // back to where this session was being read, if it was not at the end
    offerRetryIfInterrupted();
  }

  // Draws history events[start..end). With an end short of the last event, the rows already on screen
  // are set aside, the older chunk is drawn, and they are put back below it: Show earlier costs one
  // chunk, however much is already open.
  function drawReplay(start, end = replayAll.length) {
    replayStart = start;
    const events = replayAll.slice(start, end);
    const kept = end < replayAll.length ? [...chatBodyEl.children].filter((el) => !el.classList.contains('earlier-bar')) : null;
    chatBodyEl.innerHTML = '';
    if (start > 0) chatBodyEl.appendChild(earlierBar(start));
    openToolBlocks.clear();
    heldLookups.clear();
    resetReadRecs();
    sealReply();
    turnTest = null;
    bulkDrawing = true;
    try {
    let tagged = chatBodyEl.children.length;
    const tagRows = (n) => {
      const kids = chatBodyEl.children;
      for (; tagged < kids.length; tagged++) if (!kids[tagged].dataset.ev) kids[tagged].dataset.ev = String(n);
    };
    events.forEach((e, n) => {
      tagRows(start + n - 1);
      switch (e.type) {
        case 'userMessage':
          endTest();
          resetReadRecs();
          addUserMessage(e.text, false, e.expiredImages, e.images, e.files, e.noRewind);
          break;
        case 'assistantMessage': {
          // Said while testing: it stays with the test.
          const say = testSayTarget();
          if (say) {
            say.classList.remove('enter');
            say._text = e.text;
            renderMarkdown(say.querySelector('.md'), e.text);
            testSayDone();
            break;
          }
          const msg = buildMsgEl();
          msg.classList.remove('enter'); // a full history redraw shouldn't replay every entrance animation at once
          const body = document.createElement('div');
          body.className = 'md';
          renderMarkdown(body, e.text);
          msg.querySelector('.msg-body').appendChild(body);
          chatBodyEl.appendChild(msg);
          break;
        }
        case 'toolReplay': {
          if (e.quiet) break; // searches: the chat never draws them
          if (e.tool === 'ui') {
            replayTestStep(e);
            break;
          }
          if (e.kind === 'websearch') {
            const id = `replay-${Math.random()}`;
            webStart({ ...e, id }, false);
            webEnd({ ...e, id }, false);
            break;
          }
          if (e.kind === 'read' && e.arg && readRecs.has(e.arg)) {
            const rec = readRecs.get(e.arg);
            rec.count++;
            recordRead(rec, e);
            setReadRecState(rec);
            break;
          }
          if (e.kind === 'read' && e.arg) {
            const tool = addToolBlock({
              iconPath: TOOL_ICONS.read,
              headText: toolHeadHtml(toolVerb(e.name, true), e.arg),
              bodyHtml: e.ok ? '' : toolResultHtml(e),
              kind: 'read',
              state: e.ok ? 'ok' : 'failed',
            });
            tool.classList.remove('enter');
            tool.dataset.name = e.name;
            addOpenButton(tool, e);
            if (tool._files) tool._line = lineOf(e.tool, e.args, e.detail);
            const rec = newReadRec('card', tool, addToolMeta(tool), 0);
            readRecs.set(e.arg, rec);
            recordRead(rec, e);
            break;
          }
          const isToolSearch = e.name === 'Tools';
          const tool = addToolBlock({
            iconPath: TOOL_ICONS[e.kind] || DEFAULT_TOOL_ICON,
            headText: toolHeadHtml(toolVerb(e.name, true), isToolSearch ? null : e.arg),
            bodyHtml: toolResultHtml(e),
            kind: e.kind,
            state: e.ok ? 'ok' : 'failed',
          });
          tool.classList.remove('enter');
          tool.dataset.name = e.name;
          if (isToolSearch && e.arg) addToolMeta(tool).textContent = `for “${truncateMid(e.arg, 40)}”`;
          addOpenButton(tool, e);
          if (tool._files) tool._line = lineOf(e.tool, e.args, e.detail);
          if (presentSpecialOutcome(tool, e)) break;
          addDiffStats(tool, e);
          addToolImages(tool, e.images);
          break;
        }
        case 'compactionSummary':
          // The summary text itself is a model-facing recap, not something worth
          // reading in the chat (it can run to a full screen of markdown) — the live
          // row never showed it either, only the before/after numbers. On replay
          // those numbers aren't persisted, so there's nothing useful to expand into;
          // the row just says it happened.
          // Back to back compactions (nothing said in between) were one row live: one row here too.
          if (lastChatBlock()?.classList.contains('cmp-replay')) break;
          addToolBlock({ iconPath: DEFAULT_TOOL_ICON, headText: '<span class="tool-head-text">Compacted the conversation</span>', bodyHtml: '', noBody: true, sys: true }).classList.add('cmp-replay');
          break;
      }
    });
    tagRows(start + events.length - 1);
    if (kept) chatBodyEl.append(...kept);
    } finally { bulkDrawing = false; }
  }

  // ── Startup: load whatever session was last active, exactly as it left off ──
  (async () => {
    if (!window.mw?.getInitialState) return;
    ensureChatEventListener();
    const state = await window.mw.getInitialState();
    setProjectState(state);
    void refreshKeyState();
    currentProjectCwd = state.cwd;
    restoreDraft(state.cwd, { onlyIfEmpty: true });
    renderRecentProjects(state.recentProjects);
    renderSessionList(state.sessions, state.sessionId);
    applyModelState(state.model);
    applyThinkingState(state.thinking);
    applyModeState(state.mode);
    renderReplay(state.replay);
    void refreshLimitMeter(); // only there while limits are on
  })();
