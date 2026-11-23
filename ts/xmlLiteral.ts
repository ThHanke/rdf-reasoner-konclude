/**
 * Canonical form of an rdf:XMLLiteral lexical value (a well-balanced XML fragment), so two literals that denote the same XML
 * value get the same string. The kernel has no XML parser (the QDomDocument shim of the WebAssembly port always fails) and
 * compares the lexical strings, so the canonicalization happens before the ontology reaches it (ts/inputNormalize.ts).
 *
 * Rules (a subset of Canonical XML 1.0 without namespace-aware exclusivity): line endings become LF; comments are dropped;
 * empty elements are written as start and end tag; attributes are sorted (namespace declarations first) and written with
 * double quotes, their values normalized and escaped; text is entity-decoded and re-escaped; whitespace text nodes are kept
 * (they are significant in XML). Returns null when the fragment is not well-formed (the literal is then left unchanged).
 */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string | null {
  let ok = true;
  const out = s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    if (e in ENTITIES) return ENTITIES[e]!;
    ok = false;
    return m;
  });
  return ok ? out : null;
}
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;");
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\t/g, "&#x9;").replace(/\n/g, "&#xA;").replace(/\r/g, "&#xD;");

interface Attr { name: string; value: string }

/** Canonical form, or null when `lexical` is not a well-balanced XML fragment this canonicalizer understands. */
export function canonicalizeXmlLiteral(lexical: string): string | null {
  const src = lexical.replace(/\r\n?/g, "\n");
  let i = 0;
  const out: string[] = [];
  const stack: string[] = [];
  while (i < src.length) {
    if (src[i] !== "<") {
      const j = src.indexOf("<", i);
      const raw = src.slice(i, j < 0 ? src.length : j);
      const text = decode(raw);
      if (text === null) return null;
      out.push(escText(text));
      i = j < 0 ? src.length : j;
      continue;
    }
    if (src.startsWith("<!--", i)) {
      const j = src.indexOf("-->", i + 4);
      if (j < 0) return null;
      i = j + 3; // comments are not part of the canonical form
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const j = src.indexOf("]]>", i + 9);
      if (j < 0) return null;
      out.push(escText(src.slice(i + 9, j)));
      i = j + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const j = src.indexOf("?>", i + 2);
      if (j < 0) return null;
      const body = src.slice(i + 2, j);
      if (/^xml\s/i.test(body)) { i = j + 2; continue; } // XML declaration is dropped
      out.push(`<?${body.replace(/^(\S+)\s+/, "$1 ")}?>`);
      i = j + 2;
      continue;
    }
    if (src.startsWith("</", i)) {
      const m = /^<\/\s*([^\s>]+)\s*>/.exec(src.slice(i));
      if (!m || stack.pop() !== m[1]) return null;
      out.push(`</${m[1]}>`);
      i += m[0].length;
      continue;
    }
    const m = /^<([^\s/>]+)/.exec(src.slice(i));
    if (!m) return null;
    const name = m[1]!;
    i += m[0].length;
    const attrs: Attr[] = [];
    for (;;) {
      const ws = /^\s+/.exec(src.slice(i));
      if (ws) i += ws[0].length;
      if (src[i] === ">") { i++; stack.push(name); out.push(open(name, attrs)); break; }
      if (src.startsWith("/>", i)) { i += 2; out.push(open(name, attrs), `</${name}>`); break; }
      const a = /^([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(src.slice(i));
      if (!a) return null;
      const value = decode((a[2] ?? a[3] ?? "").replace(/[\t\n\r]/g, " "));
      if (value === null) return null;
      attrs.push({ name: a[1]!, value });
      i += a[0].length;
    }
  }
  return stack.length === 0 ? out.join("") : null;
}

function open(name: string, attrs: Attr[]): string {
  const ns = attrs.filter((a) => a.name === "xmlns" || a.name.startsWith("xmlns:")).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  const rest = attrs.filter((a) => !(a.name === "xmlns" || a.name.startsWith("xmlns:"))).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  return `<${name}${[...ns, ...rest].map((a) => ` ${a.name}="${escAttr(a.value)}"`).join("")}>`;
}
