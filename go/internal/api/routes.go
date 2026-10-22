package api

import (
	"net/http"
	"sort"
)

import (
	"wsfc-erp-go/internal/web"
)

// register 挂全部接口。路径、方法、响应包装形态与 Python 逐一对齐；
// 未在这里出现的接口由 withFallback 回源 Python（迁移期两边并行）。
func (s *Server) register(rt *router) {
	// 认证 / 分仓 / 系统
	rt.Post("/api/auth/login", s.Login)
	rt.Post("/api/auth/logout", s.Logout)
	rt.Get("/api/auth/me", s.Me)
	rt.Get("/api/warehouses", s.Warehouses)
	rt.Post("/api/warehouses", s.CreateWarehouse)
	rt.Post("/api/warehouses/switch", s.SwitchWarehouse)
	rt.Post("/api/uploads", s.Uploads)
	rt.Get("/api/maintenance/status", s.MaintenanceStatus)
	rt.Get("/health", s.Health)
	rt.Get("/api/_meta/routes", s.MetaRoutes)
	// 工作台 / 商品
	rt.Get("/api/dashboard", s.Dashboard)
	rt.Get("/api/products", s.Products)
	rt.Post("/api/products", s.CreateProduct)
	rt.Put("/api/products/{pid}", s.UpdateProduct)
	rt.Delete("/api/products/{pid}", s.DeleteProduct)
	rt.Post("/api/products/batch-delete", s.BatchDeleteProducts)
	rt.Post("/api/products/batch-update", s.BatchUpdateProducts)
	rt.Get("/api/stocks", s.Stocks)
	rt.Get("/api/units", s.Units)
	rt.Post("/api/units", s.CreateUnit)
	rt.Delete("/api/units/{uid}", s.DeleteUnit)
	// 入库
	rt.Get("/api/inbounds", s.Inbounds)
	rt.Post("/api/inbounds", s.CreateInbound)
	rt.Post("/api/inbounds/batch", s.BatchCreateInbounds)
	rt.Put("/api/inbounds/{rid}", s.UpdateInbound)
	rt.Delete("/api/inbounds/{rid}", s.DeleteInbound)
	rt.Post("/api/inbounds/batch-delete", s.BatchDeleteInbounds)
	// 出库
	rt.Post("/api/outbounds/preview", s.PreviewOutbound)
	rt.Get("/api/outbounds", s.Outbounds)
	rt.Post("/api/outbounds", s.CreateOutbound)
	rt.Put("/api/outbounds/{oid}", s.UpdateOutbound)
	rt.Delete("/api/outbounds/{oid}", s.DeleteOutbound)
	rt.Post("/api/outbounds/batch-delete", s.BatchDeleteOutbounds)
	// 库存 / 盘点
	rt.Get("/api/movements", s.Movements)
	rt.Get("/api/movements/chart", s.MovementsChart)
	rt.Post("/api/adjust", s.Adjust)
	rt.Get("/api/adjustments", s.Adjustments)
	rt.Delete("/api/adjustments/{gid}", s.DeleteAdjustment)
	rt.Get("/api/stock-overview", s.StockOverview)
	rt.Get("/api/workload", s.Workload)
	// 鲜货
	rt.Get("/api/fresh", s.Fresh)
	rt.Get("/api/fresh/options", s.FreshOptions)
	rt.Post("/api/fresh/config", s.SaveFreshConfig)
	// 其他开支 / 扣点 / 快递 / 打包规则
	rt.Get("/api/other-expenses", s.OtherExpenses)
	rt.Get("/api/other-expenses/stats", s.OtherExpenseStats)
	rt.Post("/api/other-expenses", s.CreateOtherExpense)
	rt.Put("/api/other-expenses/{eid}", s.UpdateOtherExpense)
	rt.Delete("/api/other-expenses/{eid}", s.DeleteOtherExpense)
	rt.Get("/api/deductions", s.Deductions)
	rt.Get("/api/deductions/shops", s.ShopDeductions)
	rt.Post("/api/deductions/shops", s.UpsertShopDeduction)
	rt.Delete("/api/deductions/shops/{shop}", s.DeleteShopDeduction)
	rt.Post("/api/deductions", s.UpsertDeduction)
	rt.Delete("/api/deductions/{did}", s.DeleteDeduction)
	rt.Get("/api/express/rule", s.ExpressRule)
	rt.Put("/api/express/rule", s.SaveExpressRule)
	rt.Get("/api/pack-rules", s.PackRules)
	rt.Post("/api/pack-rules", s.CreatePackRule)
	rt.Put("/api/pack-rules/{rid}", s.UpdatePackRule)
	rt.Delete("/api/pack-rules/{rid}", s.DeletePackRule)
	// 账单 / 财务
	rt.Get("/api/payables", s.Payables)
	rt.Post("/api/payables/pay", s.PayBill)
	rt.Post("/api/payables/pay-batch", s.PayBillsBatch)
	rt.Get("/api/payables/dropship", s.DropshipBills)
	rt.Get("/api/finance", s.Finance)
	rt.Post("/api/finance", s.CreateFinance)
	rt.Delete("/api/finance/{fid}", s.DeleteFinance)
	// 入仓（warehouse_in 模块）
	s.registerWarehouseIn(rt)
	// 批量导入 / 聚水潭出库单 / 编码关联（imports 模块）
	s.registerImports(rt)
	// 报表（report 模块补齐）
	s.registerReport(rt)
	// 备份（backup 模块）
	s.registerBackup(rt)
	// 自动出库（聚水潭）
	s.registerJstAuto(rt)
	// 商品资料同步（product_data 模块）
	s.registerProductData(rt)
	// 对外成本表 + 鲜货需求预演算（open_api / fresh plan）
	s.registerOpenFresh(rt)
	// AI 智能录入（ai 模块）
	s.registerAI(rt)
}

// MetaRoutes GET /api/_meta/routes（迁移核对：Go 已接管的接口清单）。
func (s *Server) MetaRoutes(w http.ResponseWriter, r *http.Request) {
	items := make([]map[string]any, 0, len(s.rt.routes))
	for _, ro := range s.rt.routes {
		items = append(items, map[string]any{"method": ro.Method, "path": ro.Pattern})
	}
	sort.Slice(items, func(i, j int) bool {
		if web.ToStr(items[i]["path"]) != web.ToStr(items[j]["path"]) {
			return web.ToStr(items[i]["path"]) < web.ToStr(items[j]["path"])
		}
		return web.ToStr(items[i]["method"]) < web.ToStr(items[j]["method"])
	})
	web.Write(w, http.StatusOK, map[string]any{"count": len(items), "routes": items})
}
