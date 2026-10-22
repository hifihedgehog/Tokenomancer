// A tiny virtual DOM. Render functions return trees; patch() reuses the existing nodes in place,
// so focus, hover and a screen reader's position survive the once-a-second model updates, and only
// changed attributes and text are written. Strings always become text nodes (never markup), and
// `style` is applied through CSSOM because the CSP forbids style attributes.

export type Child = VNode | string | number | null | undefined | false | Child[];
export type Props = Record<string, any>;
export interface VNode { t: string; p: Props; c: Child[] }

interface El extends Element { _p?: Props; _k?: string; [k: string]: any }

const SVG = 'http://www.w3.org/2000/svg';
const isProps = (x: unknown): x is Props => !!x && typeof x === 'object' && !Array.isArray(x) && !('c' in x && 't' in x);

/** h('div.card.ph', props?, ...children): classes ride on the tag; props may be left out.
 *  Every <svg> is decoration or has a text twin, so it is hidden from screen readers. */
export function h(tag: string, a?: Props | Child, ...c: Child[]): VNode {
  let p: Props = {};
  if (isProps(a)) p = a;
  else if (a != null) c.unshift(a);
  const [t, ...cls] = tag.split('.');
  if (cls.length) p = { ...p, class: cls.join(' ') + (p.class ? ' ' + p.class : '') };
  if (t === 'svg') p = { 'aria-hidden': 'true', ...p };
  return { t, p, c };
}

const n1 = (v: number | string) => (typeof v === 'number' ? String(Math.round(v * 10) / 10) : v);
/** An SVG rect, its geometry to one decimal. */
export const rect = (cls: string | null, x: number | string, y: number | string, width: number | string, height: number | string, rx?: number) =>
  h('rect', { class: cls, x: n1(x), y: n1(y), width: n1(width), height: n1(height), rx });

function flat(c: Child[], out: (VNode | string)[] = []): (VNode | string)[] {
  for (const x of c) {
    if (x == null || x === false) continue;
    if (Array.isArray(x)) flat(x, out);
    else out.push(typeof x === 'number' ? String(x) : x);
  }
  return out;
}

export function patch(parent: Element, kids: Child[], svg = false): void {
  const list = flat(kids), nodes = parent.childNodes;
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
      if (key != null) for (let j = i + 1; j < nodes.length && !m; j++) {
        const x = nodes[j] as El;
        if (x._k === key && x.localName === v.t) m = x;
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
    else el.removeAttribute(k);
  }
  for (const k in p) {
    const v = p[k];
    if (k === 'key') continue;
    if (k.startsWith('on')) el[k] = v;
    else if (k === 'style') {
      const st = (el as unknown as HTMLElement).style;
      for (const s in v) if (st.getPropertyValue(s) !== v[s]) st.setProperty(s, v[s]);
    } else if (v !== o[k]) {
      if (v == null || v === false) el.removeAttribute(k);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  el._p = p;
}
