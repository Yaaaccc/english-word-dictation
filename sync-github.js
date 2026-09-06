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

// 生成 dates.json，字段与网页端约定一致：{ date, source, file }，source ∈ 扇贝/扇贝复习/不背单词
function buildDates() {
  const files = fs.readdirSync(DIR);
  const arr = []
    .concat(
      files
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.txt$/.test(f))
        .map((f) => ({ date: f.slice(0, 10), source: "扇贝", file: f }))
    )
    .concat(
      files
        .filter((f) => /^bubei-\d{4}-\d{2}-\d{2}\.txt$/.test(f))
        .map((f) => ({ date: f.slice(6, 16), source: "不背单词", file: f }))
    )
    .concat(
      files
        .filter((f) => /^shanbay-review-\d{4}-\d{2}-\d{2}\.txt$/.test(f))
        .map((f) => ({ date: f.slice(15, 25), source: "扇贝复习", file: f }))
    )
    .sort((a, b) =>
      a.date === b.date ? (a.source < b.source ? 1 : -1) : a.date < b.date ? 1 : -1
    );
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
