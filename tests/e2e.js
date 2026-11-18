// Browser walkthrough against a running server (Playwright). Usage: node tests/e2e.js http://localhost:3000
const { chromium } = require("playwright");
const path = require("node:path");
const base = process.argv[2] || "http://localhost:3000";
const shots = process.argv[3] || path.join(__dirname, "..", "data");

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push("pageerror: " + e.message));
  p.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text()); });
  const step = (name, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  const clickItem = async name => { await p.locator("[data-add]", { hasText: name }).first().click(); await p.waitForTimeout(120); };

  await p.goto(base); await p.waitForSelector("#setupForm");
  step("first run shows setup with brand", (await p.textContent(".brand-name")).includes("Butter Bunny"));
  await p.fill("#su-name", "นุ่น"); await p.fill("#su-pin", "1234"); await p.fill("#su-pin2", "1234"); await p.click("#setupForm button.primary");
  await p.waitForSelector("[data-add]");
  step("setup signs in and loads 32 seeded menu items", (await p.$$("[data-add]")).length === 32);

  // sell 4 egg tarts (buy 3 get 1) + iced latte
  for (let i = 0; i < 4; i++) await clickItem("ทาร์ตไข่");
  await clickItem("ลาเต้"); await p.click('[data-oi="1"]'); await p.click("[data-addopt]"); await p.waitForTimeout(150);
  const totals = (await p.textContent(".totals")).replace(/\s+/g, " ");
  step("ticket shows promo and total", totals.includes("ทาร์ตไข่ ซื้อ 3 แถม 1") && totals.includes("฿215"), totals);
  await p.click("[data-pay]"); await p.waitForTimeout(150); await p.click('[data-cash="500"]'); await p.click("#confirmPay");
  await p.waitForSelector("#rcpt");
  const rc = (await p.textContent("#rcpt")).replace(/\s+/g, " ");
  step("server saved the order and receipt shows queue + change", rc.includes("#001") && rc.includes("285.00"), rc.slice(0, 160));
  await p.screenshot({ path: path.join(shots, "e2e-receipt.png") });

  // PDF receipt download (needs internet for jsPDF/html2canvas from cdnjs)
  const dl = p.waitForEvent("download", { timeout: 15000 }).catch(() => null);
  await p.click("#rcptPdf"); const d = await dl;
  step("receipt PDF downloads", !!d, d ? d.suggestedFilename() : "no download (offline CDN?)");
  await p.click(".modal [data-close]").catch(() => {});

  // second device sees the order live via SSE
  const p2 = await (await b.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  await p2.goto(base); await p2.waitForSelector("[data-login]");
  await p2.click("[data-login]"); for (const k of "1234") await p2.click(`[data-pin="${k}"]`);
  await p2.waitForSelector("[data-nav=orders]"); await p2.click("[data-nav=orders]"); await p2.waitForTimeout(300);
  step("second device sees the order", (await p2.$$(".ocard")).length === 1);
  await p.click("[data-nav=orders]"); await p.click("[data-st]"); await p2.waitForTimeout(900);
  step("status change syncs live to the second device", (await p2.$$(".ocard.ready")).length === 1);

  // menu: add an item with an uploaded photo
  await p.click("[data-nav=menu]"); await p.click('[data-itemedit=""]');
  await p.setInputFiles("#f-img", path.join(__dirname, "..", "public", "assets", "illustrations", "m-donut.jpg"));
  await p.waitForFunction(() => document.querySelector("#imgPrev img")?.src.includes("/uploads/"), null, { timeout: 8000 }).catch(() => {});
  const up = await p.$eval("#imgPrev img", i => i.src).catch(() => "");
  step("image uploads to the server", up.includes("/uploads/"), up);
  await p.fill("#f-name", "โดนัทช็อกโกแลต"); await p.selectOption("#f-cat", "cake"); await p.fill("#f-price", "49"); await p.fill("#f-stock", "12"); await p.click("#itemSave");
  await p.waitForTimeout(500);
  step("new menu item saved", (await p.textContent("tbody")).includes("โดนัทช็อกโกแลต"));

  // members + counter redemption
  await p.click("[data-nav=members]"); await p.click('[data-memedit=""]'); await p.fill("#mm-phone", "0899999999"); await p.fill("#mm-name", "ฝ้าย"); await p.click("#memForm button.primary");
  await p.waitForTimeout(400); await p.click("[data-memedit='0899999999']"); await p.fill("#mm-pts", "120"); await p.click("#memForm button.primary"); await p.waitForTimeout(400);
  await p.click("[data-memredeem]"); await p.waitForTimeout(200); await p.click('[data-redeem="w-cookie"]'); await p.click("#rdYes"); await p.waitForSelector(".stub .ink");
  step("counter redemption shows the stamped stub", (await p.textContent(".stub")).includes("เหลือ 80"));
  await p.click(".modal [data-rdcancel]"); await p.click("#crYes"); await p.waitForTimeout(500);
  step("cancel redemption returns points", (await p.textContent("tbody")).includes("120"));

  // report + CSV
  await p.click("[data-nav=report]"); await p.waitForSelector(".kpi .v");
  step("report shows today's sales", (await p.textContent(".kpi .v")).includes("฿215"));
  await p.screenshot({ path: path.join(shots, "e2e-report.png") });
  const dl2 = p.waitForEvent("download", { timeout: 8000 }).catch(() => null);
  await p.click("[data-repcsv]"); const d2 = await dl2;
  step("CSV export downloads", !!d2, d2 ? d2.suggestedFilename() : "");

  // PromptPay: set the shop number, then pay a bill by QR
  await p.click("[data-nav=shop]"); await p.fill("#s-pp", "0812345678"); await p.click("#shopForm button.primary"); await p.waitForTimeout(500);
  await p.click("[data-nav=pos]"); await clickItem("บราวนี่"); await p.click("[data-pay]"); await p.click('[data-paym="qr"]');
  await p.waitForFunction(() => document.querySelector("#ppCanvas")?.width > 100, null, { timeout: 8000 }).catch(() => {});
  step("PromptPay QR is drawn", await p.$eval("#ppCanvas", c => c.width > 100).catch(() => false));
  await p.fill("#payRef", "SLIP123"); await p.click("#confirmPay"); await p.waitForSelector("#rcpt");
  step("QR payment saved with slip reference", (await p.textContent("#rcpt")).includes("พร้อมเพย์ SLIP123"));
  await p.click(".modal [data-close]");

  // lock → login screen
  await p.click("[data-lock]"); await p.waitForSelector("[data-login]");
  step("lock returns to the staff picker", true);
  step("no browser errors", !errs.length, errs.join(" | "));
  await b.close();
})();
