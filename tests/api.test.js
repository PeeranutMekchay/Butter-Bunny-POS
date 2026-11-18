// End-to-end API tests against a fresh in-memory database. Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { openDb } = require("../server/db");
const { seedIfEmpty } = require("../server/seed");
const { createApp } = require("../server/app");

let server, base, db;
const call = async (method, url, body, token) => {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};

test.before(async () => {
  db = openDb(":memory:");
  seedIfEmpty(db);
  const app = createApp({ db, uploadsDir: fs.mkdtempSync(path.join(os.tmpdir(), "bb-up-")) });
  await new Promise(r => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => server.close());

let mgr, cashier, cashierId;

test("first run: setup creates the first manager once", async () => {
  const pub = await call("GET", "/public");
  assert.equal(pub.body.needsSetup, true);
  assert.equal(pub.body.menu.length, 7);
  const r = await call("POST", "/auth/setup", { name: "นุ่น", pin: "1234" });
  assert.equal(r.status, 200); mgr = r.body.token;
  assert.equal((await call("POST", "/auth/setup", { name: "อีกคน", pin: "1111" })).status, 409);
  assert.equal((await call("GET", "/public")).body.needsSetup, false);
});

test("staff: manager adds a cashier; wrong PINs lock the account", async () => {
  assert.equal((await call("PUT", "/staff/u-mew", { name: "มิว", role: "cashier", pin: "5678" }, mgr)).status, 200);
  cashierId = "u-mew";
  for (let i = 0; i < 4; i++) assert.equal((await call("POST", "/auth/login", { staffId: cashierId, pin: "0000" })).status, 401);
  assert.equal((await call("POST", "/auth/login", { staffId: cashierId, pin: "0000" })).status, 401);
  const locked = await call("POST", "/auth/login", { staffId: cashierId, pin: "5678" });
  assert.equal(locked.status, 429);
});

test("staff: cannot remove the last manager", async () => {
  const me = (await call("GET", "/auth/me", undefined, mgr)).body.staff;
  const r = await call("PUT", "/staff/" + me.id, { name: me.name, role: "cashier" }, mgr);
  assert.equal(r.status, 400);
});

test("auth: protected routes need a session, manager routes need a manager", async () => {
  assert.equal((await call("GET", "/bootstrap")).status, 401);
  // log the cashier in directly (lock from the previous test is per-process, so reset by giving a new PIN)
  assert.equal((await call("PUT", "/staff/u-mew2", { name: "ฝน", role: "cashier", pin: "2468" }, mgr)).status, 200);
  cashier = (await call("POST", "/auth/login", { staffId: "u-mew2", pin: "2468" })).body.token;
  assert.ok(cashier);
  assert.equal((await call("PUT", "/menu/m-latte", { name: "x", cat: "coffee", price: 1 }, cashier)).status, 403);
  assert.equal((await call("GET", "/orders?from=2026-01-01&to=2026-01-02", undefined, cashier)).status, 403);
});

const stockOf = id => db.prepare("SELECT qty FROM stock WHERE id = ?").get(id)?.qty;
const pointsOf = phone => db.prepare("SELECT points FROM members WHERE phone = ?").get(phone).points;

test("checkout: server prices the bill, applies buy-3-get-1, cuts stock", async () => {
  const before = stockOf("m-eggtart");
  const r = await call("POST", "/orders", { lines: [{ id: "m-eggtart", qty: 4 }], type: "dine", pay: "cash", tendered: 200, expectTotal: 135 }, cashier);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = r.body.order;
  assert.equal(o.subtotal, 180); assert.equal(o.total, 135); assert.equal(o.change, 65); assert.equal(o.queue, 1);
  assert.deepEqual(o.promos.map(p => p.id), ["p-tart31"]);
  assert.equal(stockOf("m-eggtart"), before - 4);
});

test("checkout: rejects a stale total, short cash and oversold stock", async () => {
  assert.equal((await call("POST", "/orders", { lines: [{ id: "m-latte", qty: 1, opt: "เย็น" }], pay: "cash", tendered: 100, expectTotal: 70 }, cashier)).status, 409);
  assert.equal((await call("POST", "/orders", { lines: [{ id: "m-latte", qty: 1, opt: "เย็น" }], pay: "cash", tendered: 10 }, cashier)).status, 400);
  assert.equal((await call("POST", "/orders", { lines: [{ id: "m-yuzu", qty: 99 }], pay: "card" }, cashier)).status, 409);
  assert.equal((await call("POST", "/orders", { lines: [{ id: "m-latte", qty: 1, opt: "ปั่นพิเศษ" }], pay: "card" }, cashier)).status, 400);
  assert.equal((await call("POST", "/orders", { lines: [{ id: "m-latte", qty: 1 }], pay: "qr" }, cashier)).status, 400, "no PromptPay set yet");
});

test("members: earn points, redeem a reward inside a bill, void restores everything", async () => {
  assert.equal((await call("POST", "/members", { phone: "0812345678", name: "ฝ้าย" }, cashier)).status, 200);
  assert.equal((await call("POST", "/members", { phone: "0812345678", name: "ซ้ำ" }, cashier)).status, 409);
  assert.equal((await call("PATCH", "/members/0812345678", { points: 300 }, cashier)).status, 403);
  assert.equal((await call("PATCH", "/members/0812345678", { points: 300 }, mgr)).status, 200);
  const tote = stockOf("rw-w-tote"), croissant = stockOf("m-croissant");
  const r = await call("POST", "/orders", { lines: [{ id: "m-croissant", qty: 1 }, { reward: "w-tote", qty: 1 }], pay: "card", memberPhone: "0812345678" }, cashier);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.pointsUsed, 250); assert.equal(r.body.order.pointsEarned, 2); assert.equal(r.body.order.total, 65);
  assert.equal(pointsOf("0812345678"), 52);
  assert.equal(stockOf("rw-w-tote"), tote - 1); assert.equal(stockOf("m-croissant"), croissant - 1);
  // not enough points for another tote
  assert.equal((await call("POST", "/orders", { lines: [{ reward: "w-tote", qty: 1 }], pay: "card", memberPhone: "0812345678" }, cashier)).status, 409);
  // cashier cannot void, manager can
  assert.equal((await call("POST", `/orders/${r.body.order.id}/void`, { reason: "ทดสอบ" }, cashier)).status, 403);
  const v = await call("POST", `/orders/${r.body.order.id}/void`, { reason: "ทดสอบ", restock: true, restockRewards: true }, mgr);
  assert.equal(v.status, 200); assert.equal(v.body.order.status, "void");
  assert.equal(pointsOf("0812345678"), 300);
  assert.equal(stockOf("rw-w-tote"), tote); assert.equal(stockOf("m-croissant"), croissant);
  assert.equal((await call("POST", `/orders/${r.body.order.id}/void`, {}, mgr)).status, 409);
  const ledger = (await call("GET", "/members/0812345678/ledger", undefined, mgr)).body.ledger;
  assert.deepEqual(ledger.map(x => x.reason).sort(), ["adjust", "earn", "spend", "void"]);
});

test("redeems: counter redemption and cancellation", async () => {
  const cookie = stockOf("m-cookie");
  const r = await call("POST", "/redeems", { memberPhone: "0812345678", rewardId: "w-cookie" }, cashier);
  assert.equal(r.status, 200); assert.equal(r.body.member.points, 260); assert.equal(stockOf("m-cookie"), cookie - 1);
  assert.equal((await call("POST", "/redeems", { memberPhone: "0812345678", rewardId: "w-off50" }, cashier)).status, 400, "discount only at checkout");
  const c = await call("POST", `/redeems/${r.body.redeem.id}/cancel`, { restockItem: true }, cashier);
  assert.equal(c.status, 200); assert.equal(c.body.member.points, 300); assert.equal(stockOf("m-cookie"), cookie);
  assert.equal((await call("POST", `/redeems/${r.body.redeem.id}/cancel`, {}, cashier)).status, 409);
});

test("discount voucher from points applies at checkout", async () => {
  const r = await call("POST", "/orders", { lines: [{ id: "m-strawshort", qty: 1 }], pay: "card", memberPhone: "0812345678", voucher: "w-off50" }, cashier);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.pointsDisc, 50); assert.equal(r.body.order.total, 85); assert.equal(r.body.order.pointsUsed, 100);
});

test("orders: status moves forward only; reports list the day", async () => {
  const day = (await call("GET", "/bootstrap", undefined, cashier)).body.today;
  const o = day.orders.find(x => x.status === "preparing");
  assert.equal((await call("PATCH", `/orders/${o.id}/status`, { status: "done" }, cashier)).status, 400);
  assert.equal((await call("PATCH", `/orders/${o.id}/status`, { status: "ready" }, cashier)).body.order.status, "ready");
  const rep = await call("GET", `/orders?from=${day.day}&to=${day.day}`, undefined, mgr);
  assert.equal(rep.body.orders.length, day.orders.length);
  assert.ok(rep.body.redeems.length >= 2);
});

test("catalog: validation and CRUD", async () => {
  assert.equal((await call("PUT", "/menu/m-new", { name: "", cat: "cake", price: 10 }, mgr)).status, 400);
  assert.equal((await call("PUT", "/menu/m-new", { name: "ทดสอบ", cat: "nope", price: 10 }, mgr)).status, 400);
  assert.equal((await call("PUT", "/menu/m-new", { name: "ทดสอบ", cat: "cake", price: 10, img: "javascript:alert(1)" }, mgr)).status, 400);
  const ok = await call("PUT", "/menu/m-new", { name: "คัพเค้ก", cat: "cake", price: 49, trackStock: true, stock: 6 }, mgr);
  assert.equal(ok.status, 200); assert.equal(stockOf("m-new"), 6);
  assert.equal((await call("POST", "/stock/m-new/add", { qty: 4 }, mgr)).status, 200); assert.equal(stockOf("m-new"), 10);
  assert.equal((await call("PUT", "/promos/p-x", { name: "ผิด", type: "percent", scope: "all", value: 150 }, mgr)).status, 400);
  assert.equal((await call("PUT", "/promos/p-x", { name: "ลด 10%", type: "percent", scope: "cat", cat: "cake", value: 10, start: "14:00" }, mgr)).status, 400);
  assert.equal((await call("PUT", "/promos/p-x", { name: "ลด 10%", type: "percent", scope: "cat", cat: "cake", value: 10 }, mgr)).status, 200);
  assert.equal((await call("DELETE", "/promos/p-x", undefined, mgr)).status, 200);
  assert.equal((await call("PUT", "/config/shop", { promptpay: "12345" }, mgr)).status, 400);
  assert.equal((await call("PUT", "/config/shop", { promptpay: "0812345678" }, mgr)).body.shop.promptpay, "0812345678");
  assert.equal((await call("DELETE", "/menu/m-new", undefined, mgr)).status, 200);
});
