const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const miniRoot = path.resolve(__dirname, "..", "..", "inCircleClient");

function read(relativePath) {
  return fs.readFileSync(path.join(miniRoot, relativePath), "utf8");
}

function collectFiles(directory, extension, files) {
  const result = files || [];
  fs.readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectFiles(fullPath, extension, result);
    else if (entry.name.endsWith(extension)) result.push(fullPath);
  });
  return result;
}

function wxmlTags(source) {
  const tags = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "<" || source[index + 1] === "!" || source[index + 1] === "?") continue;
    let quote = "";
    let end = index + 1;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (quote) {
        if (character === quote) quote = "";
      } else if (character === "\"" || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    assert.ok(end < source.length, "WXML tag is not closed");
    const raw = source.slice(index + 1, end).trim();
    const match = raw.match(/^(\/?)([A-Za-z][\w-]*)/);
    if (match) {
      tags.push({
        closing: !!match[1],
        name: match[2],
        selfClosing: /\/\s*$/.test(raw),
      });
    }
    index = end;
  }
  return tags;
}

test("all WXML files keep balanced element tags", () => {
  const files = collectFiles(miniRoot, ".wxml");
  files.forEach((file) => {
    const stack = [];
    wxmlTags(fs.readFileSync(file, "utf8")).forEach((tag) => {
      if (tag.selfClosing) return;
      if (!tag.closing) {
        stack.push(tag.name);
        return;
      }
      const expected = stack.pop();
      assert.equal(tag.name, expected, file + " has a mismatched closing tag");
    });
    assert.deepEqual(stack, [], file + " has unclosed tags");
  });
});

test("the shared empty state is registered and covers primary empty lists", () => {
  const appConfig = JSON.parse(read("app.json"));
  assert.equal(appConfig.usingComponents["empty-state"], "/components/empty-state/index");
  [
    ["pages/activities/index.wxml", "!activities.length"],
    ["pages/tools/index.wxml", "!bills.length"],
    ["pages/tools/index.wxml", "!votes.length"],
    ["pages/tools/index.wxml", "!checkins.length"],
    ["pages/docs/index.wxml", "!filteredDocs.length"],
    ["pages/index/index.wxml", "home.leaderboard.length"],
    ["pages/members/index.wxml", "!recentScoreLogs.length"],
    ["pages/member-detail/index.wxml", "member.badges.length"],
  ].forEach(([file, condition]) => {
    const source = read(file);
    assert.match(source, /<empty-state/);
    assert.ok(source.includes(condition), file + " is missing empty condition " + condition);
  });
});

test("empty state icons follow the active theme and keep distinct business meanings", () => {
  const styles = read("components/empty-state/index.wxss");
  assert.match(styles, /\.empty-icon\s*\{[^}]*filter:\s*var\(--theme-icon-filter/s);

  const templates = collectFiles(miniRoot, ".wxml").map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.doesNotMatch(templates, /\/images\/ui-icons\/star\.png/);

  const memberTemplate = read("pages/member-detail/index.wxml");
  ["tag", "nomination", "skill", "heart", "alert", "clock", "history", "medal"].forEach((name) => {
    assert.ok(memberTemplate.includes(`/images/ui-icons/${name}.svg`), `member detail is missing ${name}.svg`);
  });

  [
    "account",
    "alert",
    "checklist",
    "clock",
    "copy",
    "dice",
    "heart",
    "history",
    "layers",
    "lightbulb",
    "link",
    "medal",
    "nomination",
    "palette",
    "photo",
    "profile",
    "qr-code",
    "recap",
    "score",
    "search",
    "share",
    "skill",
    "tag",
    "transfer",
  ].forEach((name) => {
    const icon = read(`images/ui-icons/${name}.svg`);
    assert.match(icon, /viewBox="0 0 24 24"/);
    assert.match(icon, /stroke="#000000"/);
    assert.match(icon, /stroke-linecap="round"/);
  });
});
