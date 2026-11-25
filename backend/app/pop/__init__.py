"""京东 POP 店订单定时导入（京麦模块）。

数据流：
    jdfenxi（本机挂载服务，frp 隧道 127.0.0.1:18011）每晚 19:00 抓取 POP 订单缓存
      → ERP 定时器按窗口拉取 /api/pop/orders（只读缓存，不触发浏览器）
      → 过滤状态 → SKU 解析 → 走 create_outbound 建出库单（代发/扣库存、快递费、店铺扣点全沿用现有口径）
      → 平台订单号写 outbounds.external_no，重跑幂等；订单被取消则自动红冲

与「聚水潭自动出库」并列，互不影响：设置存 backend/json/pop_auto.json，
调度线程独立（pop-scheduler），页面上「设置 → 自动出库设置」用模块切换按钮分开配置。
"""
