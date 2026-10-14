// Minimal tolerant XML reader (no dependency): enough for the Safety Gate weekly reports and the ECB reference rates. Not a validating parser.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m));

/** @returns {{ name: string, attrs: object, children: object[], text: string }} the root element */
export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [], text: '' }; const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop(); }
    else if (m[3]) {
      const attrs = {}; for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3] ?? '');
      const el = { name: m[3].replace(/^.*:/, ''), attrs, children: [], text: '' }; top.children.push(el); if (m[5] !== '/') stack.push(el);
    } else if (m[6] !== undefined && !/^<[!?]/.test(m[0])) top.text += decode(m[6]);
  }
  return root;
}
export const textOf = (el) => (el ? el.text.trim() : '');
export const child = (el, name) => el?.children.find((c) => c.name === name) ?? null;
export function* walk(el) { yield el; for (const c of el.children) yield* walk(c); }
export const isNil = (el) => el?.attrs && Object.entries(el.attrs).some(([k, v]) => /nil$/.test(k) && v === 'true');
