package api

// 本文件声明批量导入模块各请求体的 pydantic 模型（字段名、类型、默认值、声明顺序
// 与 Python routers/imports.py 逐字一致），交给 warehouse_in_validate.go 的通用校验器
// 复刻 422 明细与 model_dump() 口径。

// DraftLine（imports.py:506）
var impDraftLineFields = []whField{
	{Name: "product_id", Kind: whKindInt, Required: true},
	{Name: "product_name", Kind: whKindStr, Def: ""},
	{Name: "unit", Kind: whKindStr, Required: true},
	{Name: "quantity", Kind: whKindFloat, Required: true},
	{Name: "price", Kind: whKindFloat, Required: true},
	{Name: "amount", Kind: whKindFloat, Def: 0.0},
	{Name: "gross_sales", Kind: whKindFloat, Def: 0.0},
	{Name: "deduct", Kind: whKindStr, Def: ""},
	{Name: "spec", Kind: whKindStr, Def: ""},
	{Name: "stock_product_id", Kind: whKindOptInt},
	{Name: "multiplier", Kind: whKindFloat, Def: 1.0},
}

// DraftOrder（imports.py:520）
var impDraftOrderFields = []whField{
	{Name: "doc_no", Kind: whKindStr, Def: ""},
	{Name: "date", Kind: whKindStr, Required: true},
	{Name: "customer", Kind: whKindStr, Def: ""},
	{Name: "operator", Kind: whKindStr, Def: ""},
	{Name: "remark", Kind: whKindStr, Def: ""},
	{Name: "pack_fee", Kind: whKindFloat, Def: 0.0},
	{Name: "pack_rule_id", Kind: whKindOptInt},
	{Name: "pack_rule_name", Kind: whKindStr, Def: ""},
	{Name: "pack_lines", Kind: whKindAnyList, Def: []any{}},
	{Name: "warehouse", Kind: whKindStr, Def: ""},
	{Name: "brush_fee_auto", Kind: whKindFloat, Def: 0.0},
	{Name: "brush_cost", Kind: whKindFloat, Def: 0.0},
	{Name: "brush_fee", Kind: whKindFloat, Def: 0.0},
	{Name: "lines", Kind: whKindModelList, Def: []any{}, Sub: impDraftLineFields},
}

// ConfirmOutIn（imports.py:538，出库确认与聚水潭确认共用）
var impConfirmOutFields = []whField{
	{Name: "orders", Kind: whKindModelList, Def: []any{}, Sub: impDraftOrderFields},
	{Name: "source", Kind: whKindStr, Def: ""},
}

// DraftInbound（imports.py:357）
var impDraftInboundFields = []whField{
	{Name: "product_id", Kind: whKindInt, Required: true},
	{Name: "product_name", Kind: whKindStr, Def: ""},
	{Name: "unit", Kind: whKindStr, Required: true},
	{Name: "quantity", Kind: whKindFloat, Required: true},
	{Name: "unit_price", Kind: whKindFloat, Required: true},
	{Name: "freight", Kind: whKindFloat, Def: 0.0},
	{Name: "handling", Kind: whKindFloat, Def: 0.0},
	{Name: "supplier", Kind: whKindStr, Def: ""},
	{Name: "date", Kind: whKindStr, Required: true},
	{Name: "operator", Kind: whKindStr, Def: ""},
	{Name: "remark", Kind: whKindStr, Def: ""},
}

// ConfirmInboundIn（imports.py:372）
var impConfirmInboundFields = []whField{
	{Name: "items", Kind: whKindModelList, Def: []any{}, Sub: impDraftInboundFields},
}

// JstRuleItem（imports.py:1031）
var impJstRuleItemFields = []whField{
	{Name: "external_code", Kind: whKindStr, Required: true},
	{Name: "quantity", Kind: whKindFloat, Def: 1.0},
	{Name: "product_id", Kind: whKindOptInt},
}

// JstRuleIn（imports.py:1037）
var impJstRuleInFields = []whField{
	{Name: "doc_no", Kind: whKindStr, Def: ""},
	{Name: "items", Kind: whKindModelList, Def: []any{}, Sub: impJstRuleItemFields},
}

// MappingIn（imports.py:1710）
var impMappingInFields = []whField{
	{Name: "source", Kind: whKindStr, Def: "jushuitan"},
	{Name: "external_code", Kind: whKindStr, Required: true},
	{Name: "product_id", Kind: whKindOptInt},
}

// MappingBulkIn（imports.py:1716，items 无默认值 → 必填）
var impMappingBulkInFields = []whField{
	{Name: "source", Kind: whKindStr, Def: "jushuitan"},
	{Name: "items", Kind: whKindModelList, Required: true, Sub: impMappingInFields},
}

// AiMappingsIn（imports.py:1764）
var impAiMappingsInFields = []whField{
	{Name: "source", Kind: whKindStr, Def: "jushuitan"},
	{Name: "codes", Kind: whKindStrList, Def: []any{}},
	{Name: "apply", Kind: whKindBool, Def: true},
	{Name: "plan", Kind: whKindOptDict},
}
