/* "What's new" popup (once per release, per user) and the help assistant chat
 * button in the bottom-right corner. Loaded on every logged-in page by app-nav.js. */
(function () {
  if (window.__scpAssistant) return;
  window.__scpAssistant = true;
  // Public website (no login) vs. the logged-in app.
  var me = document.currentScript;
  var PUBLIC = !!(me && me.getAttribute('data-mode') === 'public');
  var ENDPOINT = PUBLIC ? '/api/public/assistant/chat' : '/api/assistant/chat';
  var STORE = PUBLIC ? 'scpChatPublic' : 'scpChat';

  var css = document.createElement('style');
  css.textContent =
    '.scp-fab{position:fixed;right:20px;bottom:20px;z-index:1100;width:58px;height:58px;border-radius:50%;border:0;background:#F2A93B;color:#172235;box-shadow:0 8px 24px rgba(0,0,0,.25);cursor:pointer;display:flex;align-items:center;justify-content:center}' +
    '.scp-fab:hover{background:#e59a28}' +
    '.scp-chat{position:fixed;right:20px;bottom:90px;z-index:1100;width:380px;max-width:calc(100vw - 32px);height:520px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;font-family:inherit}' +
    '.scp-chat.open{display:flex}' +
    '.scp-chat header{background:#172235;color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:10px}' +
    '.scp-chat header b{font-size:1em}.scp-chat header small{display:block;opacity:.75;font-size:.78em;margin-top:2px}' +
    '.scp-chat header button{background:none;border:0;color:#fff;font-size:1.5em;cursor:pointer;width:40px;height:40px;line-height:1}' +
    '.scp-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f8fafc}' +
    '.scp-msg{max-width:88%;padding:10px 12px;border-radius:12px;font-size:.9em;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}' +
    '.scp-msg.user{align-self:flex-end;background:#172235;color:#fff;border-bottom-right-radius:4px}' +
    '.scp-msg.bot{align-self:flex-start;background:#fff;border:1px solid #e2e8f0;color:#1e293b;border-bottom-left-radius:4px}' +
    '.scp-msg.bot a{color:#1d4e89;font-weight:600}' +
    '.scp-sugg{display:flex;flex-wrap:wrap;gap:6px}' +
    '.scp-sugg button{background:#fff;border:1px solid #cbd5e1;border-radius:999px;padding:7px 11px;font-size:.8em;cursor:pointer;color:#172235}' +
    '.scp-sugg button:hover{border-color:#172235}' +
    '.scp-form{display:flex;gap:8px;padding:10px;border-top:1px solid #e2e8f0;background:#fff}' +
    '.scp-form textarea{flex:1;resize:none;border:1.5px solid #cbd5e1;border-radius:10px;padding:10px;font-family:inherit;font-size:.92em;height:44px;max-height:120px}' +
    '.scp-form button{background:#172235;color:#fff;border:0;border-radius:10px;padding:0 16px;font-weight:700;cursor:pointer;min-height:44px}' +
    '.scp-form button:disabled{opacity:.5}' +
    '.scp-typing{align-self:flex-start;color:#64748b;font-size:.85em}' +
    '.scp-modal-bg{position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:1200;display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.scp-modal{background:#fff;border-radius:16px;max-width:560px;width:100%;max-height:calc(100vh - 32px);overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)}' +
    '.scp-modal .top{background:linear-gradient(135deg,#172235,#1e3a5f);color:#fff;padding:22px 24px;border-radius:16px 16px 0 0}' +
    '.scp-modal .top h2{font-size:1.35em;margin:0 0 4px}.scp-modal .top p{opacity:.85;font-size:.92em;margin:0}' +
    '.scp-modal .items{padding:8px 24px}' +
    '.scp-modal .it{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid #f1f5f9}' +
    '.scp-modal .it:last-child{border-bottom:0}' +
    '.scp-modal .it .n{flex:0 0 26px;height:26px;border-radius:50%;background:#F2A93B;color:#172235;font-weight:800;font-size:.8em;display:flex;align-items:center;justify-content:center}' +
    '.scp-modal .it b{color:#172235}.scp-modal .it p{color:#475569;font-size:.88em;margin:3px 0 0;line-height:1.45}' +
    '.scp-modal .it a{font-size:.82em;font-weight:700;color:#1d4e89}' +
    '.scp-modal .acts{display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;padding:14px 24px 22px}' +
    '.scp-modal .acts a,.scp-modal .acts button{min-height:44px;padding:0 18px;border-radius:10px;font-weight:700;font-size:.95em;display:inline-flex;align-items:center;cursor:pointer;text-decoration:none}' +
    '.scp-modal .acts a{border:1.5px solid #172235;color:#172235}.scp-modal .acts button{background:#172235;color:#fff;border:0}' +
    '@media print{.scp-fab,.scp-chat{display:none!important}}';
  document.head.appendChild(css);

  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Escape, then turn app paths like (/hailmap) and https links into links.
  function linkify(t) {
    return esc(t)
      .replace(/(https:\/\/[^\s<)]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(\/(?:dashboard|hailmap|storms|watchlist|leads|alert-settings|integrations|settings|affiliate|upgrade|help|register|sample-report|hail-maps|alerts|login)?(?:#[a-z-]+)?)(?=[\s).,]|$)/g, function (m, pre, p) { return p === '/' ? m : pre + '<a href="' + p + '">' + p + '</a>'; });
  }

  // ── Chat ───────────────────────────────────────────────────────────────────
  var history = [];
  try { history = JSON.parse(sessionStorage.getItem(STORE) || '[]'); } catch (e) { history = []; }
  function save() { try { sessionStorage.setItem(STORE, JSON.stringify(history.slice(-20))); } catch (e) {} }

  var fab = document.createElement('button');
  fab.className = 'scp-fab'; fab.setAttribute('aria-label', 'Ask the StormCheck Pro assistant');
  fab.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
  var panel = document.createElement('div');
  panel.className = 'scp-chat'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Help assistant');
  panel.innerHTML =
    '<header><div><b>StormCheck Pro assistant</b><small>' + (PUBLIC ? 'Questions about StormCheck Pro? Ask away' : 'Ask how to use any feature') + '</small></div><button type="button" aria-label="Close" data-close>&times;</button></header>' +
    '<div class="scp-log" data-log aria-live="polite"></div>' +
    '<form class="scp-form" data-form><label for="scpInput" style="position:absolute;left:-9999px">Your question</label><textarea id="scpInput" placeholder="Ask a question…" rows="1"></textarea><button type="submit">Send</button></form>';

  function render() {
    var log = panel.querySelector('[data-log]');
    var html = '<div class="scp-msg bot">' + (PUBLIC
      ? "Hi! I can answer questions about StormCheck Pro: what's in a report, pricing, where the data comes from, and how it works with your CRM."
      : 'Hi! I can help with lookups, reports, the hail map, lead lists, Portfolio, alerts and CRM integrations. What do you need?') + '</div>';
    var SUGG = PUBLIC
      ? ['How much does it cost?', 'Does it work with JobNimbus or AccuLynx?', 'Where does the data come from?', 'How can I get leads after a storm?']
      : ['How do I find the date of loss?', 'How do I make a lead list after a storm?', 'What does Verified mean?', 'How do I connect JobNimbus?'];
    if (!history.length) {
      html += '<div class="scp-sugg">' + SUGG.map(function (q) { return '<button type="button" data-q="' + esc(q) + '">' + esc(q) + '</button>'; }).join('') + '</div>';
    }
    html += history.map(function (m) { return '<div class="scp-msg ' + (m.role === 'user' ? 'user' : 'bot') + '">' + (m.role === 'user' ? esc(m.content) : linkify(m.content)) + '</div>'; }).join('');
    log.innerHTML = html;
    log.querySelectorAll('[data-q]').forEach(function (b) { b.addEventListener('click', function () { ask(b.getAttribute('data-q')); }); });
    log.scrollTop = log.scrollHeight;
  }

  var busy = false;
  function ask(q) {
    q = String(q || '').trim();
    if (!q || busy) return;
    busy = true;
    history.push({ role: 'user', content: q }); save(); render();
    var log = panel.querySelector('[data-log]');
    var typing = document.createElement('div'); typing.className = 'scp-typing'; typing.textContent = 'Thinking…'; log.appendChild(typing); log.scrollTop = log.scrollHeight;
    var btn = panel.querySelector('[data-form] button'); btn.disabled = true;
    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: history.slice(-12) }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { history.push({ role: 'assistant', content: x.ok ? x.j.reply : (x.j.error || 'Sorry, something went wrong. Try again.') }); })
      .catch(function () { history.push({ role: 'assistant', content: 'Connection problem. Please try again.' }); })
      .then(function () { busy = false; btn.disabled = false; save(); render(); panel.querySelector('textarea').focus(); });
  }

  panel.querySelector('[data-form]').addEventListener('submit', function (e) {
    e.preventDefault(); var t = panel.querySelector('textarea'); var v = t.value; t.value = ''; ask(v);
  });
  panel.querySelector('textarea').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); panel.querySelector('[data-form]').requestSubmit(); }
  });
  function toggle(open) {
    var o = open == null ? !panel.classList.contains('open') : open;
    panel.classList.toggle('open', o);
    fab.setAttribute('aria-expanded', String(o));
    if (o) { render(); setTimeout(function () { panel.querySelector('textarea').focus(); }, 50); }
  }
  fab.addEventListener('click', function () { toggle(); });
  panel.querySelector('[data-close]').addEventListener('click', function () { toggle(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && panel.classList.contains('open')) toggle(false); });
  window.openAssistant = function (q) { toggle(true); if (q) ask(q); };

  // ── What's new ─────────────────────────────────────────────────────────────
  function whatsNew() {
    if (/^\/(onboarding|report\/print)/.test(location.pathname)) return;
    fetch('/api/help').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d || !d.release || d.seenRelease === d.release.id) return;
      var first = !d.seenRelease;
      var bg = document.createElement('div'); bg.className = 'scp-modal-bg';
      bg.innerHTML = '<div class="scp-modal" role="dialog" aria-modal="true" aria-labelledby="scpNewTitle">' +
        '<div class="top"><h2 id="scpNewTitle">' + (first ? 'Welcome to StormCheck Pro' : esc(d.release.title)) + '</h2><p>' + (first ? "Here's what you can do. You can find this any time on the Help tab." : "Here's what we've added. Details are on the Help tab.") + '</p></div>' +
        '<div class="items">' + d.release.items.map(function (i, n) {
          return '<div class="it"><span class="n">' + (n + 1) + '</span><div><b>' + esc(i.title) + '</b> <a href="' + esc(i.link) + '">Open</a><p>' + esc(i.text) + '</p></div></div>';
        }).join('') + '</div>' +
        '<div class="acts"><a href="/help">See the full guide</a><button type="button" data-ok>Got it</button></div></div>';
      document.body.appendChild(bg);
      function done() {
        fetch('/api/me/seen-release', { method: 'POST' }).catch(function () {});
        bg.remove();
      }
      bg.querySelector('[data-ok]').addEventListener('click', done);
      bg.querySelectorAll('.items a, .acts a').forEach(function (a) { a.addEventListener('click', done); });
      bg.addEventListener('click', function (e) { if (e.target === bg) done(); });
      document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { done(); document.removeEventListener('keydown', onEsc); } });
      bg.querySelector('[data-ok]').focus();
    }).catch(function () {});
  }

  function start() {
    document.body.appendChild(panel);
    document.body.appendChild(fab);
    if (!PUBLIC) whatsNew();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
