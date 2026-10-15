#!/usr/bin/env node
/**
 * scripts/measure-ui.js — measure the rendered layout of frontend/index.html.
 *
 * Launches a headless Edge/Chrome with a remote-debugging port, drives it over the
 * DevTools protocol with plain WebSocket frames (no dependency on puppeteer), and prints
 * the layout facts that are impossible to judge by reading CSS: document height, table
 * column widths, whether any cell overflows or wraps, and the first-viewport composition.
 *
 * Requires the wider sandbox mode, because Chromium's IPC needs named pipes.
 *
 *   node scripts/measure-ui.js
 *   node scripts/measure-ui.js --width 1280 --height 900
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const WIDTH = Number(argOf("width", 1440));
const HEIGHT = Number(argOf("height", 900));
const PORT = Number(argOf("port", 9333));

const BROWSERS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

function findBrowser() {
  for (const b of BROWSERS) if (fs.existsSync(b)) return b;
  throw new Error("no Chromium-family browser found");
}

function httpJson(urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: urlPath, timeout: 4000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function waitForDevtools(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await httpJson("/json/version"); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("devtools endpoint never came up");
}

/** Minimal CDP client over the WebSocket in the global WebSocket (Node 22+). */
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    });
    ws.addEventListener("error", (e) => reject(new Error("ws error: " + (e.message || "unknown"))));
    ws.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          const myId = ++id;
          return new Promise((res, rej) => {
            pending.set(myId, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: myId, method, params }));
          });
        },
        close() { try { ws.close(); } catch { /* ignore */ } },
      })
    );
  });
}

const MEASURE_JS = `(() => {
  const px = (n) => Math.round(n * 10) / 10;
  const out = { viewport: { w: innerWidth, h: innerHeight } };

  out.documentHeight = Math.round(document.documentElement.scrollHeight);

  // first-viewport composition: what is visible before scrolling
  const marks = [
    ['.topbar', 'topbar'], ['.mode-banner', 'demo banner'], ['.hero', 'hero band'],
    ['.kpi-strip', 'KPI strip'], ['#panel-supply', 'supply panel'], ['#panel-borrow', 'borrow panel'],
    ['#panel-loans', 'loan book'], ['#panel-position', 'position'], ['#panel-settings', 'parameters'],
  ];
  out.composition = marks.map(([sel, name]) => {
    const el = document.querySelector(sel);
    if (!el) return { name, missing: true };
    const r = el.getBoundingClientRect();
    return { name, top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
             inFirstViewport: r.top < innerHeight };
  });

  // any element whose content is wider than its box, or clipped
  out.overflow = [];
  for (const el of document.querySelectorAll('main *, .topbar *, .mode-banner *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      out.overflow.push({ tag: el.tagName.toLowerCase(), cls: el.className.toString().slice(0, 40),
                          clientW: el.clientWidth, scrollW: el.scrollWidth });
    }
  }
  out.overflow = out.overflow.slice(0, 12);

  // table geometry
  out.tables = [...document.querySelectorAll('table')].map((t, i) => {
    const wrap = t.closest('.table-scroll, .table-wrap');
    const head = [...t.querySelectorAll('thead th')].map((th) => ({
      label: th.textContent.trim().slice(0, 16),
      cls: th.className,
      w: px(th.getBoundingClientRect().width),
    }));
    // Measure each cell's text against the cell's box. td.scrollWidth is useless here
    // (table cells report their parent, not their content), so measure the text with a
    // throwaway nowrap span and compare.
    const ruler = document.createElement('span');
    ruler.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font:inherit;';
    document.body.appendChild(ruler);
    const tight = [];
    for (const tr of [...t.querySelectorAll('tbody tr')].slice(0, 3)) {
      for (const td of tr.querySelectorAll('td')) {
        const text = td.textContent.trim().replace(/\s+/g, ' ');
        if (!text || td.classList.contains('col-detail')) continue; // detail may wrap
        ruler.style.font = getComputedStyle(td).font;
        ruler.textContent = text;
        const need = Math.ceil(ruler.getBoundingClientRect().width);
        const avail = Math.floor(td.getBoundingClientRect().width);
        const style = getComputedStyle(td);
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const inner = avail - padding;
        if (need > inner + 1) {
          tight.push({ text: text.slice(0, 38), need, inner, short: need - inner });
        }
      }
    }
    ruler.remove();
    return {
      index: i,
      cls: t.className,
      width: px(t.getBoundingClientRect().width),
      wrapClientW: wrap ? wrap.clientWidth : null,
      scrollW: wrap ? wrap.scrollWidth : null,
      horizontallyScrolls: wrap ? wrap.scrollWidth > wrap.clientWidth + 1 : null,
      scrollExcess: wrap ? Math.max(0, wrap.scrollWidth - wrap.clientWidth) : 0,
      headers: head,
      tightCells: tight.slice(0, 8),
    };
  });

  // modal styling sanity (rendered only on demand, so check the rule instead)
  out.modalRule = (() => {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) if (r.selectorText === '#modal-root') return r.style.position || null;
    }
    return null;
  })();

  return out;
})()`;

(async () => {
  const browser = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ml-measure-"));
  const page = "file:///" + path.join(ROOT, "frontend", "index.html").replace(/\\/g, "/");

  const child = spawn(browser, [
    "--headless=new",
    "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    page,
  ], { stdio: "ignore" });

  let cdp;
  try {
    await waitForDevtools(20000);
    const targets = await httpJson("/json/list");
    const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl)
      || targets.find((t) => t.webSocketDebuggerUrl);
    if (!target) throw new Error("no page target");

    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");
    // let the app boot, seed demo data, animate and swap fonts
    await new Promise((r) => setTimeout(r, 3500));
    const res = await cdp.send("Runtime.evaluate", {
      expression: MEASURE_JS, returnByValue: true, awaitPromise: false,
    });
    const data = res.result.value;

    console.log(`viewport           ${data.viewport.w} x ${data.viewport.h}`);
    console.log(`document height    ${data.documentHeight}px`);
    console.log(`#modal-root rule   position: ${data.modalRule}`);
    console.log("");
    console.log("first-viewport composition (document offset -> visible without scrolling)");
    for (const c of data.composition) {
      if (c.missing) { console.log(`  ${c.name.padEnd(16)} MISSING`); continue; }
      console.log(`  ${c.name.padEnd(16)} top ${String(c.top).padStart(5)}  h ${String(c.height).padStart(4)}  ${c.inFirstViewport ? "IN viewport" : "-- below fold"}`);
    }
    console.log("");
    console.log("tables");
    for (const t of data.tables) {
      console.log(`  table ${t.index}  width ${t.width}px  wrap ${t.wrapClientW}px  h-scrolls: ${t.horizontallyScrolls}${t.scrollExcess ? " (+" + t.scrollExcess + "px)" : ""}  tight cells: ${t.tightCells.length}`);
      console.log("    " + t.headers.map((h) => `${h.label || "(blank)"}=${h.w}${h.cls ? "[" + h.cls + "]" : ""}`).join("  "));
      for (const c of t.tightCells) console.log(`      TIGHT needs ${c.need}px, has ${c.inner}px (short ${c.short})  "${c.text}"`);
    }
    console.log("");
    if (data.overflow.length) {
      console.log("content overflowing its box");
      for (const o of data.overflow) console.log(`  ${o.tag}.${o.cls}  client ${o.clientW} < scroll ${o.scrollW}`);
    } else {
      console.log("content overflowing its box: none");
    }
    process.exitCode = 0;
  } catch (err) {
    console.error("measure failed:", err.message);
    process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    try { child.kill(); } catch { /* ignore */ }
  }
})();
