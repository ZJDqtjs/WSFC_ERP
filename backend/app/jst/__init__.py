"""聚水潭（JST / erp321）销售出库单自动导出与导入。

移植自独立项目 AutoExp_ERP321（jst_export），去掉 .env 依赖，改为读 ERP 自己的
「自动出库设置」（backend/json/jst_auto.json），并复用本项目的聚水潭导入链路直接建出库单。

模块划分：
- client.py    带限速的 HTTP 会话（Cookie 复用 + 失效自动续登）
- login.py     账号密码登录、分仓列表解析
- config.py    时间区间规则（yesterday / d2 / last7d / last24h…）与定时点解析
- settings.py  自动出库设置的读写（按 ERP 分仓隔离，含全局账号）
- exporter.py  导出四步流程：取 __VIEWSTATE → 建导出任务拿令牌 → 换 OSS 地址 → 下载 xlsx
- runner.py    串起来：导出 → 落盘 → 复用现有导入链路建出库单 → 记录执行历史；含定时调度线程
"""
