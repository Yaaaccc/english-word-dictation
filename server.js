// 本地听写服务：在 127.0.0.1:8787 提供听写工具和按日期保存的单词，并自动打开浏览器
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec, spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const PORT = 8787;
const DIR = __dirname;
let dictDb = null;
let refreshing = false; // 防止并发抓取
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

  // 刷新接口：触发一次扇贝抓取（本地网页「刷新」按钮调用），最长 3 分钟
  if (urlPath === "/api/refresh") {
    if (refreshing) {
      res.writeHead(429, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "已有抓取在进行中，请稍候" }));
      return;
    }
    refreshing = true;
    console.log("[" + new Date().toLocaleTimeString() + "] 收到刷新请求，开始抓取扇贝单词…");
    const child = spawn(process.execPath, [path.join(DIR, "grab-shanbay.js")], {
      cwd: DIR,
      env: Object.assign({}, process.env, { GRAB_HEADLESS: "1", SERVER_NO_OPEN: "1" }),
      stdio: "ignore",
    });
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      refreshing = false;
      clearTimeout(killer);
      console.log("[" + new Date().toLocaleTimeString() + "] 抓取结束，退出码 " + code);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: code === 0, code: code }));
    };
    const killer = setTimeout(() => {
      console.log("抓取超时（3 分钟），强制终止");
      try { child.kill(); } catch (e) {}
      finish(124);
    }, 180000);
    child.on("close", (code) => finish(code));
    child.on("error", () => finish(-1));
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

  // 重排艾宾浩斯日历（2026-11-01 加）：运行电脑上的生成脚本（双击生成计划.bat），
  // 完成后把 calendar/calendar.json 推到 GitHub——手机/平板的日历卡片随之更新。
  if (urlPath === "/api/calendar-build") {
    const candidates = [
      "双击生成计划.bat",
      "生成计划.bat",
      path.join("calendar", "双击生成计划.bat"),
      path.join("calendar", "生成计划.bat"),
    ];
    const bat = candidates.map((c) => path.join(DIR, c)).find((p) => fs.existsSync(p));
    let done = false;
    const jsonOut = (obj) => {
      if (done) return;
      done = true;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    if (!bat) {
      jsonOut({ ok: false, error: "工具目录里没找到日历生成脚本（双击生成计划.bat）——把脚本放进本目录后重试" });
      return;
    }
    const calPath = path.join(DIR, "calendar", "calendar.json");
    const before = fs.existsSync(calPath) ? fs.statSync(calPath).mtimeMs : 0;
    console.log("[" + new Date().toLocaleTimeString() + "] 收到日历重排请求，运行 " + bat + " …");
    const child = spawn("cmd.exe", ["/c", bat], { cwd: DIR, stdio: "ignore" });
    const killer = setTimeout(() => {
      console.log("日历重排超时（3 分钟），强制终止");
      try { child.kill(); } catch (e) {}
    }, 180000);
    child.on("error", (e) => {
      clearTimeout(killer);
      jsonOut({ ok: false, error: "无法启动生成脚本：" + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      const after = fs.existsSync(calPath) ? fs.statSync(calPath).mtimeMs : 0;
      if (after === before) {
        jsonOut({ ok: false, error: "脚本跑完了但 calendar.json 没有更新（退出码 " + code + "），在电脑上手动跑一次看看报错" });
        return;
      }
      let generatedAt = "";
      try { generatedAt = JSON.parse(fs.readFileSync(calPath, "utf8")).generated_at || ""; } catch (e) {}
      const b64 = Buffer.from(fs.readFileSync(calPath)).toString("base64");
      const get = spawn("gh", ["api", "repos/Yaaaccc/english-word-dictation/contents/calendar/calendar.json", "--jq", ".sha"], { cwd: DIR });
      let shaOut = "";
      get.stdout.on("data", (d) => (shaOut += d));
      get.on("error", () => jsonOut({ ok: true, pushed: false, generated_at: generatedAt, error: "gh 不可用：已重排但未上传" }));
      get.on("close", (gcode) => {
        const putBody = { message: "重建艾宾浩斯日历（网页触发）", content: b64 };
        if (gcode === 0 && shaOut.trim()) putBody.sha = shaOut.trim();
        const put = spawn("gh", ["api", "-X", "PUT", "repos/Yaaaccc/english-word-dictation/contents/calendar/calendar.json", "--input", "-"], { cwd: DIR });
        let responded = false;
        put.stdout.on("data", () => (responded = true));
        put.on("error", () => jsonOut({ ok: true, pushed: false, generated_at: generatedAt, error: "gh 不可用：已重排但未上传" }));
        put.on("close", (pcode) => {
          jsonOut({ ok: true, pushed: pcode === 0 && responded, generated_at: generatedAt, error: pcode === 0 ? null : "gh 推送失败（退出码 " + pcode + "）" });
        });
        put.stdin.write(JSON.stringify(putBody));
        put.stdin.end();
      });
    });
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
