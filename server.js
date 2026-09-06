// 本地听写服务：在 127.0.0.1:8787 提供听写工具和按日期保存的单词，并自动打开浏览器
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const PORT = 8787;
const DIR = __dirname;
let dictDb = null;
function getDictDb() {
  if (dictDb) return dictDb;
  const dbPath = path.join(DIR, "词典", "ecdict.db");
  if (!fs.existsSync(dbPath)) return null;
  try {
    dictDb = new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    dictDb = null;
  }
  return dictDb;
}
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = http.createServer((req, res) => {
  let urlPath = "/";
  try {
    urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  } catch (e) {
    urlPath = "/";
  }

  // 查词接口：/api/dict?word=interval
  if (urlPath === "/api/dict") {
    const params = new URL(req.url, "http://127.0.0.1").searchParams;
    const raw = (params.get("word") || "").trim();
    const word = raw.toLowerCase();
    const db2 = getDictDb();
    if (!db2 || !word) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "未找到词典或单词为空" }));
      return;
    }
    try {
      const stmt = db2.prepare("SELECT * FROM dict WHERE word = ?");
      let row = stmt.get(word);
      if (!row && raw && raw !== word) row = stmt.get(raw);
      if (!row) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "词典中未找到该单词" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(row));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 日期列表接口：返回所有按日期保存的单词文件（扇贝 2026-08-05.txt）
  if (urlPath === "/api/dates") {
    let dates = [];
    try {
      dates = fs
        .readdirSync(DIR)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.txt$/.test(f))
        .map((f) => ({ date: f.slice(0, 10), source: "扇贝", file: f }))
        .concat(
          fs
            .readdirSync(DIR)
            .filter((f) => /^shanbay-review-\d{4}-\d{2}-\d{2}\.txt$/.test(f))
            .map((f) => ({ date: f.slice(15, 25), source: "扇贝复习", file: f }))
        )
        .sort((a, b) => (a.date === b.date ? (a.source === b.source ? 0 : a.source < b.source ? -1 : 1) : a.date < b.date ? 1 : -1));
    } catch (e) {}
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(dates));
    return;
  }

  if (urlPath === "/") urlPath = "/word-dictation.html";
  const filePath = path.normalize(path.join(DIR, urlPath.replace(/^\/+/, "")));
  if (!filePath.startsWith(DIR + path.sep) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 未找到");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log("端口 " + PORT + " 已被占用，可能听写服务已经在运行。");
    console.log("请直接打开 http://127.0.0.1:" + PORT + " ，或先关闭之前的黑色窗口。");
  } else {
    console.log("服务启动失败：" + e.message);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const url = "http://127.0.0.1:" + PORT + "/";
  console.log("听写工具已启动：" + url);
  if (!process.env.SERVER_NO_OPEN) {
    console.log("正在打开浏览器…");
    setTimeout(() => {
      exec('start "" "' + url + '"', (err) => {
        if (err) console.log("自动打开浏览器失败，请手动访问：" + url);
      });
    }, 800);
  }
  console.log("关闭本窗口即可停止服务。");
});
