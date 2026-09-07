#!/usr/bin/env node
/*
 * sync-github.js
 * 扫描本地按日期保存的单词 txt，生成 dates.json 索引，
 * 并通过 GitHub API（api.github.com，绕过被墙的 git push）增量上传到仓库。
 *
 * 用法：node sync-github.js
 * token 来源：优先 GH_TOKEN 环境变量，否则用 `gh auth token`。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const { execFileSync } = require("child_process");

const DIR = __dirname;
const REPO = process.env.GH_REPO || "Yaaaccc/english-word-dictation";
const API_HOST = "api.github.com";
let TOKEN = "";

function getToken() {
  if (process.env.GH_TOKEN && process.env.GH_TOKEN.trim()) return process.env.GH_TOKEN.trim();
  try {
    const t = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (t) return t;
  } catch (e) {
    /* gh 不可用，交给外层报错 */
  }
  return "";
}

function api(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), "utf8") : null;
    const headers = {
      Authorization: "Bearer " + TOKEN,
      "User-Agent": "dictation-sync",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
    if (data) headers["Content-Length"] = data.length;
    const req = https.request(
      { host: API_HOST, path: apiPath, method, headers },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let j = null;
          try { j = buf ? JSON.parse(buf) : null; } catch (e) { j = null; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
          else reject(new Error(method + " " + apiPath + " -> HTTP " + res.statusCode + (j && j.message ? "：" + j.message : "")));
        });
      }
    );
    req.on("error", (e) => reject(new Error("网络错误 " + apiPath + "：" + e.message)));
    if (data) req.write(data);
    req.end();
  });
}

// 生成 dates.json，字段与网页端约定一致：{ date, source, file }，source ∈ 扇贝/扇贝复习
// 同一天允许多组：YYYY-MM-DD.txt 为第一组，YYYY-MM-DD-2.txt 起为后续组（第2组及以后显示「（第N组）」），
// 排序时同一天内第一组排在最前（网页默认选中第一组）。
function buildDates() {
  const ARCHIVE_DIR = path.join(DIR, "今日单词");
  const groupRe = /^(\d{4}-\d{2}-\d{2})(?:-(\d))?\.txt$/;
  const archiveFiles = fs.existsSync(ARCHIVE_DIR) ? fs.readdirSync(ARCHIVE_DIR) : [];
  const files = fs.readdirSync(DIR);
  const seenDates = new Set();
  const arr = [];
  // 扇贝新词：优先「今日单词」子文件夹，根目录历史日期文件向后兼容
  archiveFiles
    .map((f) => f.match(groupRe))
    .filter(Boolean)
    .forEach((m) => {
      const group = m[2] ? parseInt(m[2], 10) : 1;
      seenDates.add(m[1]);
      arr.push({
        date: m[2] ? m[1] + "（第" + m[2] + "组）" : m[1],
        source: "扇贝",
        file: "今日单词/" + m[0],
        // 99-组号：同一天内组号越小（越早抓的）排序越靠前，网页默认选中第一组
        _sort: m[1] + "#" + String(99 - group).padStart(2, "0"),
      });
    });
  files
    .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})\.txt$/))
    .filter(Boolean)
    .forEach((m) => {
      if (seenDates.has(m[1])) return;
      seenDates.add(m[1]);
      arr.push({ date: m[1], source: "扇贝", file: m[0], _sort: m[1] + "#98" });
    });
  files
    .map((f) => f.match(/^shanbay-review-(\d{4}-\d{2}-\d{2})(?:-(\d))?\.txt$/))
    .filter(Boolean)
    .forEach((m) => {
      const group = m[2] ? parseInt(m[2], 10) : 1;
      arr.push({
        date: m[2] ? m[1] + "（第" + m[2] + "组）" : m[1],
        source: "扇贝复习",
        file: m[0],
        _sort: m[1] + "#" + String(99 - group).padStart(2, "0"),
      });
    });
  arr.sort((a, b) =>
    a._sort === b._sort ? (a.source < b.source ? 1 : -1) : a._sort < b._sort ? 1 : -1
  );
  for (const e of arr) delete e._sort;
  return arr;
}

(async () => {
  TOKEN = getToken();
  if (!TOKEN) {
    console.error("[错误] 未获取到 GitHub 登录凭据。请先安装并登录 GitHub CLI（gh），或设置 GH_TOKEN 环境变量。");
    process.exit(1);
  }

  const dates = buildDates();
  if (!dates.length) {
    console.log("[提示] 未找到任何按日期保存的单词文件，无需同步。");
    return;
  }
  const datesJson = JSON.stringify(dates, null, 2);
  fs.writeFileSync(path.join(DIR, "dates.json"), datesJson, "utf8");

  // 待上传：dates.json + 所有日期 txt（去重）
  const filesToUpload = Array.from(new Set(["dates.json", ...dates.map((d) => d.file)]));

  // 1. 远程 main 的 HEAD 与 tree
  const ref = await api("GET", "/repos/" + REPO + "/git/ref/heads/main");
  const headSha = ref.object.sha;
  const headCommit = await api("GET", "/repos/" + REPO + "/git/commits/" + headSha);
  const baseTree = headCommit.tree.sha;

  // 2. 为每个文件创建 blob
  const entries = [];
  for (const f of filesToUpload) {
    const full = path.join(DIR, f);
    if (!fs.existsSync(full)) {
      console.log("[跳过] 本地不存在 " + f);
      continue;
    }
    const b64 = fs.readFileSync(full).toString("base64");
    const blob = await api("POST", "/repos/" + REPO + "/git/blobs", { content: b64, encoding: "base64" });
    entries.push({ path: f, mode: "100644", type: "blob", sha: blob.sha });
  }
  if (!entries.length) {
    console.log("[完成] 没有需要上传的文件。");
    return;
  }

  // 3. 基于远程 tree 增量生成新 tree
  const tree = await api("POST", "/repos/" + REPO + "/git/trees", { base_tree: baseTree, tree: entries });

  // 4. 内容无变化则跳过提交
  if (tree.sha === baseTree) {
    console.log("[完成] 单词内容无变化，无需提交。");
    return;
  }

  // 5. 提交
  const ymd = new Date().toISOString().slice(0, 10);
  const newCommit = await api("POST", "/repos/" + REPO + "/git/commits", {
    message: "每日同步单词与日期索引 " + ymd,
    tree: tree.sha,
    parents: [headSha],
  });

  // 6. 更新 main
  await api("PATCH", "/repos/" + REPO + "/git/refs/heads/main", { sha: newCommit.sha, force: false });

  console.log("[完成] 已同步 " + entries.length + " 个文件（含 dates.json）到 GitHub：" + newCommit.sha.slice(0, 7));
})().catch((e) => {
  console.error("[错误] " + (e && e.message ? e.message : e));
  process.exit(1);
});
