#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const tag = option("--tag");
  assert.match(tag ?? "", /^v\d+\.\d+\.\d+$/, "release tag must be an exact stable vX.Y.Z tag");
  const version = tag.slice(1);

  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(
    packageJson.version,
    version,
    `release tag ${tag} does not match package.json version ${packageJson.version ?? "missing"}`,
  );

  const packageLock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(
    packageLock.version,
    version,
    `release tag ${tag} does not match package-lock.json version ${packageLock.version ?? "missing"}`,
  );
  assert.equal(
    packageLock.packages?.[""]?.version,
    version,
    `release tag ${tag} does not match package-lock.json root package version ${packageLock.packages?.[""]?.version ?? "missing"}`,
  );

  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const heading = new RegExp(`^## ${version.replaceAll(".", "\\.")} - \\d{4}-\\d{2}-\\d{2}\\s*$`, "m");
  const match = heading.exec(changelog);
  assert(match, `CHANGELOG.md is missing a dated ${version} release heading`);
  const sectionStart = match.index + match[0].length;
  const nextHeading = changelog.indexOf("\n## ", sectionStart);
  const section = changelog.slice(sectionStart, nextHeading < 0 ? undefined : nextHeading);
  assert.match(section, /^\s*-\s+\S/m, `CHANGELOG.md ${version} section has no user-facing bullet`);

  const productionExample = await readFile(path.join(root, ".env.production.example"), "utf8");
  assert.match(
    productionExample,
    new RegExp(`^NYXDOC_IMAGE=ghcr\\.io/getnyxdoc/nyxdoc:${version.replaceAll(".", "\\.")}$`, "m"),
    `.env.production.example must select the same ${version} release image`,
  );

  console.log(`Release metadata is consistent for ${tag}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
