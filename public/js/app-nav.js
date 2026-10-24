/* One navigation bar for every logged-in page: every tab is always visible and
 * clickable, the current page is highlighted, and on phones the tabs scroll
 * sideways instead of hiding behind a menu. */
(function () {
  var TABS = [
    ['/dashboard', 'Lookup'],
    ['/hailmap', 'Hail Map'],
    ['/storms', 'Storms'],
    ['/watchlist', 'Portfolio'],
    ['/leads', 'Lead Lists'],
    ['/alert-settings', 'Alerts'],
    ['/integrations', 'Integrations'],
    ['/settings', 'Settings'],
    ['/affiliate', 'Affiliate'],
    ['/help', 'Help'],
  ];

  var css = document.createElement('style');
  css.textContent =
    '.app-nav{background:#172235;color:#fff;position:sticky;top:0;z-index:1000;box-shadow:0 2px 8px rgba(0,0,0,.25);display:flex;align-items:center;gap:16px;padding:0 16px;min-height:60px;flex-wrap:wrap}' +
    '.app-nav .brand{font-weight:800;font-size:1.15em;color:#fff;text-decoration:none;white-space:nowrap}' +
    '.app-nav .brand span{color:#F2A93B}' +
    '.app-nav .tabs{display:flex;align-items:center;gap:2px;margin-left:auto;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;max-width:100%}' +
    '.app-nav .tabs::-webkit-scrollbar{display:none}' +
    '.app-nav .tabs a{color:rgba(255,255,255,.82);text-decoration:none;font-size:.92em;font-weight:600;padding:10px 12px;border-radius:8px;white-space:nowrap;min-height:44px;display:inline-flex;align-items:center}' +
    '.app-nav .tabs a:hover{color:#fff;background:rgba(255,255,255,.08)}' +
    '.app-nav .tabs a.active{color:#172235;background:#F2A93B}' +
    '.app-nav .tabs a.signout{border:1.5px solid rgba(255,255,255,.35);margin-left:6px}' +
    '@media (max-width:900px){.app-nav{padding:8px 12px 0;gap:4px}.app-nav .tabs{margin-left:0;width:100%;padding-bottom:6px}}';
  document.head.appendChild(css);

  function render(isAdmin) {
    var path = location.pathname.replace(/\/$/, '') || '/dashboard';
    var tabs = TABS.slice();
    if (isAdmin) tabs.push(['/admin', 'Admin']);
    var html = '<a class="brand" href="/dashboard">Storm<span>Check</span> Pro</a><div class="tabs" role="navigation" aria-label="App">' +
      tabs.map(function (t) {
        var active = path === t[0] || (t[0] === '/dashboard' && path === '/report/print');
        return '<a href="' + t[0] + '"' + (active ? ' class="active" aria-current="page"' : '') + '>' + t[1] + '</a>';
      }).join('') +
      '<a href="#" class="signout" id="navSignOut">Sign Out</a></div>';
    var nav = document.getElementById('appNav');
    if (!nav) return;
    nav.className = 'app-nav';
    nav.innerHTML = html;
    var act = nav.querySelector('a.active');
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'center' });
    document.getElementById('navSignOut').addEventListener('click', function (e) {
      e.preventDefault();
      fetch('/api/auth/logout', { method: 'POST' }).finally(function () { location = '/login'; });
    });
  }

  function start() {
    render(false);
    fetch('/api/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (d && d.user && d.user.role === 'admin') render(true);
    }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // Help assistant + "What's new" popup on every logged-in page.
  var sc = document.createElement('script'); sc.src = '/js/assistant.js'; sc.defer = true;
  document.head.appendChild(sc);
})();
