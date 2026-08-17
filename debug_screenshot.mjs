import puppeteer from "puppeteer";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

// One-off debug utility: launches the real dashboard on a real network
// (unlike the sandboxed local dev environment), waits for the Binance chart
// to receive live data, and prints a base64 JPEG plus WebSocket diagnostics
// to stdout so both can be pulled out of deploy logs. Not part of the
// production pipeline.

const ROOT = path.resolve(".");
const server = http.createServer(async (req, res) => {
  const filePath = req.url.split("?")[0];
  const full = path.join(ROOT, filePath === "/" ? "index.html" : filePath);
  try {
    const body = await readFile(full);
    res.writeHead(200);
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

page.on("console", (msg) => {
  console.log(`[PAGE_CONSOLE:${msg.type()}] ${msg.text()}`);
});
page.on("pageerror", (err) => {
  console.log(`[PAGE_ERROR] ${err.message}`);
});
page.on("requestfailed", (req) => {
  console.log(`[REQUEST_FAILED] ${req.url()} - ${req.failure()?.errorText}`);
});

// Wrap the native WebSocket so we can see connection lifecycle events
// without changing the dashboard's actual behavior at all.
await page.evaluateOnNewDocument(() => {
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      console.log(`[WS_DEBUG] constructing WebSocket(${args[0]})`);
      const ws = new target(...args);
      ws.addEventListener("open", () => console.log("[WS_DEBUG] open"));
      ws.addEventListener("close", (e) => console.log(`[WS_DEBUG] close code=${e.code} reason=${e.reason}`));
      ws.addEventListener("error", (e) => console.log(`[WS_DEBUG] error ${JSON.stringify(e && e.message)}`));
      return ws;
    },
  });
});

await page.goto(`http://127.0.0.1:${port}/index.html`, {
  waitUntil: "networkidle0",
  timeout: 30_000,
});

// Give the Binance WebSocket time to connect, retry, and receive a kline.
await new Promise((r) => setTimeout(r, 25_000));

const status = await page.evaluate(() => ({
  connectionStatus: document.getElementById("connection-status")?.textContent,
  price: document.getElementById("btc-price")?.textContent,
}));
console.log(`[FINAL_STATUS] ${JSON.stringify(status)}`);

const buffer = await page.screenshot({ type: "jpeg", quality: 55 });
console.log("SCREENSHOT_BASE64_START");
console.log(buffer.toString("base64"));
console.log("SCREENSHOT_BASE64_END");

await browser.close();
server.close();
process.exit(0);
