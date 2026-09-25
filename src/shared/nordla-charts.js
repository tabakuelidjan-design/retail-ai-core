'use strict';
// Nordla Chart System v1.0 - the ONE implementation of the approved chart components, shared by every Nordla
// module (Finance, Analytics Premium, ...). Visual spec = the approved "Nordla Visual System - Chart System"
// board; it is locked: do not restyle a chart per page, and never recolour a legacy chart and call it Nordla.
//
// Components (only the ones a real page needs are built - add the others here, not in a page):
//   head(opts)            KPI / chart header: title, large value, real delta, "vs période précédente"
//   sparkline(values)     01 KPI Sparkline: thin navy line, very subtle area, small emphasized endpoint
//   trendLine(points)     02 Trend Line: axes + fine grid, navy line, subtle area, terracotta final point
//   comparison(groups)    07 Comparison: paired bars (soft gray = previous, navy = current), legend, grid
//   donut(items)          05 Donut Breakdown: thick ring, total in the centre, legend at right
//   waterfall(steps)      08 Waterfall: navy totals, green/red real contributors, value labels
//   contributionBars(items) 03 Contribution Bars: signed real contributions around a zero axis (green +, red -)
//   dataQuality(opts)     09 Data Quality: ring of a REAL measured coverage ratio + caption
// DATA RULE: these functions only draw the numbers they are handed. They never interpolate, smooth,
// extrapolate or invent a point; callers decide when data is insufficient (see insufficient()).
// All text (titles, labels, legends) is passed in by the caller so each module keeps its own translation.
// Colours come from the shared tokens in nordla-tokens.css; geometry is measured from the container so text
// stays a constant, readable size on every screen (charts re-draw on resize).
window.NordlaCharts = (function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, kids) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
    for (const k of kids || []) e.appendChild(k);
    return e;
  };
  const txt = (attrs, s) => { const e = el('text', attrs); e.textContent = s; return e; };
  const html = (tag, cls, ...kids) => {
    const e = document.createElement(tag); if (cls) e.className = cls;
    for (const k of kids.flat()) if (k != null) e.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
    return e;
  };
  let uid = 0;

  /** Redraws `draw(width)` into a block whenever its measured width changes. */
  function responsive(cls, draw) {
    const box = html('div', 'nc-chart ' + cls);
    let w = 0;
    const render = () => { const nw = Math.floor(box.clientWidth); if (!nw || nw === w) return; w = nw; box.replaceChildren(draw(nw)); };
    if (typeof ResizeObserver === 'function') new ResizeObserver(render).observe(box);
    else window.addEventListener('resize', render);
    // Belt and braces: ResizeObserver does not fire while the tab is hidden, so also try once the node is attached.
    setTimeout(render, 30); setTimeout(render, 400);
    return box;
  }

  /** "Nice" axis ticks covering [lo, hi] (lo <= 0 <= hi). */
  function ticks(lo, hi, n) {
    const span = Math.max(1, hi - lo);
    const raw = span / n; const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const out = [];
    for (let v = Math.floor(lo / step) * step; v <= Math.ceil(hi / step) * step + step / 1e6; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }
  const tickWidth = (labels) => Math.ceil(Math.max(...labels.map((s) => s.length)) * 6.4) + 10;
  // Show every k-th x label so they never collide.
  const labelEvery = (n, slotW, longest) => Math.max(1, Math.ceil((longest * 6.4 + 10) / slotW));

  function head({ title, value, delta, good, vs, small }) {
    const d = delta == null ? null : html('span', 'nc-delta ' + (good === false ? 'neg' : good === true ? 'pos' : ''), (delta >= 0 ? '↑ +' : '↓ ') + String(Math.abs(delta)).replace('.', ',') + ' %');
    return html('div', 'nc-head' + (small ? ' small' : ''),
      title ? html('div', 'nc-title', title) : null,
      html('div', 'nc-valuerow', html('span', 'nc-value', value), d ? html('span', 'nc-deltacol', d, vs ? html('span', 'nc-vs', vs) : null) : null));
  }

  function insufficient(title, sub) {
    return html('div', 'nc-empty', html('strong', null, title), sub ? html('span', null, sub) : null);
  }

  // ---- 01 KPI Sparkline ----
  function sparkline(values, opts = {}) {
    const H = opts.height || 44;
    return responsive('nc-spark', (W) => {
      const n = values.length; const pad = 4; const lo = Math.min(0, ...values); const hi = Math.max(...values, lo + 1);
      const x = (i) => pad + (n === 1 ? (W - 2 * pad) / 2 : i * (W - 2 * pad - 2) / (n - 1));
      const y = (v) => pad + (H - 2 * pad) * (1 - (v - lo) / (hi - lo));
      const pts = values.map((v, i) => [x(i), y(v)]);
      const id = 'ncg' + (++uid);
      const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      const last = pts[pts.length - 1];
      return el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-hidden': 'true' }, [
        el('defs', {}, [el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, [el('stop', { class: 'nc-stop-top', offset: '0%' }), el('stop', { class: 'nc-stop-bottom', offset: '100%' })])]),
        el('path', { class: 'nc-area', d: `${line} L${last[0].toFixed(1)} ${H} L${pts[0][0].toFixed(1)} ${H} Z`, fill: `url(#${id})` }),
        el('path', { class: 'nc-line thin', d: line }),
        el('circle', { class: 'nc-end navy', cx: last[0], cy: last[1], r: 3.2 })]);
    });
  }

  // ---- 02 Trend Line ----
  // points: [{label, value}], format(v) -> compact axis/value text
  function trendLine(points, opts = {}) {
    const H = opts.height || 190; const fmt = opts.format || String;
    return responsive('nc-trend', (W) => {
      const vals = points.map((p) => p.value); const lo = Math.min(0, ...vals); const hi = Math.max(0, ...vals);
      const tk = ticks(lo, hi, 4); const top = tk[tk.length - 1]; const bot = tk[0];
      const padL = tickWidth(tk.map(fmt)) + 4; const padR = 14; const padT = 10; const padB = 24;
      const n = points.length; const innerW = W - padL - padR;
      const x = (i) => padL + (n === 1 ? innerW / 2 : (i * (innerW - 8)) / (n - 1)) + (n === 1 ? 0 : 4);
      const y = (v) => padT + (H - padT - padB) * (1 - (v - bot) / (top - bot || 1));
      const kids = [];
      for (const t of tk) {
        kids.push(el('line', { class: 'nc-grid', x1: padL, x2: W - padR, y1: y(t), y2: y(t) }));
        kids.push(txt({ class: 'nc-axis', x: padL - 8, y: y(t) + 4, 'text-anchor': 'end' }, fmt(t)));
      }
      const every = labelEvery(n, innerW / n, Math.max(...points.map((p) => p.label.length)));
      points.forEach((p, i) => { if (i % every === 0 || i === n - 1 && (n - 1) % every === 0) kids.push(txt({ class: 'nc-axis', x: x(i), y: H - 6, 'text-anchor': 'middle' }, p.label)); });
      const pts = points.map((p, i) => [x(i), y(p.value)]);
      const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
      const id = 'ncg' + (++uid); const last = pts[pts.length - 1]; const base = y(Math.max(bot, 0));
      kids.unshift(el('defs', {}, [el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, [el('stop', { class: 'nc-stop-top', offset: '0%' }), el('stop', { class: 'nc-stop-bottom', offset: '100%' })])]));
      kids.push(el('path', { class: 'nc-area', d: `${line} L${last[0].toFixed(1)} ${base} L${pts[0][0].toFixed(1)} ${base} Z`, fill: `url(#${id})` }));
      kids.push(el('path', { class: 'nc-line', d: line }));
      pts.forEach(([px, py], i) => kids.push(el('circle', { class: i === n - 1 ? 'nc-end ring' : 'nc-hit', cx: px, cy: py, r: i === n - 1 ? 4.6 : 7 }, [el('title', {}, [document.createTextNode(`${points[i].label}: ${fmt(points[i].value)}`)])])));
      return el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || '' }, kids);
    });
  }


  // ---- 02 Trend Line, several series (one line per series, same colour for the same series everywhere) ----
  // seriesList: [{ name, cls('c1'..'c5'), values: number[] }] sharing the same `labels`; no smoothing, no invented point.
  function trendLines(seriesList, labels, opts = {}) {
    const H = opts.height || 220; const fmt = opts.format || String;
    const legend = html('div', 'nc-legend', seriesList.map((s) => html('span', null, html('i', 'nc-dot ' + s.cls), s.name)));
    const chart = responsive('nc-trend', (W) => {
      const all = seriesList.flatMap((s) => s.values); const lo = Math.min(0, ...all); const hi = Math.max(0, ...all);
      const tk = ticks(lo, hi > lo ? hi : lo + 1, 4); const top = tk[tk.length - 1]; const bot = tk[0];
      const padL = tickWidth(tk.map(fmt)) + 4; const padR = 14; const padT = 10; const padB = 24;
      const n = labels.length; const innerW = W - padL - padR;
      const x = (i) => padL + (n === 1 ? innerW / 2 : (i * (innerW - 8)) / (n - 1)) + (n === 1 ? 0 : 4);
      const y = (v) => padT + (H - padT - padB) * (1 - (v - bot) / (top - bot || 1));
      const kids = [];
      for (const t of tk) { kids.push(el('line', { class: 'nc-grid', x1: padL, x2: W - padR, y1: y(t), y2: y(t) })); kids.push(txt({ class: 'nc-axis', x: padL - 8, y: y(t) + 4, 'text-anchor': 'end' }, fmt(t))); }
      const every = labelEvery(n, innerW / n, Math.max(...labels.map((l) => l.length)));
      labels.forEach((l, i) => { if (i % every === 0) kids.push(txt({ class: 'nc-axis', x: x(i), y: H - 6, 'text-anchor': 'middle' }, l)); });
      seriesList.forEach((s) => {
        const pts = s.values.map((v, i) => [x(i), y(v)]);
        kids.push(el('path', { class: 'nc-line ml ' + s.cls, d: pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ') }));
        const last = pts[pts.length - 1];
        kids.push(el('circle', { class: 'nc-end s-' + s.cls, cx: last[0], cy: last[1], r: 3.6 }));
        pts.forEach(([px, py], i) => kids.push(el('circle', { class: 'nc-hit', cx: px, cy: py, r: 7 }, [el('title', {}, [document.createTextNode(`${s.name} · ${labels[i]}: ${fmt(s.values[i])}`)])])));
      });
      return el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || '' }, kids);
    });
    return html('div', 'nc-wrap', legend, chart);
  }

  // ---- 07 Comparison ----  groups: [{label, a, b}] ; series: [{name, cls}] (cls: 'prev' soft gray | 'cur' navy | 'alt' slate)
  function comparison(groups, series, opts = {}) {
    const H = opts.height || 200; const fmt = opts.format || String;
    const legend = html('div', 'nc-legend', series.map((s) => html('span', null, html('i', 'nc-dot ' + s.cls), s.name)));
    const chart = responsive('nc-cmp', (W) => {
      const mx = Math.max(...groups.flatMap((g) => [g.a, g.b])); const hi = mx > 0 ? mx : 1; const tk = ticks(0, hi, 4); const top = tk[tk.length - 1];
      const padL = tickWidth(tk.map(fmt)) + 4; const padR = 8; const padT = 10; const padB = 24;
      const n = groups.length; const slot = (W - padL - padR) / n; const bw = Math.max(4, Math.min(12, slot * 0.28));
      const y = (v) => padT + (H - padT - padB) * (1 - v / top);
      const kids = [];
      for (const t of tk) { kids.push(el('line', { class: 'nc-grid', x1: padL, x2: W - padR, y1: y(t), y2: y(t) })); kids.push(txt({ class: 'nc-axis', x: padL - 8, y: y(t) + 4, 'text-anchor': 'end' }, fmt(t))); }
      const every = labelEvery(n, slot, Math.max(...groups.map((g) => g.label.length)));
      groups.forEach((g, i) => {
        const cx = padL + slot * i + slot / 2;
        [[g.a, -bw - 1.5, series[0].cls], [g.b, 1.5, series[1].cls]].forEach(([v, dx, cls]) => {
          const h2 = Math.max(0, y(0) - y(v));
          kids.push(el('rect', { class: 'nc-bar ' + cls, x: cx + dx, y: y(v), width: bw, height: h2, rx: 2 }, [el('title', {}, [document.createTextNode(`${g.title || g.label}: ${fmt(v)}`)])]));
        });
        if (i % every === 0) kids.push(txt({ class: 'nc-axis', x: cx, y: H - 6, 'text-anchor': 'middle' }, g.label));
      });
      return el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || '' }, kids);
    });
    return html('div', 'nc-wrap', legend, chart);
  }

  // ---- 05 Donut Breakdown ----  items: [{name, pct(0-100)}]
  function donut(items, { totalValue, totalLabel, size = 150 }) {
    const R = size * 0.35; const SW = size * 0.17; const C = size / 2; const circ = 2 * Math.PI * R;
    const dflt = ['c1', 'c2', 'c3', 'c4', 'c5']; const cls = items.map((it, i) => it.cls || dflt[i % dflt.length]);
    let acc = 0;
    const arcs = items.map((it, i) => {
      const f = it.pct / 100; const gap = items.length > 1 ? 1.6 : 0;
      const e = el('circle', { class: 'nc-arc ' + cls[i], cx: C, cy: C, r: R, 'stroke-width': SW, 'stroke-dasharray': `${Math.max(0, f * circ - gap)} ${circ}`, 'stroke-dashoffset': -acc * circ, transform: `rotate(-90 ${C} ${C})` });
      acc += f; return e;
    });
    const svg = el('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-hidden': 'true' }, [el('circle', { class: 'nc-arc track', cx: C, cy: C, r: R, 'stroke-width': SW }), ...arcs]);
    const centre = html('div', 'nc-donut-centre', html('strong', null, totalValue), html('span', null, totalLabel));
    const legend = html('div', 'nc-donut-legend', items.map((it, i) => html('div', 'nc-lrow', html('i', 'nc-dot ' + cls[i]), html('span', 'nc-lname', it.name), html('span', 'nc-lpct', String(it.pct).replace('.', ',') + ' %'), it.value != null ? html('span', 'nc-lval', it.value) : null)));
    const ring = html('div', 'nc-donut-ring'); ring.style.width = ring.style.height = size + 'px';
    ring.appendChild(svg); ring.appendChild(centre);
    return html('div', 'nc-donut', ring, legend);
  }

  // ---- 08 Waterfall ----  steps: [{label, value, total?}] ; totals are absolute levels, others are signed changes
  function waterfall(steps, opts = {}) {
    const H = opts.height || 220; const fmt = opts.format || String; const sfmt = opts.signedFormat || fmt;
    return responsive('nc-wf', (W) => {
      let level = 0; const bars = steps.map((s) => {
        if (s.total) { level = s.value; return { ...s, from: 0, to: s.value }; }
        const from = level; level += s.value; return { ...s, from, to: level };
      });
      const lo = Math.min(0, ...bars.flatMap((b) => [b.from, b.to])); const hi = Math.max(1, ...bars.flatMap((b) => [b.from, b.to]));
      const padL = 6; const padR = 6; const padT = 22; const padB = 26; const n = bars.length;
      const slot = (W - padL - padR) / n; const bw = Math.max(8, Math.min(34, slot * 0.56));
      const y = (v) => padT + (H - padT - padB) * (1 - (v - lo) / (hi - lo));
      const kids = [el('line', { class: 'nc-grid', x1: padL, x2: W - padR, y1: y(0), y2: y(0) })];
      // Label placement without collisions: totals first (always kept), then the others only where they do not overlap
      // a label that is already placed. Nothing is dropped from the data, only labels that would collide are omitted.
      const axisPlaced = []; const valPlaced = [];
      const fits = (list, x0, x1, y) => list.every((q) => x1 + 4 < q.x0 || x0 > q.x1 + 4 || Math.abs(y - q.y) > 13);
      const order = bars.map((b, i) => i).sort((i, j) => (bars[j].total ? 1 : 0) - (bars[i].total ? 1 : 0) || i - j);
      const shownAxis = new Set(); const shownVal = new Set();
      const meta = bars.map((b, i) => {
        const cx = padL + slot * i + slot / 2; const y1 = y(Math.max(b.from, b.to));
        const t = b.total ? fmt(b.value) : (b.value > 0 ? '+' : '') + sfmt(b.value);
        const lab = slot < 34 && b.short ? b.short : b.label; return { cx, y1, t, lab, tw: t.length * 6.6, lw: lab.length * 6.2 };
      });
      order.forEach((i) => {
        const m = meta[i]; const b = bars[i];
        const ax0 = Math.max(0, Math.min(m.cx - m.lw / 2, W - m.lw)); if (fits(axisPlaced, ax0, ax0 + m.lw, 0)) { axisPlaced.push({ x0: ax0, x1: ax0 + m.lw, y: 0 }); shownAxis.add(i); }
        const vx0 = Math.max(0, Math.min(m.cx - m.tw / 2, W - m.tw)); if (b.total || fits(valPlaced, vx0, vx0 + m.tw, m.y1)) { valPlaced.push({ x0: vx0, x1: vx0 + m.tw, y: m.y1 }); shownVal.add(i); }
      });
      bars.forEach((b, i) => {
        const m = meta[i]; const cx = m.cx; const y1 = m.y1; const y2 = y(Math.min(b.from, b.to));
        const cls = b.total ? 'total' : b.value >= 0 ? 'pos' : 'neg';
        kids.push(el('rect', { class: 'nc-bar ' + cls, x: cx - bw / 2, y: y1, width: bw, height: Math.max(1.5, y2 - y1), rx: 2 }, [el('title', {}, [document.createTextNode(`${b.label}: ${b.total ? fmt(b.value) : sfmt(b.value)}`)])]));
        if (i < n - 1) kids.push(el('line', { class: 'nc-conn', x1: cx + bw / 2, x2: cx + slot - bw / 2, y1: y(b.to), y2: y(b.to) }));
        if (shownVal.has(i)) { const anchor = m.cx - m.tw / 2 < 0 ? 'start' : m.cx + m.tw / 2 > W ? 'end' : 'middle'; kids.push(txt({ class: 'nc-vlabel ' + cls, x: anchor === 'start' ? 0 : anchor === 'end' ? W : cx, y: y1 - 5, 'text-anchor': anchor }, m.t)); }
        if (shownAxis.has(i)) { const anchor = m.cx - m.lw / 2 < 0 ? 'start' : m.cx + m.lw / 2 > W ? 'end' : 'middle'; kids.push(txt({ class: 'nc-axis', x: anchor === 'start' ? 0 : anchor === 'end' ? W : cx, y: H - 8, 'text-anchor': anchor }, m.lab)); }
      });
      return el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': opts.label || '' }, kids);
    });
  }


  // ---- 03 Contribution Bars ----  items: [{label, value}] signed real contributions; green right of the axis, red left.
  function contributionBars(items, opts = {}) {
    const fmt = opts.format || String;
    const pos = Math.max(0, ...items.map((i) => i.value)); const neg = Math.max(0, ...items.map((i) => -i.value));
    const span = pos + neg || 1; const zero = (neg / span) * 100;
    return html('div', 'nc-cb', items.map((it) => {
      const w = (Math.abs(it.value) / span) * 100;
      const bar = html('i', 'nc-cb-bar ' + (it.value >= 0 ? 'pos' : 'neg'));
      bar.style.width = Math.max(w, 1.5) + '%'; bar.style[it.value >= 0 ? 'left' : 'right'] = (it.value >= 0 ? zero : 100 - zero) + '%';
      const track = html('div', 'nc-cb-track', html('u', 'nc-cb-axis'), bar); track.querySelector('u').style.left = zero + '%';
      return html('div', 'nc-cb-row', html('span', 'nc-cb-label', it.label), track, html('span', 'nc-cb-value ' + (it.value >= 0 ? 'pos' : 'neg'), (it.value > 0 ? '+' : '') + fmt(it.value)));
    }));
  }

  // ---- 09 Data Quality ----  pct 0-100 of a REAL measured coverage; only ever handed a real ratio
  function dataQuality({ pct, label, size = 84 }) {
    const R = size * 0.4; const SW = size * 0.11; const C = size / 2; const circ = 2 * Math.PI * R; const f = Math.min(100, Math.max(0, pct)) / 100;
    const svg = el('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' }, [
      el('circle', { class: 'nc-arc track', cx: C, cy: C, r: R, 'stroke-width': SW }),
      el('circle', { class: 'nc-arc c1', cx: C, cy: C, r: R, 'stroke-width': SW, 'stroke-linecap': 'round', 'stroke-dasharray': `${f * circ} ${circ}`, transform: `rotate(-90 ${C} ${C})` })]);
    const ring = html('div', 'nc-donut-ring', svg, html('div', 'nc-donut-centre', html('strong', null, String(Math.round(pct)) + ' %')));
    ring.style.width = ring.style.height = size + 'px';
    return html('div', 'nc-dq', ring, html('span', 'nc-dq-label', label));
  }

  return { head, insufficient, sparkline, trendLine, trendLines, comparison, donut, waterfall, contributionBars, dataQuality };
})();
