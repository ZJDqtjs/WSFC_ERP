# WSFC_ERP 桌面 Web / 移动 PWA 体验评审与改进（终版）

评审维度：**美观一致** · **实用效率** · **用户友好（容错与可访问性）**
改动范围：`web/static/*`（桌面端）、`mobile/*`（PWA）、`mobile/dist`（已重新构建）

---

## 一、总体印象

两端业务完整度都很高（入库/出库/入账/库存/报表/备份/聚水潭/扣点/鲜货）。桌面端采用 Windows 11 Fluent token 化 CSS，移动端基于 Vant4。短板集中在**状态反馈、防误操作、细节一致性、移动端适配、图标/文案统一**五类——都是"不影响功能、但天天影响手感"的问题，本轮已系统性整改。

---

## 二、桌面 Web 改进

| 类别 | 问题（改前） | 改后 |
|---|---|---|
| 页面标题 | `库存管理`/`设置` 打开后无任何标题；`PAGE_TITLES` 定义但从未使用 | 新增**统一页头**（一级标题 + 一句话说明，`goPage()` 按页面填充）；商品页被侧栏以「包材/人工/关联结算」入口打开时标题跟随变化；设置页按 4 个 tab 动态切换说明 |
| 空状态 | 入库/出库/入仓批次等主列表**无数据即白板**；出库批次空态用错类 | 补齐空态行（入库 colspan12 / 出库 colspan11 / 入仓批次），全部统一 `.empty` 图标样式 |
| 图标体系 | emoji 与 SVG 混用；`#i-warehouse` 图标缺失导致入仓入口空白；鲜货与快递撞图 | 修复 `i-warehouse`；新增 `i-back / i-leaf / i-menu / i-power`；鲜货换叶子图标；搜索框 `🔍` 改 CSS 放大镜；关闭按钮 `✕` 改 SVG；行内「改/删」单字按钮改**图标 + title**；清理 `🗑 ✓ ＋ ⏳ 📎 🖼 🤖 ✅ 🎉 ✔` 等 60+ 处 emoji |
| 加载反馈 | 请求期间毫无反馈；点击后界面"没反应" | 顶部**请求进度条** + 提交按钮自动**转圈禁用**（防双击重复入库/出库）；「正在解析/导入」类提示统一为转圈动画 |
| 防误操作 | 原生 `confirm()` 做 26 处危险确认，样式不可控、被浏览器拦截时静默返回 false | 自研统一确认框：可叠加在业务弹窗之上、Esc/遮罩=取消、回车=确定、危险操作标红、主按钮文案具体化；恢复备份做**二次确认**；`createWarehouse` 补确认 |
| 弹窗体验 | 只能点 ✕ 关闭；背景可滚动；无焦点管理 | Esc 关闭、锁定背景滚动、关闭后焦点回归、打开时自动聚焦首个输入框 |
| 列表信息 | "共 N 条"无金额合计；筛选只有裸日期 | 入库显示**合计金额**、出库显示**单数·收入·净利**；入库/出库加「今天/近7天/本月」快捷按钮 |
| 窄屏 | ≤1024px 侧边栏固定挤压表格 | 侧边栏改**抽屉**（汉堡 + 遮罩 + 点导航自动收起） |
| 登录 | 回车不提交、用户名重敲、只能点按钮选私钥 | `<form>` 回车提交、**拖拽私钥文件**、记住用户名 |
| 二级页 | 返回/删除入口位置与文案不统一（"删 除本批"多空格） | 入仓/出库批次页返回与删除入口、图标、文案统一 |
| 可访问性 | 键盘焦点不可见、动画不尊重系统偏好、原生日期控件不跟随主题 | `:focus-visible`、`prefers-reduced-motion`、`aria-live`/`aria-label`、`color-scheme`、favicon + theme-color |
| 暗色模式 | 多处硬编码色与未定义变量（`var(--danger)` 等） | 补齐别名、修 10+ 处硬编码色、危险按钮补暗色态 |

---

## 三、移动 PWA 改进

| 类别 | 问题（改前） | 改后 |
|---|---|---|
| 设计基础 | 颜色/圆角/间距散落 19 个文件，硬编码 60+ 处 | 在 `app.vue` 建立**设计变量**（色板/圆角/间距）与全局工具类 `.sub-page/.sub-body/.filter-bar/.kw-field/.tip/.batch-bar/.skeleton-card/.field-bg/.io-*/.num-r` |
| 加载占位 | 仅 home/stock 总览有骨架，其余 11 个列表页首屏直接显示"暂无数据" | 新增 `SkeletonList` 组件，**全部列表页接入骨架屏**（inbound/outbound/products/packrules/fresh/deduction/report/settings 备份/stock 4 个 tab/outgroup）；「加载中/解析中」不再借用 `.empty` |
| 空状态 | 文案 33 处风格不统一（emoji/括号/祈使句/前缀混用）；`van-empty` 与 `.empty` 两套 | 统一为「暂无/尚未配置/没有匹配」；去掉 🎉；`van-empty` 统一为 `.empty` |
| 二级页 | outgroup 是唯一异类（`og-page` + 散写内联 padding）；7 份重复 `.sub-page` 样式 | outgroup 统一为 `.sub-page + .sub-body`；重复样式收敛到全局 |
| 数字排版 | 金额/数量三种类名各写各的，缺对齐 | `.num-r` 统一收敛 `.io-amount/.amount/.stock-num`（右对齐 + 等宽数字 + 字重），单位弱化 |
| 筛选/表单 | 筛选行控件堆叠、内联样式重复、缺 label/placeholder/required | 统一 `.filter-bar`；搜索框 `.kw-field`；补 required 星标与 placeholder |
| 按钮/容错 | fresh 导入、settings 切换/清空、switchWh 无 loading | 补齐 loading；`pdataUpload`（upsert 导入）补确认；清空关联文案更明确 |
| 适配 | 顶栏未适配刘海屏；禁用缩放；标题恒定 | 补 `safe-area-inset-top`（顶栏 + 8 个 nav-bar）；移除 `user-scalable=no`；补 iOS 加主屏元信息；标题随路由、切页回顶 |
| 体验 | 工作台 keep-alive 数据陈旧；宫格 7 项不齐 | 工作台**下拉刷新**；宫格补第 8 项「库存管理」排齐；版本号改由 `package.json` 注入 |
| 商品选择器 | 固定像素偏移计算列表高度，切换页签会算错 | 改 **flex 自适应高度** |

### 顺带修复的真实 Bug

- `products.vue` 导出 JSON 调用了 `downloadJson` 但**未 import**（点击会报 ReferenceError），已修复。

---

## 四、建议后续优化（未做）

1. **Vant 按需引入**：整包注册产物 515 KB（gzip 171 KB），改 `unplugin-vue-components` 可降到约 1/3，但需逐个页面回归。
2. **移动端深色模式**：Vant 支持 `van-theme-dark`，但 19 页仍有大量内联浅色，需先全部变量化再开启。
3. **桌面端长表分页/虚拟滚动**：商品量上千后一次性渲染偏重。
4. **表格粘性表头**：`.table-wrap` 是横向滚动容器，纵向 sticky 需改造为固定高度。
5. **操作审计提示**：删除/回退类成功提示可带上受影响范围（如"已回退 3 条流水、重算 2 个商品均价"）。
6. **离线提示**：PWA 接口一律 NetworkOnly，断网时表现为"转圈无结果"，可加统一离线提示。

---

## 五、验证

- 桌面端：`node --check web/static/app.js` 通过；CSS 括号配平校验通过；无 lint 错误。
- 移动端：`cd mobile && npm run build` 构建成功，产物已刷新 `mobile/dist`。
- 视觉走查：`web/preview_mock.js`（可选开发工具，不参与部署）无需后端与私钥即可看带假数据的工作台：
  ```bash
  node web/preview_mock.js                     # http://127.0.0.1:8123 → 工作台（假数据）
  set NO_LOGIN=1 && node web/preview_mock.js   # 只看登录页
  ```
