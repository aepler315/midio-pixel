// A very small source scanner for two structural mistakes a class body can
// make silently, both of which this codebase has already shipped.
//
// It works on source text rather than on a loaded module because both
// mistakes are invisible once the module is evaluated: a duplicate method
// name has already collapsed to a single property by then, and a call site's
// surplus arguments have already been dropped on the floor.
//
// Deliberately not a real parser. It strips comments and string bodies so
// that brace and paren matching is trustworthy, then reads the class body
// with a depth counter. That is enough for the shape of this codebase (one
// method per line, no clever metaprogramming) and it costs nothing to run.

/** Blank out comments and the insides of string/template literals, keeping
 *  every character position intact so offsets stay meaningful. */
export function stripNonCode(src) {
  const out = src.split('');
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === '`') {
      let k = i + 1;
      while (k < src.length) {
        if (src[k] === '\\') { k += 2; continue; }
        if (src[k] === c) break;
        k++;
      }
      blank(i + 1, k);
      i = k + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Every `class X { ... }` body in a file, as {name, body, offset}. */
export function classBodies(src) {
  const code = stripNonCode(src);
  const re = /\bclass\s+([A-Za-z_$][\w$]*)[^{]*\{/g;
  const out = [];
  let m;
  while ((m = re.exec(code))) {
    let depth = 1, i = re.lastIndex;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
    }
    out.push({ name: m[1], body: code.slice(re.lastIndex, i - 1), offset: re.lastIndex });
  }
  return out;
}

const NOT_A_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new',
]);

/** Method definitions sitting at the top level of a class body, as
 *  {name, params, required, line}. `params` counts declared parameters,
 *  `required` those without a default. */
export function classMethods(body, bodyOffset, src) {
  const methods = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (depth !== 0 || c !== '(') {
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') depth--;
      continue;
    }
    // At class-body top level: a name immediately followed by '(' starts a
    // method. Walk back over the identifier and check the prefix.
    let s = i;
    while (s > 0 && /[\w$#]/.test(body[s - 1])) s--;
    const name = body.slice(s, i);
    const { args, end } = readArgs(body, i);
    // Skip the whole paren group either way, so a top-level '(' that turns
    // out not to be a method (a field initializer's call) cannot leave the
    // depth counter unbalanced.
    i = end;
    if (!name || NOT_A_METHOD.has(name) || /^\d/.test(name)) continue;
    const before = body.slice(Math.max(0, s - 24), s);
    if (/[.\w$)\]]\s*$/.test(before)) continue; // a call or property access, not a definition
    // A method definition's ')' is followed by '{'; anything else is not one.
    if (!/^\s*\{/.test(body.slice(end + 1))) continue;
    methods.push({
      name,
      params: args.length,
      required: args.filter((a) => !a.includes('=')).length,
      line: lineOf(src, bodyOffset + s),
    });
  }
  return methods;
}

/** `this.name(...)` call sites inside a class body, as {name, args, line}. */
export function thisCalls(body, bodyOffset, src) {
  const calls = [];
  const re = /this\.([#\w$]+)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const open = body.indexOf('(', m.index + m[0].length - 1);
    const { args, end } = readArgs(body, open);
    calls.push({ name: m[1], args: args.length, line: lineOf(src, bodyOffset + m.index) });
    re.lastIndex = end;
  }
  return calls;
}

/** Split the argument/parameter list whose '(' sits at `open`. */
function readArgs(text, open) {
  let depth = 0, cur = '', args = [], i = open;
  for (; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) {
      depth++;
      if (depth === 1) continue;
    } else if (')]}'.includes(c)) {
      depth--;
      if (depth === 0) { if (cur.trim()) args.push(cur); break; }
    }
    if (c === ',' && depth === 1) { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  return { args, end: i };
}

function lineOf(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src[i] === '\n') line++;
  return line;
}
