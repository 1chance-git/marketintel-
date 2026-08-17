import puppeteer from "puppeteer";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

// One-off debug utility: launches the real dashboard on a real network
// (unlike the sandboxed local dev environment), waits for the Binance chart
// to receive live data, and prints a base64 JPEG to stdout so it can be
// pulled out of deploy logs. Not part of the production pipeline.

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

await page.goto(`http://127.0.0.1:${port}/index.html`, {
  waitUntil: "networkidle0",
  timeout: 30_000,
});

// Give the Binance WebSocket time to connect and receive at least one kline.
await new Promise((r) => setTimeout(r, 15_000));

const buffer = await page.screenshot({ type: "jpeg", quality: 55 });
console.log("SCREENSHOT_BASE64_START");
console.log(buffer.toString("base64"));
console.log("SCREENSHOT_BASE64_END");

await browser.close();
server.close();
process.exit(0);
