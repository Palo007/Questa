// _extract.js -- shared anchor-based source extraction helpers.
//
// Several tests pull functions/blocks out of app.js (or sync.js) and eval
// them in a vm sandbox rather than requiring the whole file (which has no
// module.exports and touches the DOM at load time). They used to do this
// with a `grab(lineStart, lineEnd)` helper keyed on hardcoded ABSOLUTE line
// numbers. Every insertion anywhere earlier in app.js silently shifted every
// range below it -- this has already required a manual 7-spot repatch once,
// with 6 more app.js edits queued. Worse than breakage: a shifted-but-still-
// parseable grab can silently extract the WRONG code and still pass.
//
// These helpers instead locate code by ANCHOR: a regex matched against the
// declaration/line text (not its position), then (where the region is a
// function or brace block) a forward brace-balance scan finds the TRUE end,
// so extraction survives arbitrary line shifts elsewhere in the file.
//
// Lexing hazards the balancer (`scanToBraceClose`) DOES handle:
//   - `//` line comments
//   - `/* ... */` block comments, including ones spanning multiple lines
//   - 'single' and "double" quoted strings, with `\` escapes
//   - `template literals`, treated as an OPAQUE span up to the closing
//     backtick -- ${...} interpolations are not parsed, so braces inside an
//     interpolation are correctly ignored (the whole template is skipped,
//     not "balanced")
//   - /regex/ literals, via a heuristic: a '/' starts a regex if the
//     previous significant (non-whitespace) character is one of
//     ({[,;:=&|!?+-*%^~<>  or it's the very start of the scanned text;
//     character classes [...] inside the regex are tracked so an unescaped
//     '/' inside brackets does not end the regex early
//
// Hazards NOT handled (documented, not needed by any current call site):
//   - ambiguous '/' (division vs. regex-start) in contexts the heuristic
//     above doesn't cover, e.g. immediately after an identifier/`)`/`]`
//     where it's actually a regex literal
//   - a regex literal itself containing a literal, un-escaped newline
//     (impossible in real JS regex literals, so scanning bails to plain
//     division-mode at a newline as a safe fallback)
//   - nested/escaped backticks inside a `${...}` interpolation
// None of the extracted regions in app.js hit these cases (verified by
// inspection when this module was written); if a future edit introduces one,
// the equivalence-proof step (md5 comparison against the old grab output)
// run at refactor time would have caught a mismatch, and node --check /
// tests/run.js will fail loudly rather than silently mis-extracting.

const fs = require('fs');

function throwAnchor(label, regex, count) {
  throw new Error(
    'anchor extraction failed for "' + label + '": pattern ' + regex +
    (count === 0
      ? ' matched 0 lines (source shifted, renamed, or removed)'
      : ' matched ' + count + ' lines (anchor is no longer unique)')
  );
}

// Find the single line index (0-based) matching `regex`, searching from
// `fromIdx` onward. Throws if zero or more-than-one lines match -- silent
// wrong-extraction must never happen.
function findLineIndex(lines, regex, label, fromIdx) {
  fromIdx = fromIdx || 0;
  const hits = [];
  for (let i = fromIdx; i < lines.length; i++) {
    if (regex.test(lines[i])) hits.push(i);
  }
  if (hits.length !== 1) throwAnchor(label, regex, hits.length);
  return hits[0];
}

// Character-scanning brace balancer. `text` is the FULL source string; `pos`
// is the index of the character immediately AFTER an opening '{' (so depth
// starts at 1). Returns the index of the matching '}'. See module header for
// which comment/string/regex hazards this does and doesn't handle.
function scanToBraceClose(text, pos) {
  let depth = 1;
  let prevSig = '{'; // last significant (non-whitespace) char seen, for the regex heuristic
  while (pos < text.length) {
    const c = text[pos];

    if (c === '/' && text[pos + 1] === '/') { // line comment
      const nl = text.indexOf('\n', pos);
      pos = (nl === -1) ? text.length : nl;
      continue;
    }
    if (c === '/' && text[pos + 1] === '*') { // block comment
      const close = text.indexOf('*/', pos + 2);
      pos = (close === -1) ? text.length : close + 2;
      continue;
    }
    if (c === '\'' || c === '"') { // string literal
      const quote = c; pos++;
      while (pos < text.length) {
        if (text[pos] === '\\') { pos += 2; continue; }
        if (text[pos] === quote) { pos++; break; }
        pos++;
      }
      prevSig = quote; continue;
    }
    if (c === '`') { // template literal (opaque span)
      pos++;
      while (pos < text.length) {
        if (text[pos] === '\\') { pos += 2; continue; }
        if (text[pos] === '`') { pos++; break; }
        pos++;
      }
      prevSig = '`'; continue;
    }
    if (c === '/' && /[({\[,;:=&|!?+\-*%^~<>]/.test(prevSig)) { // regex literal
      let p = pos + 1, inClass = false, sawEnd = false;
      while (p < text.length) {
        const rc = text[p];
        if (rc === '\\') { p += 2; continue; }
        if (rc === '[') { inClass = true; p++; continue; }
        if (rc === ']') { inClass = false; p++; continue; }
        if (rc === '\n') break; // regex literals can't contain real newlines; bail
        if (rc === '/' && !inClass) { p++; sawEnd = true; break; }
        p++;
      }
      if (sawEnd) {
        while (p < text.length && /[a-z]/i.test(text[p])) p++; // flags
        pos = p; prevSig = '/'; continue;
      }
      // Didn't find a plausible regex close before EOL -- treat the '/' as a
      // plain character (division) and fall through to normal handling.
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return pos; }
    if (!/\s/.test(c)) prevSig = c;
    pos++;
  }
  throw new Error('scanToBraceClose: reached end of source without closing brace (depth=' + depth + ')');
}

function charOffsetOfLine(lines, lineIdx) {
  let off = 0;
  for (let i = 0; i < lineIdx; i++) off += lines[i].length + 1; // +1 for '\n'
  return off;
}

function lineIndexOfPos(text, pos) {
  let idx = 0;
  for (let i = 0; i < pos; i++) if (text[i] === '\n') idx++;
  return idx;
}

function braceEndLineIndex(src, lines, declIdx, label, braceFinder) {
  const charOffset = charOffsetOfLine(lines, declIdx);
  const braceInLine = braceFinder(lines[declIdx]);
  if (braceInLine === -1) {
    throw new Error('extraction failed for "' + label + '": anchor line has no opening brace: ' + JSON.stringify(lines[declIdx]));
  }
  const openPos = charOffset + braceInLine;
  const closePos = scanToBraceClose(src, openPos + 1);
  return lineIndexOfPos(src, closePos);
}

// Extract a full function's source: from the line matching declRegex through
// the true (brace-balanced) end of its body, inclusive. Works for both
// single-line and multi-line function bodies.
function extractFunction(src, declRegex, label) {
  const lines = src.split('\n');
  const declIdx = findLineIndex(lines, declRegex, label);
  const endIdx = braceEndLineIndex(src, lines, declIdx, label, l => l.indexOf('{'));
  return lines.slice(declIdx, endIdx + 1).join('\n');
}

// Extract the INTERIOR of a brace block whose opening line matches
// openLineRegex (the '{' must be the LAST significant brace on that line, as
// with `} else if(cond){`). Returns the lines strictly between the opening
// and matching closing line (both excluded) -- matching the old
// grab(bodyStart, bodyEnd) convention used for openOpt branches.
function extractBraceBody(src, openLineRegex, label) {
  const lines = src.split('\n');
  const openIdx = findLineIndex(lines, openLineRegex, label);
  const closeIdx = braceEndLineIndex(src, lines, openIdx, label, l => l.lastIndexOf('{'));
  if (closeIdx <= openIdx + 1) {
    throw new Error('extractBraceBody: "' + label + '" body is empty or inverted (open line ' + openIdx + ', close line ' + closeIdx + ')');
  }
  return lines.slice(openIdx + 1, closeIdx).join('\n');
}

// Extract exactly one line of source matching regex (exactly one match required).
function extractLine(src, regex, label) {
  const lines = src.split('\n');
  const idx = findLineIndex(lines, regex, label);
  return lines[idx];
}

// Extract a contiguous span starting at the line matching startRegex through
// an end line computed by `endFinder(src, lines, startIdx) -> endLineIdx`
// (inclusive). Used when the end of a region isn't itself a clean anchor but
// is derived, e.g. "wherever this function's brace-balanced body ends".
function extractSpan(src, startRegex, endFinder, label) {
  const lines = src.split('\n');
  const startIdx = findLineIndex(lines, startRegex, label + ':start');
  const endIdx = endFinder(src, lines, startIdx);
  if (endIdx < startIdx) {
    throw new Error('extractSpan: "' + label + '" end line (' + endIdx + ') precedes start line (' + startIdx + ')');
  }
  return lines.slice(startIdx, endIdx + 1).join('\n');
}

// Build an `endFinder` for extractSpan: locates a function declaration
// (searching forward from the span's start line) and returns the line index
// of its brace-balanced end.
function functionEndLineIndex(declRegex, label) {
  return function (src, lines, fromLineIdx) {
    const declIdx = findLineIndex(lines, declRegex, label, fromLineIdx);
    return braceEndLineIndex(src, lines, declIdx, label, l => l.indexOf('{'));
  };
}

module.exports = {
  readSource: absPath => fs.readFileSync(absPath, 'utf8'),
  findLineIndex,
  scanToBraceClose,
  extractFunction,
  extractBraceBody,
  extractLine,
  extractSpan,
  functionEndLineIndex,
};
