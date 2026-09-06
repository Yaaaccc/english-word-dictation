#!/usr/bin/env node
/*
 * 不背单词生词本抓取
 * 从 www.bbdc.cn/api/user-new-word 抓取“生词本”数据（单词、词性释义、例句英中、音标），
 * 保存为 bubei-YYYY-MM-DD.txt（与扇贝日期文件格式兼容，前缀 bubei- 避免互相覆盖），
 * 供 word-dictation.html 切换来源后导入。
 *
 * 用法：
 *   node grab-bubei.js              抓取今日新增的生词（没有则退回全部生词本）
 *   node grab-bubei.js --all        抓取全部生词本
 *   node grab-bubei.js --date=2026-08-08   抓取指定日期新增的生词
 *   node grab-bubei.js --debug      打印第一页原始数据结构（排查用）
 *   node grab-bubei.js --test-cdp   自检 Edge 调试连接（不抓词）
 *
 * 首次运行会打开一个 Edge 窗口，只需要在 bbdc.cn 网页登录一次（手机验证码或微信扫码）；
 * 登录信息保存在 bubei-auth.json（仅本机文件，勿提交到 git）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

const DIR = __dirname;
const AUTH_FILE = path.join(DIR, "bubei-auth.json");
const PROFILE_DIR = path.join(DIR, ".bubei-profile");
const OUT_FILE = path.join(DIR, "bubei-words.txt");
const API_HOST = "www.bbdc.cn";
const CDP_PORT = 9224;
const TARGET_URL = "https://www.bbdc.cn/newword";

const DEBUG = process.argv.includes("--debug");
const TEST_CDP = process.argv.includes("--test-cdp");
const ALL_MODE = process.argv.includes("--all");
const HEADLESS = process.env.GRAB_HEADLESS === "1";

let dateArg = null;
for (const a of process.argv) {
  if (a.indexOf("--date=") === 0) dateArg = a.slice("--date=".length).trim();
}

const EDGE_CANDIDATES = [
  process.env["ProgramFiles(x86)"] + "\\Microsoft\\Edge\\Application\\msedge.exe",
  process.env.ProgramFiles + "\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findEdge() {
  for (const p of EDGE_CANDIDATES) {
    if (p && fs.existsSync(p)) return p;
  }
  return "msedge";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AuthError extends Error {}

/* ---------------- HTTP ---------------- */

function httpsGet(apiPath, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: API_HOST,
        path: apiPath,
        method: "GET",
        headers: {
          Cookie: cookie,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function fetchApi(apiPath, params, cookie) {
  const qs = new URLSearchParams(params || {}).toString();
  const { status, body } = await httpsGet(apiPath + (qs ? "?" + qs : ""), cookie);
  if (status !== 200) throw new Error("接口返回 HTTP " + status);
  let j;
  try {
    j = JSON.parse(body);
  } catch (e) {
    throw new Error("接口返回无法解析：" + body.slice(0, 120));
  }
  if (j.result_code !== 200) {
    const msg = (j.error_body && (j.error_body.user_message || j.error_body.info)) || ("result_code=" + j.result_code);
    if (String(j.result_code) === "20000") throw new AuthError("登录已失效或未登录（" + msg + "）");
    throw new Error("接口错误：" + msg);
  }
  return j.data_body || {};
}

/* ---------------- 数据提取 ---------------- */

function cleanHtml(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanMeaning(s) {
  return String(s || "")
    .replace(/\r?\n/g, "；")
    .replace(/[；;]{2,}/g, "；")
    .replace(/\s+/g, " ")
    .trim();
}

function parseUpdatetime(v) {
  if (!v) return null;
  const s = String(v);
  // 兼容 "2026-08-09 12:34:56" / "2026-08-09" / Unix 秒时间戳
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  const n = Number(s);
  if (isFinite(n) && n > 0) {
    const d = new Date(n * 1000);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + mm + "-" + dd;
  }
  return null;
}

function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

function pickSentence(item) {
  const list = (item && Array.isArray(item.sentenceList)) ? item.sentenceList : [];
  const withCn = list.find((s) => s && s.originalContext && s.translationContext);
  const any = list.find((s) => s && s.originalContext);
  const s = withCn || any;
  if (!s) return { en: "", cn: "" };
  return {
    en: cleanHtml(s.originalContext),
    cn: cleanHtml(s.translationContext || ""),
  };
}

function extractWords(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const word = String(item.word || "").trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const sent = pickSentence(item);
    out.push({
      word: word,
      meaning: cleanMeaning(item.interpret),
      exampleEn: sent.en,
      exampleCn: sent.cn,
      addedDate: parseUpdatetime(item.updatetime),
    });
  }
  return out;
}

function formatWordLine(w) {
  const parts = [w.word, w.meaning || "", w.exampleEn || "", w.exampleCn || ""];
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.join("|");
}

/* ---------------- 抓取 ---------------- */

async function fetchAllWords(cookie) {
  const all = [];
  let page = 0;
  let totalPage = 1;
  for (let guard = 0; guard < 200; guard++) {
    const data = await fetchApi(
      "/api/user-new-word",
      { page: page, time: Math.floor(Date.now() / 1000) },
      cookie
    );
    if (DEBUG) {
      console.log("page=" + page + " wordList=" + ((data.wordList || []).length) + " pageInfo=" + JSON.stringify(data.pageInfo || {}));
      if (page === 0) console.log("sample: " + JSON.stringify((data.wordList || [])[0] || {}).slice(0, 800));
    }
    all.push(...extractWords(data.wordList));
    const info = data.pageInfo || {};
    totalPage = Number(info.totalPage) || 1;
    if (page >= totalPage - 1 || !Array.isArray(data.wordList) || data.wordList.length === 0) break;
    page++;
    await sleep(400);
  }
  const seen = new Set();
  return all.filter((w) => {
    const k = w.word.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function filterByDate(words, date) {
  return words.filter((w) => w.addedDate === date);
}

/* ---------------- 登录信息存取 ---------------- */

function loadAuth() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    return j && j.cookie ? j.cookie : null;
  } catch (e) {
    return null;
  }
}

function saveAuth(cookie) {
  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify({ cookie: cookie, saved_at: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

async function checkToken(cookie) {
  try {
    await fetchApi("/api/user-new-word", { page: 0 }, cookie);
    return true;
  } catch (e) {
    if (e instanceof AuthError) return false;
    throw e;
  }
}

/* ---------------- CDP 浏览器 ---------------- */

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
  });
}

function cdpSession(wsUrl) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      reject(e);
      return;
    }
    let nextId = 1;
    const pending = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    };
    ws.onerror = () => {
      for (const p of pending.values()) p({ error: true });
      pending.clear();
    };
    ws.onopen = () =>
      resolve({
        send(method, params) {
          return new Promise((res) => {
            const id = nextId++;
            pending.set(id, res);
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        close() {
          try {
            ws.close();
          } catch (e) {}
        },
      });
  });
}

async function findPageTarget() {
  for (let i = 0; i < 150; i++) {
    try {
      const list = await getJson("http://127.0.0.1:" + CDP_PORT + "/json/list");
      const page = list.find((t) => t.type === "page");
      if (page) return page;
    } catch (e) {
      /* 浏览器还没就绪 */
    }
    await sleep(1000);
  }
  throw new Error("无法连接浏览器调试端口（" + CDP_PORT + "），请关闭占用该端口的程序后重试");
}

function launchEdge(extraArgs) {
  const args = [
    "--remote-debugging-port=" + CDP_PORT,
    "--no-first-run",
    "--no-default-browser-check",
    ...extraArgs,
  ];
  if (HEADLESS) args.unshift("--headless=new");
  const child = spawn(findEdge(), args, { detached: true, stdio: "ignore" });
  child.unref();
  child.on("error", (e) => {
    throw new Error("无法启动 Edge：" + e.message);
  });
  return child;
}

function buildCookie(cookies) {
  return cookies
    .filter((c) => c && c.name && c.value && c.domain && c.domain.indexOf("bbdc.cn") !== -1)
    .map((c) => c.name + "=" + c.value)
    .join("; ");
}

async function getAuthViaBrowser() {
  console.log("正在打开不背单词网页版，第一次需要你在弹出的窗口中登录一次（手机验证码或微信扫码）…");
  const child = launchEdge(["--user-data-dir=" + PROFILE_DIR, TARGET_URL]);
  const page = await findPageTarget();
  const cdp = await cdpSession(page.webSocketDebuggerUrl);
  console.log("等待登录（最长 15 分钟），登录成功后会自动继续…");
  for (let i = 0; i < 450; i++) {
    const r = await cdp.send("Network.getAllCookies");
    const cookies = (r.result && r.result.cookies) || [];
    const cookie = buildCookie(cookies);
    if (cookie) {
      try {
        if (await checkToken(cookie)) {
          cdp.close();
          if (!HEADLESS) {
            try {
              child.kill();
            } catch (e) {}
          }
          console.log("检测到登录成功。");
          return cookie;
        }
      } catch (e) {
        /* 继续等待 */
      }
    }
    if (i > 0 && i % 45 === 0) {
      console.log("  还没检测到登录状态，请在弹出的浏览器窗口完成登录…");
    }
    await sleep(2000);
  }
  throw new Error("等待登录超时（15 分钟）");
}

async function testCdp() {
  console.log("自检：启动 Edge（无头模式）并验证调试连接…");
  const testProfile = path.join(os.tmpdir(), "bubei-cdp-test-" + Date.now());
  const child = launchEdge(["--user-data-dir=" + testProfile, "https://example.com"]);
  try {
    const page = await findPageTarget();
    console.log("目标页面:", page.url);
    const cdp = await cdpSession(page.webSocketDebuggerUrl);
    let value = "";
    for (let i = 0; i < 20; i++) {
      const r = await cdp.send("Runtime.evaluate", {
        expression: "document.title + ' | ' + location.href",
        returnByValue: true,
      });
      value = r.result && r.result.result && r.result.result.value;
      if (value && value.indexOf("about:blank") === -1) break;
      await sleep(1000);
    }
    console.log("浏览器连接正常，页面标题：", value);
    cdp.close();
    console.log("自检通过。");
  } finally {
    try {
      child.kill();
    } catch (e) {}
    setTimeout(() => {
      try {
        fs.rmSync(testProfile, { recursive: true, force: true });
      } catch (e) {}
    }, 1500);
  }
}

/* ---------------- 主流程 ---------------- */

(async () => {
  if (TEST_CDP) {
    await testCdp();
    return;
  }

  console.log("== 不背单词生词本抓取 ==");
  let cookie = loadAuth();
  if (!cookie) {
    cookie = await getAuthViaBrowser();
    saveAuth(cookie);
    console.log("登录信息已保存到 " + AUTH_FILE + "（仅本机使用）");
  } else {
    console.log("使用已保存的登录信息…");
    const ok = await checkToken(cookie);
    if (!ok) {
      console.log("登录已过期，需要重新登录。");
      cookie = await getAuthViaBrowser();
      saveAuth(cookie);
    }
  }

  console.log("正在拉取生词本…");
  const words = await fetchAllWords(cookie);
  if (words.length === 0) {
    console.log("生词本为空，没有可导出的单词。");
    process.exit(1);
  }

  const date = dateArg || todayStr();
  let selected = ALL_MODE ? words : filterByDate(words, date);
  let modeNote = "";
  if (!ALL_MODE && selected.length === 0) {
    selected = words;
    modeNote = "（今天暂无新增生词，已退回全部生词本）";
  }
  if (selected.length === 0) {
    console.log("没有可导出的单词。");
    process.exit(1);
  }

  const lines = selected.map(formatWordLine);
  const dailyFile = path.join(DIR, "bubei-" + date + ".txt");
  fs.writeFileSync(dailyFile, lines.join("\n"), "utf8");
  fs.writeFileSync(OUT_FILE, lines.join("\n"), "utf8");
  console.log("完成！" + (ALL_MODE ? "全部生词本" : date + " 新增生词") + " " + selected.length + " 个已保存到：");
  console.log("  " + dailyFile + modeNote);
  console.log("网页端在「来源」里切换到「不背单词」即可按日期听写。");
  if (DEBUG) {
    console.log("前 5 个：");
    selected.slice(0, 5).forEach((w) => console.log("  " + w.word + " → " + (w.meaning || "(无释义)")));
  }
})().catch((e) => {
  if (e instanceof AuthError) console.error("登录失效：" + e.message);
  else console.error("出错：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
