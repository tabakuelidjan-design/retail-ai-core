// Finance inside the Nordla Core page (no iframe). This file is a plain script: tools/build-finance-embed.mjs puts it at the top of
// finance-embed.js, so it runs in the same scope as the Finance UI scripts. It gives those scripts their own document, location,
// history and window, so the Finance UI never touches the Core document or its address:
//   * document  -> the Finance root inside a Shadow DOM (its styles are isolated from Core's, and nothing leaks out);
//   * location  -> an internal hash (#/todo, #/purchases…): the Core address bar never changes;
//   * history   -> replaceState/pushState update the internal hash only;
//   * window    -> hashchange is internal; other keys go to the real window, except values the Finance UI sets itself (kept local).
// Anchors with a "#…" target are handled here (no browser navigation). No eval, no new Function, no inline script.

function createFinanceEnv(root, options) {
  const realDoc = document;
  const realWin = window;
  const hashListeners = new Set();
  const local = Object.create(null); // values the Finance scripts set on window (e.g. NordlaIcon): they stay inside the module
  const loc = {
    pathname: '/',
    search: '',
    get href() { return `${realWin.location.origin}/${this.hash}`; },
    _hash: '',
    get hash() { return this._hash; },
    set hash(value) {
      const text = String(value ?? '');
      const next = text === '' || text === '#' ? '' : (text.startsWith('#') ? text : `#${text}`);
      if (next === this._hash) return;
      this._hash = next;
      for (const listener of [...hashListeners]) listener({ type: 'hashchange', newURL: `${realWin.location.origin}/${next}` });
    },
    assign(url) { realWin.location.assign(url); },
    replace(url) { realWin.location.replace(url); },
  };
  const history = {
    replaceState(_state, _title, url) { const i = String(url ?? '').indexOf('#'); if (i >= 0) loc._hash = String(url).slice(i); },
    pushState(_state, _title, url) { const i = String(url ?? '').indexOf('#'); if (i >= 0) loc._hash = String(url).slice(i); },
  };

  // The Finance root: a wrapper (what Finance calls document.body) holding #app (what the Finance app renders into).
  const root2 = root;
  if (!root2.getElementById('fin-embed-style')) {
    const style = realDoc.createElement('style');
    style.id = 'fin-embed-style';
    style.textContent = options.css;
    root2.appendChild(style);
  }
  let body = root2.getElementById('fin-body');
  if (!body) {
    body = realDoc.createElement('div');
    body.id = 'fin-body';
    body.className = 'fin-body';
    root2.appendChild(body);
  }
  if (!root2.getElementById('app')) {
    const app = realDoc.createElement('div');
    app.id = 'app';
    body.appendChild(app);
  }

  const doc = new Proxy({}, {
    get(_t, key) {
      switch (key) {
        case 'getElementById': return (id) => root2.getElementById(id);
        case 'querySelector': return (sel) => root2.querySelector(sel);
        case 'querySelectorAll': return (sel) => root2.querySelectorAll(sel);
        case 'getElementsByClassName': return (cls) => root2.querySelectorAll(`.${cls}`);
        case 'body': return body;
        case 'documentElement': return body;
        case 'readyState': return 'complete';
        case 'activeElement': return root2.activeElement ?? null;
        case 'addEventListener': return (t, f, o) => root2.addEventListener(t, f, o);
        case 'removeEventListener': return (t, f, o) => root2.removeEventListener(t, f, o);
        default: { const v = realDoc[key]; return typeof v === 'function' ? v.bind(realDoc) : v; }
      }
    },
  });

  const win = new Proxy({}, {
    get(_t, key) {
      if (key === 'location') return loc;
      if (key === 'history') return history;
      if (key === 'addEventListener') return (t, f, o) => { if (t === 'hashchange') hashListeners.add(f); else realWin.addEventListener(t, f, o); };
      if (key === 'removeEventListener') return (t, f, o) => { if (t === 'hashchange') hashListeners.delete(f); else realWin.removeEventListener(t, f, o); };
      if (key in local) return local[key];
      const v = realWin[key];
      return typeof v === 'function' ? v.bind(realWin) : v;
    },
    set(_t, key, value) { local[key] = value; return true; },
  });

  // Anchors "#/…" are internal: the browser must not change the Core address.
  root2.addEventListener('click', (event) => {
    const a = event.target && event.target.closest ? event.target.closest('a[href^="#"]') : null;
    if (!a) return;
    event.preventDefault();
    loc.hash = a.getAttribute('href');
  });

  return { document: doc, location: loc, history, window: win, apiBase: options.apiBase };
}
