import { describe, expect, it } from "vitest";
import { canonicalizeXmlLiteral as c } from "../../ts/xmlLiteral.js";

describe("canonicalizeXmlLiteral", () => {
  it("makes the spellings of W3C miscellaneous-202 equal (self-closing vs end tag, attribute order and spacing)", () => {
    const a = `<br />\n<img src="vn.png" alt="Venn diagram" longdesc="vn.html" title="Venn"></img>`;
    const b = `<br \n></br>\n<img \nsrc="vn.png" title=\n"Venn" alt\n="Venn diagram" longdesc=\n"vn.html" />`;
    expect(c(a)).toBe(c(b));
    expect(c(a)).toBe(`<br></br>\n<img alt="Venn diagram" longdesc="vn.html" src="vn.png" title="Venn"></img>`);
  });

  it("keeps whitespace text nodes: a leading newline is a different value (W3C miscellaneous-203)", () => {
    const a = `\n<br />\n<img src="vn.png"></img>\n`;
    const b = `<br></br>\n<img src="vn.png" />\n`;
    expect(c(a)).not.toBe(c(b));
  });

  it("different content stays different", () => {
    expect(c(`<span xml:lang='en'>\n<b>Good!</b></span>`)).not.toBe(c(`<span xml:lang='en'>\n<b>Bad!</b></span>`));
  });

  it("normalizes quotes, entities, comments, line endings and namespace declaration order", () => {
    expect(c(`<a b='x&quot;y' xmlns:z="u" xmlns="d">t &amp; &#65;<!-- c --></a>`)).toBe(`<a xmlns="d" xmlns:z="u" b="x&quot;y">t &amp; A</a>`);
    expect(c("<a>x\r\ny</a>")).toBe("<a>x\ny</a>");
    expect(c(`<a b="1\n2"/>`)).toBe(`<a b="1 2"></a>`);
  });

  it("plain text and CDATA", () => {
    expect(c("just text")).toBe("just text");
    expect(c("<a><![CDATA[1 < 2]]></a>")).toBe("<a>1 &lt; 2</a>");
  });

  it("returns null for fragments that are not well-formed", () => {
    for (const bad of ["<a>", "</a>", "<a></b>", "<a b=1/>", "<a>&unknown;</a>", "<a"]) expect(c(bad), bad).toBeNull();
  });
});
