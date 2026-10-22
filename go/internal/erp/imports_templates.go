package erp

// ---------------- 模板下载（/api/templates/*）----------------
//
// 与 Python _serve_tpl 同口径：backend/docs 下有同名静态文件就直接发（便于人工维护模板），
// 没有则按工厂函数动态生成。
//
// 响应头口径：中文文件名不能直接写进 filename="..."（Starlette 用 latin-1 编响应头会 UnicodeEncodeError），
// 两边都按 RFC 5987 输出 filename*=UTF-8''…。Python 侧原先只有走动态生成分支的
// /api/templates/products 会 500（docs 里没这个静态模板），2026-10-22 已在 _xlsx_response 修掉，
// 现在两侧一致；差异只剩下 xlsx 的 zip 字节（openpyxl 与 Go 写出的压缩元数据不同，内容逐行一致）。

import (
	"os"
	"path/filepath"
)

// ImpDocsDir 模板目录（api 层按 cfg.BackendDir/docs 赋值）。
var ImpDocsDir = ""

// ImpTemplate 取模板字节：静态文件优先，缺失时生成。返回 (内容, 文件名)。
func ImpTemplate(filename string, factory func() ImpXlsxSheet) ([]byte, string, error) {
	if ImpDocsDir != "" {
		p := filepath.Join(ImpDocsDir, filename)
		if raw, err := os.ReadFile(p); err == nil {
			return raw, filename, nil
		}
	}
	data, err := ImpWriteXlsx([]ImpXlsxSheet{factory()})
	if err != nil {
		return nil, filename, err
	}
	return data, filename, nil
}

// ImpTplProducts 商品导入模板（工厂内容与 Python tpl_products 一致）。
func ImpTplProducts() ImpXlsxSheet {
	return ImpXlsxSheet{
		Name: "商品导入",
		Rows: [][]any{
			{"商品编码", "商品名称*", "分类", "规格", "基础单位", "单位换算", "默认售价", "打包费", "关联商品清单"},
			{"", "番茄", "蔬菜", "每个约150克", "克", "克=1;斤=500;公斤=1000;个=150", 0.016, 1, "泡沫箱=1个;泡沫垫=2个"},
			{"ydj001", "土豆", "蔬菜", "", "斤", "克=1;斤=500;公斤=1000", 2, 0, ""},
		},
		ColWidths:      []float64{14, 18, 10, 20, 10, 30, 10, 8, 30},
		FreezeFirstRow: true,
	}
}

// ImpTplInbounds 入库批量导入模板（运费/装卸费为选填列，计入批次成本）。
func ImpTplInbounds() ImpXlsxSheet {
	return ImpXlsxSheet{
		Name: "入库导入",
		Rows: [][]any{
			{"商品编码或名称*", "进货单位*", "数量*", "单价*", "供应商", "日期*", "运费", "装卸费", "操作员", "备注"},
			{"番茄", "斤", 10, 3, "张三菜行", "2026-08-25", 20, 10, "管理员", "运费/装卸费选填，计入成本"},
			{"泡沫箱", "个", 50, 2, "包装厂", "2026-08-25", "", "", "", ""},
		},
		ColWidths:      []float64{20, 12, 10, 10, 16, 14, 12, 12, 12, 16},
		FreezeFirstRow: true,
	}
}

// ImpTplOutbounds 出库批量导入模板（同单号自动合并为一单）。
func ImpTplOutbounds() ImpXlsxSheet {
	return ImpXlsxSheet{
		Name: "出库导入",
		Rows: [][]any{
			{"单号", "日期*", "客户", "商品编码或名称*", "销售单位*", "数量*", "单价*", "打包费", "操作员", "备注"},
			{"单A001", "2026-08-25", "李四", "番茄", "斤", 3, 8, 1, "", ""},
			{"单A001", "2026-08-25", "李四", "泡沫垫", "个", 2, 0, 0, "", "同单号自动合并为一单"},
			{"", "2026-08-25", "王五", "土豆", "公斤", 2, 4, 0, "", "单号留空则每行一单"},
		},
		ColWidths:      []float64{12, 14, 12, 20, 12, 10, 10, 8, 12, 20},
		FreezeFirstRow: true,
	}
}
