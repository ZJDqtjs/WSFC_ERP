/**
 * 桌面 Web 前端「离线 UI 走查」服务器（可选开发工具，不参与部署）。
 *
 * 用途：在没有后端（或没有私钥、无法登录）的情况下，把 web/static 渲染出来并
 * 用一份假数据填充工作台，方便改样式 / 调交互后立刻看效果。
 *
 * 用法：
 *   node web/preview_mock.js              # http://127.0.0.1:8123  → 直接进入工作台（假数据）
 *   set NO_LOGIN=1 && node web/preview_mock.js   # 只看登录页
 *   set PORT=9000  && node web/preview_mock.js   # 换端口
 *
 * 注意：只有 /api/dashboard、/api/products、/api/units、/api/stock-overview
 * 返回演示数据，其余接口返回空数组；真实联调请用 web/serve.py + backend。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const ROOT = path.join(__dirname, "static");
const PORT = Number(process.env.PORT || 8123);
const NO_LOGIN = process.env.NO_LOGIN === "1";

const PRODUCTS = [
  { id: 1, name: "东北黑木耳 干货", category: "干货", base_unit: "斤", default_unit: "斤", product_type: "stock", is_active: true, stock: 320, avg_cost: 24.5, unit_cost: 23, stock_value: 7840, conversions: {} },
  { id: 2, name: "七彩土豆", category: "蔬菜", base_unit: "斤", default_unit: "斤", product_type: "stock", is_active: true, stock: 88, avg_cost: 3.2, unit_cost: 3, stock_value: 281.6, conversions: {} },
  { id: 3, name: "鲜玉米", category: "蔬菜", base_unit: "斤", default_unit: "箱", product_type: "stock", is_active: true, stock: 0, avg_cost: 0, unit_cost: 0, stock_value: 0, conversions: { 箱: 20 } },
  { id: 4, name: "3 号泡沫箱", category: "包材", base_unit: "个", default_unit: "个", product_type: "stock", is_active: true, stock: 1500, avg_cost: 2.1, unit_cost: 2, stock_value: 3150, conversions: {} },
  { id: 5, name: "打包人工（单）", category: "人工", base_unit: "单", default_unit: "单", product_type: "stock", is_active: true, stock: 0, avg_cost: 0, unit_cost: 1.5, stock_value: 0, conversions: {} },
];

const DASHBOARD = {
  user_name: "小王",
  today: new Date().toISOString().slice(0, 10),
  today_summary: { revenue: 3260.5, orders: 12, gross: 1180.2, net: 940.5 },
  month_summary: { revenue: 86420.0, orders: 318, gross: 26310.4, net: 20150.8 },
  stock_value: 125480.6,
  product_count: 168,
  low_stock: [
    { id: 3, name: "鲜玉米", category: "蔬菜", base_unit: "斤", default_unit: "箱", stock: 0, conversions: { 箱: 20 } },
    { id: 9, name: "大叶菠菜", category: "蔬菜", base_unit: "斤", default_unit: "斤", stock: 0, conversions: {} },
    { id: 11, name: "云南小土豆", category: "蔬菜", base_unit: "斤", default_unit: "斤", stock: 0, conversions: {} },
  ],
  recent_outbounds: [
    { code: "CK20260914001", customer: "张三", date: "2026-09-14", operator: "小王", amount: 1860.0 },
    { code: "CK20260914002", customer: "李四", date: "2026-09-14", operator: "小王", amount: 1400.5 },
  ],
  recent_inbounds: [
    { code: "RK20260913001", product_name: "东北黑木耳 干货", quantity: 200, unit: "斤", date: "2026-09-13", amount: 4900 },
  ],
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

http
  .createServer((req, res) => {
    const p = url.parse(req.url).pathname;
    if (p === "/config.json") {
      return json(res, 200, { routes: { api: "/api", uploads: "/uploads", mobile: "/mobile" } });
    }
    if (p.startsWith("/api/")) {
      if (p === "/api/auth/me") {
        if (NO_LOGIN) return json(res, 401, { detail: "未登录" });
        return json(res, 200, { username: "小王", name: "小王", role: "admin", warehouse: { key: "main", name: "主仓（昆明）" } });
      }
      if (p === "/api/dashboard") return json(res, 200, DASHBOARD);
      if (p === "/api/products") return json(res, 200, PRODUCTS);
      if (p === "/api/units") return json(res, 200, [{ id: 1, name: "斤" }, { id: 2, name: "箱" }, { id: 3, name: "个" }, { id: 4, name: "单" }]);
      if (p === "/api/stock-overview") return json(res, 200, PRODUCTS);
      return json(res, 200, []);
    }
    let file = path.join(ROOT, p === "/" ? "index.html" : p.replace(/^\//, ""));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, () => console.log(`UI 走查预览: http://127.0.0.1:${PORT}` + (NO_LOGIN ? "  （登录页）" : "  （工作台假数据）")));
