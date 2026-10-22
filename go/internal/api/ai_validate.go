package api

// AI 模块（routers/ai.py）的请求体模型声明，字段顺序即 Pydantic 的 422 报错顺序。

// ParseIn：text 必填，hint/prev 是连续对话用的（追问 + 上一次识别结果）。
var aiParseInFields = []whField{
	{Name: "text", Kind: whKindStr, Required: true},
	{Name: "hint", Kind: whKindStr, Def: ""},
	{Name: "prev", Kind: whKindStr, Def: ""},
}

// OutboundPreviewIn：确认框改了商品/数量后重算关联结算；lines/charges 是裸 dict 列表，
// fee_total 为「用户直接改过的固定成本」（float | None）。
var aiOutboundPreviewFields = []whField{
	{Name: "lines", Kind: whKindDictList, Def: []any{}},
	{Name: "charges", Kind: whKindDictList, Def: []any{}},
	{Name: "fee_total", Kind: whKindOptFloat},
}

// NewProductIn / MaterializeIn：确认提交时把识别出的新物品真正建档。
var aiNewProductFields = []whField{
	{Name: "name", Kind: whKindStr, Required: true},
	{Name: "category", Kind: whKindStr, Def: "stock"},
	{Name: "unit", Kind: whKindStr, Def: ""},
}

var aiMaterializeInFields = []whField{
	{Name: "items", Kind: whKindModelList, Required: true, Sub: aiNewProductFields},
}

// MemoryIn：手动记一条规则（text 必填字符串）。
var aiMemoryInFields = []whField{
	{Name: "text", Kind: whKindStr, Required: true},
}
