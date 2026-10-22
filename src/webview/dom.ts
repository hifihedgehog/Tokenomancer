// A tiny virtual DOM. Render functions return trees; patch() reuses the existing nodes in place,
// so focus, hover and a screen reader's position survive the once-a-second model updates, and only
// changed attributes and text are written. Strings always become text nodes (never markup), and
// `style` is applied through CSSOM because the CSP forbids style attributes.

export type Child = VNode | string | number | null | undefined | false | Child[];
export type Props = Record<string, any>;
export interface VNode { t: string; p: Props; c: Child[] }

interface El extends Element { _p?: Props; _k?: string; [k: string]: any }

const SVG = 'http://www.w3.org/2000/svg';

export function h(t: string, p?: Props | null, ...c: Child[]): VNode {
  return { t, p: p || {}, c };
}

function flat(c: Child[], out: (VNode | string)[] = []): (VNode | string)[] {
  for (const x of c) {
    if (x == null || x === false) continue;
    if (Array.isArray(x)) flat(x, out);
    else out.push(typeof x === 'number' ? String(x) : x);
  }
  return out;
}

export function patch(parent: Element, kids: Child[], svg = false): void {
  const list = flat(kids);
  const nodes = parent.childNodes;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    let n = nodes[i] as El | undefined;
    if (typeof v === 'string') {
      if (n && n.nodeType === 3) { if (n.nodeValue !== v) n.nodeValue = v; }
      else parent.insertBefore(document.createTextNode(v), n || null);
      continue;
    }
    const key = v.p.key, inSvg = svg || v.t === 'svg';
    if (!n || n.localName !== v.t || n._k !== key) {
      let m: El | undefined;
      if (key != null) for (let j = i + 1; j < nodes.length; j++) {
        const x = nodes[j] as El;
        if (x._k === key && x.localName === v.t) { m = x; break; }
      }
      if (!m) {
        m = (inSvg ? document.createElementNS(SVG, v.t) : document.createElement(v.t)) as El;
        m._k = key;
      }
      parent.insertBefore(m, n || null);
      n = m;
    }
    props(n, v.p);
    patch(n, v.c, inSvg);
  }
  while (nodes.length > list.length) parent.removeChild(parent.lastChild!);
}

function props(el: El, p: Props): void {
  const o = el._p || {};
  for (const k in o) {
    if (k in p || k === 'key') continue;
    if (k.startsWith('on')) el[k] = null;
    else if (k === 'style') el.removeAttribute('style');
    else el.removeAttribute(k);
  }
  for (const k in p) {
    const v = p[k];
    if (k === 'key') continue;
    if (k.startsWith('on')) { el[k] = v; continue; }
    if (k === 'style') {
      const st = (el as unknown as HTMLElement).style;
      for (const s in v) if (st.getPropertyValue(s) !== v[s]) st.setProperty(s, v[s]);
      continue;
    }
    if (v === o[k]) continue;
    if (v == null || v === false) el.removeAttribute(k);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  el._p = p;
}
