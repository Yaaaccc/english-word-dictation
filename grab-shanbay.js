#!/usr/bin/env node
/*
 * 扇贝单词抓取
 * 从 apiv3.shanbay.com 拉取今日学习单词（新词 NEW + 复习 REVIEW），
 * 解密后保存为 shanbay-words.txt，供 word-dictation.html 导入。
 *
 * 用法：
 *   node grab-shanbay.js             抓取今日单词
 *   node grab-shanbay.js --debug     抓取并打印第一条原始数据（排查用）
 *   node grab-shanbay.js --test-cdp  自检浏览器调试连接（不抓单词）
 *
 * 首次运行会打开一个 Edge 窗口，只需要登录一次扇贝；
 * 登录信息保存在 shanbay-auth.json（仅本机文件，勿提交到 git）。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");

const bays4 = require("./bays4.js");

const DIR = __dirname;
const AUTH_FILE = path.join(DIR, "shanbay-auth.json");
const PROFILE_DIR = path.join(DIR, ".shanbay-profile");
const OUT_FILE = path.join(DIR, "shanbay-words.txt");
const HISTORY_FILE = path.join(DIR, "shanbay-history.json");
const HISTORY_DAYS = parseInt(process.env.HISTORY_DAYS || "2", 10);
const API_HOST = "apiv3.shanbay.com";
const CDP_PORT = 9223;
const TARGET_URL = "https://web.shanbay.com/wordsweb/#/words-table";

const DEBUG = process.argv.includes("--debug");
const TEST_CDP = process.argv.includes("--test-cdp");
const HEADLESS = process.env.GRAB_HEADLESS === "1";

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
class SyncError extends Error {}

/* ---------------- HTTP ---------------- */

function httpsGet(apiPath, token, method) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: API_HOST,
        path: apiPath,
        method: method || "GET",
        headers: {
          Cookie: "auth_token=" + token,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
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

async function fetchApi(apiPath, params, token, method) {
  const qs = new URLSearchParams(params).toString();
  const { status, body } = await httpsGet(apiPath + "?" + qs, token, method);
  if (status === 401 || status === 403) throw new AuthError("登录已失效（HTTP " + status + "）");
  if (status === 412) throw new SyncError("今日任务尚未生成（HTTP 412）");
  if (status !== 200) throw new Error("接口返回 HTTP " + status);
  let j;
  try {
    j = JSON.parse(body);
  } catch (e) {
    throw new Error("接口返回无法解析：" + body.slice(0, 120));
  }
  if (j.code !== undefined && j.code !== 0 && String(j.code) !== "0" && String(j.code) !== "200") {
    throw new Error("接口错误 code=" + j.code + (j.msg ? " " + j.msg : ""));
  }
  let data = j && j.data !== undefined ? j.data : j;
  if (typeof data === "string") {
    let decrypted;
    try {
      decrypted = bays4.d(data);
    } catch (e) {
      throw new Error("解密失败：" + e.message);
    }
    try {
      data = JSON.parse(decrypted);
    } catch (e) {
      throw new Error("解密结果不是 JSON");
    }
  }
  return data;
}

async function fetchWithSync(apiPath, params, token, mid) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await fetchApi(apiPath, params, token);
    } catch (e) {
      if (!(e instanceof SyncError)) throw e;
      if (mid) {
        try {
          await fetchApi("/wordsapp/user_material_books/" + mid + "/learning/items/sync", {}, token);
        } catch (e2) {}
      }
      await sleep(800);
    }
  }
  // 同步仍失败：尝试生成今日任务（next_turn）
  if (mid) {
    try {
      await fetchApi("/wordsapp/user_material_books/" + mid + "/learning/next_turn", {}, token, "POST");
    } catch (e3) {}
    await sleep(1200);
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await fetchApi(apiPath, params, token);
      } catch (e4) {
        if (!(e4 instanceof SyncError)) throw e4;
        await sleep(1000);
      }
    }
  }
  throw new Error("今日任务生成超时（接口多次返回 412）");
}

/* ---------------- 数据提取 ---------------- */

function extractWords(objects) {
  const seen = new Set();
  const out = [];
  for (const obj of objects || []) {
    const v = (obj && (obj.vocab_with_senses || obj.vocabulary || obj)) || {};
    let word = v.word || v.content || v.vocab || "";
    word = String(word).trim();
    if (!word) continue;
    const meanings = [];
    if (Array.isArray(v.senses)) {
      for (const s of v.senses) {
        const cn = (s && (s.definition_cn || s.cn || s.definition)) || "";
        const pos = s && s.pos ? String(s.pos).replace(/\.+$/, "") + ". " : "";
        if (String(cn).trim()) meanings.push((pos + cn).trim());
      }
    }
    if (meanings.length === 0 && v.definition) meanings.push(String(v.definition));
    if (meanings.length === 0 && v.translation) meanings.push(String(v.translation));
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ word, meaning: meanings.join("；"), id: v.id || "" });
  }
  return out;
}

function dedupe(words) {
  const seen = new Set();
  return words.filter((w) => {
    const k = w.word.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function getCurrentBook(token) {
  const data = await fetchApi("/wordsapp/user_material_books", {}, token);
  const book = data && data.objects && data.objects[0];
  const mb = (book && book.materialbook) || {};
  if (!mb.id) throw new Error("没有找到当前单词书");
  return { mid: mb.id, dictId: mb.dictionary_id || "" };
}

async function fetchToday(token, mid, type) {
  const words = [];
  type = type || "NEW"; // NEW=今日新词，REVIEW=今日复习词
  let page = 1;
  while (page <= 10) {
    const data = await fetchWithSync(
      "/wordsapp/user_material_books/" + mid + "/learning/words/today_learning_items",
      { page, type_of: type, ipp: 50 },
      token,
      mid
    );
    if (DEBUG) {
      console.log(
        "type=" + type + " page=" + page + " objects=" + ((data.objects || []).length) + " total=" + data.total
      );
      console.log("sample: " + JSON.stringify((data.objects || [])[0] || {}).slice(0, 600));
    }
    words.push(...extractWords(data.objects));
    if (!data.objects || data.objects.length === 0) break;
    page++;
  }
  return dedupe(words);
}

async function fetchFallback(token, mid) {
  const words = [];
  let page = 1;
  while (page <= 30) {
    const data = await fetchWithSync(
      "/wordsapp/user_material_books/" + mid + "/learning/words/unlearned_items",
      { page, ipp: 50, order: "DESC" },
      token,
      mid
    );
    words.push(...extractWords(data.objects));
    if (!data.objects || data.objects.length === 0) break;
    page++;
  }
  return dedupe(words);
}

async function fetchExamples(words, dictId, token) {
  const byId = {};
  words.forEach(function (w) { if (w.id) byId[w.id] = w; });
  const ids = Object.keys(byId);
  const CHUNK = 20;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK).join(",");
    let data;
    try {
      data = await fetchApi("/wordsapp/words/vocab_examples", { vocab_ids: chunk, dict_id: dictId }, token);
    } catch (e) {
      continue;
    }
    const objs = data && data.objects ? data.objects : [];
    objs.forEach(function (o) {
      const w = byId[o.vocab_id];
      if (!w) return;
      const ex = (o.examples || []).filter(function (e) { return e && e.content_en; })[0];
      if (ex) {
        w.exampleEn = String(ex.content_en).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
        w.exampleCn = String(ex.content_cn || "").trim();
      }
    });
  }
  return words;
}

async function fetchPhrases(words, token) {
  for (const w of words) {
    if (!w.id) continue;
    let data;
    try {
      data = await fetchApi("/wordsapp/user_vocab_notes/note_detail/agg", { vocab_id: w.id }, token);
    } catch (e) {
      continue;
    }
    const notes = data && data.objects ? data.objects : [];
    const seen = new Set();
    const phrases = [];
    const official = [];
    for (const n of notes) {
      const content = String(n.content || "").trim();
      if (!content) continue;
      // 官方笔记：type 2 + official_ext.label（图片跳过）
      if (n.type === 2 && n.official_ext && n.official_ext.label) {
        const label = String(n.official_ext.label).trim();
        if (label && label !== "图片" && content.indexOf("http") !== 0) {
          const clean = content.replace(/\*\*/g, "").replace(/\r?\n/g, "；").replace(/；+/g, "；").replace(/^；|；$/g, "").trim();
          if (clean) official.push("【" + label + "】" + clean);
        }
        continue;
      }
      // 用户短语（沿用启发式）
      if (content.indexOf("\n") !== -1) continue;
      const m = content.match(/^([A-Za-z][A-Za-z0-9'’\-]*(?: [A-Za-z0-9'’\-]+){1,3})\s+([\u4e00-\u9fff].*)$/);
      if (!m) continue;
      const en = m[1].replace(/\s+/g, " ").trim();
      const key = en.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const cn = m[2].replace(/\s+/g, " ").trim();
      phrases.push(en + " " + cn);
      if (phrases.length >= 5) break;
    }
    w.phrases = phrases;
    w.diff = official.slice(0, 4).join("；");
  }
  return words;
}

function formatWordLine(w) {
  const parts = [w.word, w.meaning || "", w.exampleEn || "", w.exampleCn || "", (w.phrases || []).join("；"), w.diff || ""];
  while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.join("|");
}

function saveWords(words) {
  fs.writeFileSync(OUT_FILE, words.map(formatWordLine).join("\n"), "utf8");
}

function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}

function saveHistory(h) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2), "utf8");
}

function mergeHistory(history) {
  const seen = new Set();
  const out = [];
  for (const day of history) {
    for (const line of day.words || []) {
      const word = String(line).split("|")[0].trim().toLowerCase();
      if (!word || seen.has(word)) continue;
      seen.add(word);
      out.push(line);
    }
  }
  return out;
}

/* ---------------- 登录信息存取 ---------------- */

function loadAuth() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    return j && j.auth_token ? j.auth_token : null;
  } catch (e) {
    return null;
  }
}

function saveAuth(token) {
  fs.writeFileSync(
    AUTH_FILE,
    JSON.stringify({ auth_token: token, saved_at: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

async function checkToken(token) {
  try {
    await fetchApi(
      "/wordscollection/learning/words/today_learning_items",
      { page: 1, type_of: "NEW", ipp: 1 },
      token
    );
    return true;
  } catch (e) {
    if (e instanceof AuthError) return false;
    if (e instanceof SyncError) return true; // 任务未生成不算登录问题
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

async function findPageTargetByUrl(urlPart) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await getJson("http://127.0.0.1:" + CDP_PORT + "/json/list");
      const page = list.find((t) => t.type === "page" && t.url.indexOf(urlPart) !== -1);
      if (page) return page;
    } catch (e) {
      /* 还没就绪 */
    }
    await sleep(1000);
  }
  throw new Error("等待页面超时：" + urlPart);
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

async function getAuthTokenViaBrowser() {
  console.log("正在打开扇贝页面，第一次需要你在弹出的窗口中登录一次…");
  const child = launchEdge(["--user-data-dir=" + PROFILE_DIR, TARGET_URL]);
  const page = await findPageTarget();
  const cdp = await cdpSession(page.webSocketDebuggerUrl);
  console.log("等待登录（最多 5 分钟），登录成功后会自动继续…");
  for (let i = 0; i < 150; i++) {
    const r = await cdp.send("Network.getAllCookies");
    const cookies = (r.result && r.result.cookies) || [];
    const tok = cookies.find((c) => c.name === "auth_token");
    if (tok && tok.value) {
      cdp.close();
      if (!HEADLESS) {
        try {
          child.kill();
        } catch (e) {}
      }
      console.log("检测到登录成功。");
      return tok.value;
    }
    if (i > 0 && i % 30 === 0) {
      console.log("  还没检测到登录状态，请在弹出的浏览器窗口完成登录…");
    }
    await sleep(2000);
  }
  throw new Error("等待登录超时（5 分钟）");
}

async function testCdp() {
  console.log("自检：启动 Edge（无头模式）并验证调试连接…");
  const testProfile = path.join(os.tmpdir(), "shanbay-cdp-test-" + Date.now());
  const child = launchEdge(["--user-data-dir=" + testProfile, "https://example.com"]);
  try {
    const page = await findPageTargetByUrl("example.com");
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

  console.log("== 扇贝单词抓取 ==");
  let token = loadAuth();
  if (!token) {
    token = await getAuthTokenViaBrowser();
    saveAuth(token);
    console.log("登录信息已保存到 " + AUTH_FILE + "（仅本机使用）");
  } else {
    console.log("使用已保存的登录信息…");
    const ok = await checkToken(token);
    if (!ok) {
      console.log("登录已过期，需要重新登录。");
      token = await getAuthTokenViaBrowser();
      saveAuth(token);
    }
  }

  console.log("正在拉取今日新词（每天单独保存为一个日期文件）…");
  const book = await getCurrentBook(token);
  let words = await fetchToday(token, book.mid);
  if (words.length === 0) {
    console.log("今日任务暂无单词，改用「正在学习 + 未学习」词表…");
    words = await fetchFallback(token, book.mid);
  }
  if (words.length === 0) {
    console.log("没有获取到任何单词（可能今天还没有学习任务）。");
    process.exit(1);
  }
  if (book.dictId) {
    console.log("正在获取例句…");
    words = await fetchExamples(words, book.dictId, token);
  }
  console.log("正在获取短语…");
  words = await fetchPhrases(words, token);

  const today = todayStr();
  const lines = words.map(formatWordLine);
  const dailyFile = path.join(DIR, today + ".txt");
  fs.writeFileSync(dailyFile, lines.join("\n"), "utf8");
  fs.writeFileSync(OUT_FILE, lines.join("\n"), "utf8");
  console.log("完成！今日 " + words.length + " 个新词（含例句、短语、辨析）已保存到：" + dailyFile);

  // 今日复习词（REVIEW），单独保存为 shanbay-review-日期.txt，与新词互不覆盖
  let reviewWords = [];
  try {
    reviewWords = await fetchToday(token, book.mid, "REVIEW");
  } catch (e) {
    console.log("获取复习词失败（已跳过）：" + e.message);
  }
  if (reviewWords.length > 0) {
    if (book.dictId) {
      reviewWords = await fetchExamples(reviewWords, book.dictId, token);
    }
    reviewWords = await fetchPhrases(reviewWords, token);
    const reviewLines = reviewWords.map(formatWordLine);
    const reviewFile = path.join(DIR, "shanbay-review-" + today + ".txt");
    fs.writeFileSync(reviewFile, reviewLines.join("\n"), "utf8");
    fs.writeFileSync(path.join(DIR, "shanbay-review-words.txt"), reviewLines.join("\n"), "utf8");
    console.log("今日复习词 " + reviewWords.length + " 个已保存到：" + reviewFile);
  } else {
    console.log("今日暂无复习词（REVIEW 为空）。");
  }

  console.log("历史日期文件会保留在文件夹里，网页端可选择任意日期听写。");
  if (DEBUG) {
    console.log("前 5 个：");
    words.slice(0, 5).forEach((w) =>
      console.log("  " + w.word + " → " + (w.meaning || "(无释义)"))
    );
  }
})().catch((e) => {
  if (e instanceof AuthError) console.error("登录失效：" + e.message);
  else console.error("出错：" + (e && e.stack ? e.stack : e));
  process.exit(1);
});
