#!/usr/bin/env node
// Prints the GitHub release notes for a tag from CHANGELOG.md.
//
// Usage: node scripts/release-notes.mjs <tag>   (for example v2.0.1 or v2.1.0-rc.0)
//
// Uses the CHANGELOG section of the tag's version (for a prerelease, of its base
// version), joins hard-wrapped lines so they render as paragraphs, makes relative
// links absolute at the tag, and adds a link to the full diff since the previous tag.
import { readFileSync } from 'node:fs';

const REPO = 'https://github.com/biolimbo/lip-sync-engine';

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error('Usage: node scripts/release-notes.mjs <tag>');
  process.exit(1);
}
const version = tag.slice(1);
const base = version.split('-')[0];

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const lines = changelog.split('\n');
const headings = lines
  .map((line, index) => ({ index, match: line.match(/^## \[([^\]]+)\]/) }))
  .filter(({ match }) => match);
const start = headings.findIndex(({ match }) => match[1] === base);

let body;
let previous;
if (start === -1) {
  if (version === base) {
    console.error(`CHANGELOG.md has no section for ${base}`);
    process.exit(1);
  }
  body = `Prerelease of ${base}. See [CHANGELOG.md](${REPO}/blob/${tag}/CHANGELOG.md).`;
  previous = headings[0]?.match[1];
} else {
  const end =
    start + 1 < headings.length
      ? headings[start + 1].index
      : lines.findIndex((line, index) => index > headings[start].index && /^\[[^\]]+\]: /.test(line));
  body = unwrap(lines.slice(headings[start].index + 1, end === -1 ? undefined : end))
    .trim()
    .replace(/\]\(\.\/([^)]+)\)/g, `](${REPO}/blob/${tag}/$1)`);
  previous = headings[start + 1]?.match[1];
}

if (previous) {
  body += `\n\n**Full Changelog**: ${REPO}/compare/v${previous}...${tag}`;
}
console.log(body);

/** Joins wrapped continuation lines onto the paragraph or list item they belong to */
function unwrap(section) {
  const out = [];
  let inFence = false;
  for (const line of section) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    const startsBlock = /^\s*([-*+]|\d+\.)\s|^\s*(#|\|)/.test(line);
    const prevEndsBlock = prev === undefined || !prev.trim() || /^\s*(#|\||```)/.test(prev);
    if (!inFence && line.trim() && !startsBlock && !prevEndsBlock) {
      out[out.length - 1] = `${prev.trimEnd()} ${line.trim()}`;
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}
