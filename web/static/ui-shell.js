/* =====================================================================
   WSFC_ERP UI Shell — 抽屉 / 帮助浮层 / 下拉菜单 / 侧边栏折叠 / 主题切换
   与 app.js 业务代码解耦，零侵入提升桌面 Web 端交互与视觉体验
   ===================================================================== */

(function () {
  "use strict";

  /* ---------- 1. 主题切换（浅色 / 暗色，记忆到 localStorage） ---------- */
  const THEME_KEY = "erp_theme_pref";
  function applyTheme(mode) {
    const html = document.documentElement;
    if (mode === "dark" || mode === "light") {
      html.setAttribute("data-theme", mode);
    } else {
      html.removeAttribute("data-theme");
    }
    const btn = document.getElementById("themeToggleBtn");
    if (btn) {
      const isDark =
        mode === "dark" ||
        (!mode && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
      btn.innerHTML = isDark
        ? '<svg class="ic"><use href="#i-sun"/></svg>'
        : '<svg class="ic"><use href="#i-moon"/></svg>';
      btn.title = isDark ? "切换为浅色主题" : "切换为暗色主题";
    }
  }
  window.toggleTheme = function () {
    const cur = document.documentElement.getAttribute("data-theme");
    const sysDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = cur ? (cur === "dark" ? "light" : "dark") : (sysDark ? "light" : "dark");
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  };
  applyTheme(localStorage.getItem(THEME_KEY) || "");

  /* ---------- 2. 侧边栏折叠 ---------- */
  const SIDEBAR_KEY = "erp_sidebar_collapsed";
  function applySidebarState() {
    const collapsed = localStorage.getItem(SIDEBAR_KEY) === "1";
    document.body.classList.toggle("sidebar-collapsed", collapsed);
  }
  window.toggleSidebar = function () {
    const next = !document.body.classList.contains("sidebar-collapsed");
    document.body.classList.toggle("sidebar-collapsed", next);
    localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
  };
  applySidebarState();

  /* ---------- 3. 右侧滑出抽屉（Drawer） ---------- */
  window.openDrawer = function (drawerId) {
    const el = document.getElementById(drawerId);
    if (!el) return;
    el.classList.add("open");
    document.body.classList.add("drawer-open");
  };
  window.closeDrawer = function (drawerId) {
    const el = document.getElementById(drawerId);
    if (!el) return;
    el.classList.remove("open");
    if (!document.querySelector(".drawer-overlay.open")) {
      document.body.classList.remove("drawer-open");
    }
  };
  window.closeAllDrawers = function () {
    document.querySelectorAll(".drawer-overlay.open").forEach((el) => el.classList.remove("open"));
    document.body.classList.remove("drawer-open");
  };

  /* ---------- 4. 通用「?」帮助浮层（Popover） ---------- */
  let popEl = null;
  let popAnchor = null;
  function ensurePopover() {
    if (popEl) return popEl;
    popEl = document.createElement("div");
    popEl.className = "help-popover";
    popEl.setAttribute("role", "tooltip");
    document.body.appendChild(popEl);
    return popEl;
  }
  function hidePopover() {
    if (popEl) popEl.classList.remove("show");
    popAnchor = null;
  }
  function showPopover(btn) {
    const text = btn.getAttribute("data-help") || "";
    if (!text) return;
    const p = ensurePopover();
    p.textContent = text;
    p.classList.add("show");
    popAnchor = btn;
    const r = btn.getBoundingClientRect();
    const pw = Math.min(340, window.innerWidth - 24);
    p.style.maxWidth = pw + "px";
    const pr = p.getBoundingClientRect();
    let left = r.left + r.width / 2 - pr.width / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - pr.width - 12));
    let top = r.bottom + 8;
    if (top + pr.height > window.innerHeight - 12) {
      top = Math.max(12, r.top - pr.height - 8);
    }
    p.style.left = left + "px";
    p.style.top = top + "px";
  }

  /* ---------- 5. 下拉操作菜单（.dropdown） ---------- */
  function closeAllDropdowns(except) {
    document.querySelectorAll(".dropdown.open").forEach((d) => {
      if (d !== except) d.classList.remove("open");
    });
  }

  document.addEventListener("click", (e) => {
    // 帮助浮层按钮
    const helpBtn = e.target.closest(".help-btn");
    if (helpBtn) {
      e.stopPropagation();
      if (popAnchor === helpBtn && popEl && popEl.classList.contains("show")) hidePopover();
      else showPopover(helpBtn);
      return;
    }
    if (popEl && !popEl.contains(e.target)) hidePopover();

    // 下拉菜单
    const ddToggle = e.target.closest(".dropdown-toggle");
    if (ddToggle) {
      e.stopPropagation();
      const dd = ddToggle.closest(".dropdown");
      const wasOpen = dd.classList.contains("open");
      closeAllDropdowns(dd);
      dd.classList.toggle("open", !wasOpen);
      return;
    }
    if (e.target.closest(".dropdown-menu button, .dropdown-menu a")) {
      closeAllDropdowns();
      return;
    }
    if (!e.target.closest(".dropdown")) closeAllDropdowns();

    // 点击抽屉遮罩层关闭
    if (e.target.classList && e.target.classList.contains("drawer-overlay")) {
      window.closeDrawer(e.target.id);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      hidePopover();
      closeAllDropdowns();
      const openDrawers = document.querySelectorAll(".drawer-overlay.open");
      if (openDrawers.length) {
        window.closeDrawer(openDrawers[openDrawers.length - 1].id);
      }
    }
  });

  window.addEventListener("scroll", hidePopover, true);
  window.addEventListener("resize", hidePopover);

  /* ---------- 6. 页内分段 Tab 辅助函数 ---------- */
  window.switchProdTab = function (btn) {
    const seg = document.getElementById("prodTabSeg");
    if (seg) seg.querySelectorAll(".seg-item").forEach((x) => x.classList.remove("active"));
    if (btn) btn.classList.add("active");
    window.prodForceCat = (btn && btn.dataset.cat) || "";
    window.prodForceType = (btn && btn.dataset.type) || "";
    if (typeof window.renderProducts === "function") window.renderProducts();
  };

  window.syncProdTabUI = function () {
    const seg = document.getElementById("prodTabSeg");
    if (!seg) return;
    const cat = window.prodForceCat || "";
    const type = window.prodForceType || "";
    seg.querySelectorAll(".seg-item").forEach((x) => {
      const hit = (x.dataset.cat || "") === cat && (x.dataset.type || "") === type;
      x.classList.toggle("active", hit);
    });
  };

  window.switchWinTab = function (btn) {
    const seg = document.getElementById("winTabSeg");
    if (seg) seg.querySelectorAll(".seg-item").forEach((x) => x.classList.remove("active"));
    if (btn) btn.classList.add("active");
    const panel = btn && btn.dataset.panel;
    const pRec = document.getElementById("win-panel-records");
    const pProd = document.getElementById("win-panel-products");
    if (pRec) pRec.style.display = panel === "win-panel-records" ? "" : "none";
    if (pProd) pProd.style.display = panel === "win-panel-products" ? "" : "none";
  };

  window.switchDeducTab = function (btn) {
    const seg = document.getElementById("deducTabSeg");
    if (seg) seg.querySelectorAll(".seg-item").forEach((x) => x.classList.remove("active"));
    if (btn) btn.classList.add("active");
    const panel = btn && btn.dataset.panel;
    ["deduc-panel-cat", "deduc-panel-wh", "deduc-panel-shop"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = id === panel ? "" : "none";
    });
  };

  window.switchOeViewTab = function (btn) {
    const seg = document.getElementById("oeViewSeg");
    if (seg) seg.querySelectorAll(".seg-item").forEach((x) => x.classList.remove("active"));
    if (btn) btn.classList.add("active");
    const panel = btn && btn.dataset.panel;
    const pList = document.getElementById("oe-panel-list");
    const pStats = document.getElementById("oe-panel-stats");
    if (pList) pList.style.display = panel === "oe-panel-list" ? "" : "none";
    if (pStats) pStats.style.display = panel === "oe-panel-stats" ? "" : "none";
  };

  /* ---------- 7. 顶部页头标题与分仓同步 ---------- */
  const PAGE_NAMES = {
    home: "工作台",
    eva: "AI 待办处理",
    stock: "库存管理",
    inbound: "入库管理",
    outbound: "出库 / 销售",
    "warehouse-in": "入仓管理",
    wingroup: "入仓批次明细",
    outgroup: "出库批次明细",
    products: "商品资料",
    packrules: "一单多货规则",
    report: "财务报表",
    adprofit: "广告利润",
    otherexp: "其他收支",
    payables: "待付款账单",
    fresh: "鲜货现采",
    "fresh-in": "鲜货入库",
    deduction: "扣点设置",
    express: "快递费规则",
    settings: "系统设置",
  };
  window.syncTopbarTitle = function (pageName) {
    const el = document.getElementById("topbarTitle");
    if (el) el.textContent = PAGE_NAMES[pageName] || "企业台账";
  };

  // 页面加载完成后给所有侧边栏按钮补齐 title（折叠时悬停可见名称）
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".side-nav .nav-item").forEach((btn) => {
      if (!btn.title) {
        const lbl = btn.querySelector(".nav-label");
        btn.title = (lbl ? lbl.textContent : btn.textContent).trim();
      }
    });
    applyTheme(localStorage.getItem(THEME_KEY) || "");
  });
})();
