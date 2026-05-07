// ---------------------------------------------------------------------------
// Format raw LLM text for Telegram HTML display.
//
// Telegram supports a limited subset of HTML:
//   <b>, <i>, <u>, <s>, <code>, <pre>, <a href="...">, <tg-spoiler>
//
// Strategy:
//   1. Extract & protect code blocks and inline code (never format inside them).
//   2. Extract & convert $$...$$ block math and $...$ inline math (LaTeX → Unicode).
//   3. Escape remaining HTML entities.
//   4. Convert Markdown bold/italic/strikethrough/links/headings.
//   5. Restore protected segments as proper HTML tags.
// ---------------------------------------------------------------------------

// ---- LaTeX → Unicode mapping ------------------------------------------------

const LATEX_SYMBOLS: Record<string, string> = {
  "\\alpha": "\u03B1",
  "\\beta": "\u03B2",
  "\\gamma": "\u03B3",
  "\\delta": "\u03B4",
  "\\epsilon": "\u03B5",
  "\\varepsilon": "\u03B5",
  "\\zeta": "\u03B6",
  "\\eta": "\u03B7",
  "\\theta": "\u03B8",
  "\\vartheta": "\u03D1",
  "\\iota": "\u03B9",
  "\\kappa": "\u03BA",
  "\\lambda": "\u03BB",
  "\\mu": "\u03BC",
  "\\nu": "\u03BD",
  "\\xi": "\u03BE",
  "\\pi": "\u03C0",
  "\\rho": "\u03C1",
  "\\sigma": "\u03C3",
  "\\tau": "\u03C4",
  "\\upsilon": "\u03C5",
  "\\phi": "\u03C6",
  "\\varphi": "\u03D5",
  "\\chi": "\u03C7",
  "\\psi": "\u03C8",
  "\\omega": "\u03C9",
  "\\Gamma": "\u0393",
  "\\Delta": "\u0394",
  "\\Theta": "\u0398",
  "\\Lambda": "\u039B",
  "\\Xi": "\u039E",
  "\\Pi": "\u03A0",
  "\\Sigma": "\u03A3",
  "\\Phi": "\u03A6",
  "\\Psi": "\u03A8",
  "\\Omega": "\u03A9",
  "\\sum": "\u2211",
  "\\prod": "\u220F",
  "\\int": "\u222B",
  "\\iint": "\u222C",
  "\\oint": "\u222E",
  "\\pm": "\u00B1",
  "\\mp": "\u2213",
  "\\times": "\u00D7",
  "\\div": "\u00F7",
  "\\leq": "\u2264",
  "\\le": "\u2264",
  "\\geq": "\u2265",
  "\\ge": "\u2265",
  "\\neq": "\u2260",
  "\\ne": "\u2260",
  "\\equiv": "\u2261",
  "\\approx": "\u2248",
  "\\sim": "\u223C",
  "\\propto": "\u221D",
  "\\infty": "\u221E",
  "\\partial": "\u2202",
  "\\nabla": "\u2207",
  "\\forall": "\u2200",
  "\\exists": "\u2203",
  "\\in": "\u2208",
  "\\notin": "\u2209",
  "\\subset": "\u2282",
  "\\supset": "\u2283",
  "\\subseteq": "\u2286",
  "\\supseteq": "\u2287",
  "\\cup": "\u222A",
  "\\cap": "\u2229",
  "\\emptyset": "\u2205",
  "\\to": "\u2192",
  "\\gets": "\u2190",
  "\\Rightarrow": "\u21D2",
  "\\implies": "\u21D2",
  "\\iff": "\u21D4",
  "\\cdot": "\u22C5",
  "\\circ": "\u2218",
  "\\bullet": "\u2022",
  "\\dots": "\u2026",
  "\\ldots": "\u2026",
  "\\cdots": "\u22EF",
  "\\vdots": "\u22EE",
  "\\ddots": "\u22F1",
  "\\sqrt": "\u221A",
  "\\hbar": "\u210F",
  "\\ell": "\u2113",
  "\\Re": "\u211C",
  "\\Im": "\u2111",
  "\\aleph": "\u2135",
  "\\angle": "\u2220",
  "\\perp": "\u22A5",
  "\\parallel": "\u2225",
  "\\triangle": "\u25B3",
  "\\square": "\u25A1",
  "\\prime": "\u2032",
  "\\degree": "\u00B0",
  "\\%": "%",
  "\\&": "&",
  "\\#": "#",
  "\\$": "$",
  // LaTeX math text operators → plain text
  "\\cos": "cos",
  "\\sin": "sin",
  "\\tan": "tan",
  "\\cot": "cot",
  "\\sec": "sec",
  "\\csc": "csc",
  "\\arcsin": "arcsin",
  "\\arccos": "arccos",
  "\\arctan": "arctan",
  "\\sinh": "sinh",
  "\\cosh": "cosh",
  "\\tanh": "tanh",
  "\\log": "log",
  "\\ln": "ln",
  "\\lg": "lg",
  "\\exp": "exp",
  "\\lim": "lim",
  "\\limsup": "lim sup",
  "\\liminf": "lim inf",
  "\\max": "max",
  "\\min": "min",
  "\\sup": "sup",
  "\\inf": "inf",
  "\\det": "det",
  "\\dim": "dim",
  "\\arg": "arg",
  "\\deg": "deg",
  "\\hom": "hom",
  "\\ker": "ker",
  "\\gcd": "gcd",
  "\\Pr": "Pr",
};

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  "0": "\u2070",
  "1": "\u00B9",
  "2": "\u00B2",
  "3": "\u00B3",
  "4": "\u2074",
  "5": "\u2075",
  "6": "\u2076",
  "7": "\u2077",
  "8": "\u2078",
  "9": "\u2079",
};

const SUBSCRIPT_DIGITS: Record<string, string> = {
  "0": "\u2080",
  "1": "\u2081",
  "2": "\u2082",
  "3": "\u2083",
  "4": "\u2084",
  "5": "\u2085",
  "6": "\u2086",
  "7": "\u2087",
  "8": "\u2088",
  "9": "\u2089",
};

// ---- Helpers ----------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface Placeholder {
  id: string;
  html: string;
}

let placeholderCounter = 0;
function uniqueId(): string {
  return `\x00PH${placeholderCounter++}\x00`;
}

// ---- LaTeX math → Unicode ---------------------------------------------------

function convertLatexToUnicode(latex: string): string {
  let s = latex.trim();

  // Handle \frac{a}{b} → (a/b)
  s = s.replace(
    /\\frac\{([^}]*)}\{([^}]*)}/g,
    (_, a, b) => `(${convertLatexToUnicode(a)}/${convertLatexToUnicode(b)})`,
  );

  // Handle \sqrt[n]{x} → ⁿ√x, \sqrt{x} → √x
  s = s.replace(/\\sqrt\[(\d+)]\{([^}]*)}/g, (_, n, x) => {
    const sup = n
      .split("")
      .map((c: string) => SUPERSCRIPT_DIGITS[c] ?? c)
      .join("");
    return `${sup}\u221A${convertLatexToUnicode(x)}`;
  });
  s = s.replace(/\\sqrt\{([^}]*)}/g, (_, x) => `\u221A${convertLatexToUnicode(x)}`);

  // Handle \text{...}
  s = s.replace(/\\text\{([^}]*)}/g, "$1");

  // Handle \mathrm{...}
  s = s.replace(/\\mathrm\{([^}]*)}/g, "$1");

  // Handle \mathbf{...}
  s = s.replace(/\\mathbf\{([^}]*)}/g, "$1");

  // Superscripts: ^{...} or ^x
  s = s.replace(/\^{([^}]*)}/g, (_, content) => {
    return content
      .split("")
      .map((c: string) => SUPERSCRIPT_DIGITS[c] ?? c)
      .join("");
  });
  s = s.replace(/\^([\\a-zA-Z])/g, (_, c) => {
    if (LATEX_SYMBOLS[c]) return LATEX_SYMBOLS[c];
    return c;
  });
  s = s.replace(/\^(\d)/g, (_, d) => SUPERSCRIPT_DIGITS[d] ?? d);

  // Subscripts: _{...} or _x
  s = s.replace(/_{([^}]*)}/g, (_, content) => {
    return content
      .split("")
      .map((c: string) => SUBSCRIPT_DIGITS[c] ?? c)
      .join("");
  });
  s = s.replace(/_(\d)/g, (_, d) => SUBSCRIPT_DIGITS[d] ?? d);

  // Replace known LaTeX symbols (longest first to avoid partial matches)
  const sortedSymbols = Object.keys(LATEX_SYMBOLS).sort((a, b) => b.length - a.length);
  for (const sym of sortedSymbols) {
    s = s.split(sym).join(LATEX_SYMBOLS[sym]);
  }

  // Clean up remaining braces and common LaTeX noise
  s = s.replace(/[{}]/g, "");
  s = s.replace(/\\left/g, "");
  s = s.replace(/\\right/g, "");
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

// ---- Main formatting function -----------------------------------------------

export function formatForTelegramHtml(text: string): string {
  if (!text) return text;

  const placeholders: Placeholder[] = [];
  placeholderCounter = 0;

  function protect(html: string): string {
    const id = uniqueId();
    placeholders.push({ id, html });
    return id;
  }

  let result = text;

  // 1. Protect fenced code blocks (```...```)
  result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    return protect(`<pre><code>${escapeHtml(code.trimEnd())}</code></pre>`);
  });

  // 2. Protect inline code (`...`)
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    return protect(`<code>${escapeHtml(code)}</code>`);
  });

  // 3. Extract $$...$$ block math → <pre><code> with LaTeX→Unicode
  result = result.replace(/\$\$([\s\S]+?)\$\$/g, (_match, math) => {
    const converted = convertLatexToUnicode(math);
    return protect(`<pre><code>${escapeHtml(converted)}</code></pre>`);
  });

  // 4. Extract \[...\] block math → <pre><code> with LaTeX→Unicode
  result = result.replace(/\\\[([\s\S]+?)\\\]/g, (_match, math) => {
    const converted = convertLatexToUnicode(math);
    return protect(`<pre><code>${escapeHtml(converted)}</code></pre>`);
  });

  // 5. Extract $...$ inline math → <code> with LaTeX→Unicode
  result = result.replace(/\$([^$\n]+?)\$/g, (_match, math) => {
    const converted = convertLatexToUnicode(math);
    return protect(`<code>${escapeHtml(converted)}</code>`);
  });

  // 6. Extract \(...\) inline math → <code> with LaTeX→Unicode
  result = result.replace(/\\\(([\s\S]+?)\\\)/g, (_match, math) => {
    const converted = convertLatexToUnicode(math);
    return protect(`<code>${escapeHtml(converted)}</code>`);
  });

  // 7. Escape HTML entities in remaining text
  result = escapeHtml(result);

  // 8. Convert Markdown headers (### heading → <b>heading</b>)
  result = result.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");

  // 9. Convert **bold**
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 10. Convert *italic* — avoid matching inside <b> tags or across lines
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");

  // 11. Convert ~~strikethrough~~
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 12. Convert [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 13. Restore placeholders
  for (const { id, html } of placeholders) {
    result = result.replace(id, html);
  }

  return result;
}
