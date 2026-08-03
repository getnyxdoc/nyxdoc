import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const verticalDirectories = [
  "tests/browser/vertical",
  "test/browser/vertical",
  "e2e/vertical",
].map((directory) => path.join(root, directory)).filter(existsSync);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const firstPartyRoute = /(?:^|[\\/"'`*?])(?:api|auth|oauth|mcp|collaboration|media)(?:[\\/?#]|$)/i;
const routeCall = /\b(?:page|context)\.route\s*\(/g;
const fulfillCall = /\broute\.fulfill\s*\(/g;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return sourceExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
  }));
  return files.flat();
}

function closingParenthesis(source, openingParenthesis) {
  let depth = 0;
  let quote;
  let escaped = false;
  for (let index = openingParenthesis; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (["'", '"', "`"].includes(character)) {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")" && --depth === 0) return index;
  }
  return source.length;
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

if (verticalDirectories.length === 0) {
  console.log("No browser vertical test directory found; first-party route mock guard skipped.");
  process.exit(0);
}

const violations = [];
for (const directory of verticalDirectories) {
  for (const file of await sourceFiles(directory)) {
    const source = await readFile(file, "utf8");
    const mentionsFirstPartyRoute = firstPartyRoute.test(source);
    routeCall.lastIndex = 0;
    for (let match; (match = routeCall.exec(source));) {
      const openingParenthesis = match.index + match[0].lastIndexOf("(");
      const callEnd = closingParenthesis(source, openingParenthesis);
      const call = source.slice(match.index, callEnd + 1);
      if (firstPartyRoute.test(call)) {
        violations.push(`${path.relative(root, file)}:${lineNumber(source, match.index)} (${match[0].trim()})`);
      }
      routeCall.lastIndex = callEnd + 1;
    }
    if (mentionsFirstPartyRoute && routeCall.test(source)) {
      fulfillCall.lastIndex = 0;
      for (let match; (match = fulfillCall.exec(source));) {
        violations.push(`${path.relative(root, file)}:${lineNumber(source, match.index)} (route.fulfill)`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Browser vertical tests must exercise first-party boundaries over real HTTP; remove these route mocks:");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log("No first-party route mocks found in browser vertical tests.");
