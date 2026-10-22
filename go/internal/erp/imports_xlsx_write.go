package erp

// ---------------- 极简 xlsx 写出（模板下载用）----------------
//
// openpyxl 的读写在 imports_xlsx.go 里已对齐，这里只需要「能生成 Excel 能打开的工作簿」：
// 单 sheet、内联字符串（省掉 sharedStrings）、数字按数值写入、可选列宽与首行冻结。

import (
	"archive/zip"
	"bytes"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// ImpXlsxSheet 一个工作表：名称 + 行（单元格为 string/float64/int/bool/nil）+ 列宽 + 冻结首行。
type ImpXlsxSheet struct {
	Name           string
	Rows           [][]any
	ColWidths      []float64
	FreezeFirstRow bool
}

// impCellRef A1 式引用（只支持到 ZZ 列，模板用不到更多）。
func impCellRef(col, row int) string {
	var b strings.Builder
	for c := col + 1; c > 0; c /= 26 {
		rem := (c - 1) % 26
		b.WriteRune(rune('A' + rem))
	}
	r := []rune(b.String())
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r) + strconv.Itoa(row+1)
}

func impXlsxNumber(v float64) string {
	if v == math.Trunc(v) && math.Abs(v) < 1e15 {
		return strconv.FormatInt(int64(v), 10)
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// impSheetXML 渲染一个 worksheet。
func impSheetXML(s ImpXlsxSheet) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` + "\n")
	b.WriteString(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`)
	if s.FreezeFirstRow {
		b.WriteString(`<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`)
	}
	if len(s.ColWidths) > 0 {
		b.WriteString(`<cols>`)
		for i, w := range s.ColWidths {
			fmt.Fprintf(&b, `<col min="%d" max="%d" width="%s" customWidth="1"/>`, i+1, i+1, strconv.FormatFloat(w, 'g', -1, 64))
		}
		b.WriteString(`</cols>`)
	}
	b.WriteString(`<sheetData>`)
	for r, row := range s.Rows {
		if len(row) == 0 {
			continue
		}
		fmt.Fprintf(&b, `<row r="%d">`, r+1)
		for c, cell := range row {
			ref := impCellRef(c, r)
			switch v := cell.(type) {
			case nil:
			case string:
				if v == "" {
					continue
				}
				fmt.Fprintf(&b, `<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`, ref, xmlEsc(v))
			case bool:
				if v {
					fmt.Fprintf(&b, `<c r="%s" t="b"><v>1</v></c>`, ref)
				}
			case int:
				fmt.Fprintf(&b, `<c r="%s"><v>%d</v></c>`, ref, v)
			case float64:
				fmt.Fprintf(&b, `<c r="%s"><v>%s</v></c>`, ref, impXlsxNumber(v))
			default:
				fmt.Fprintf(&b, `<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`, ref, xmlEsc(fmt.Sprint(v)))
			}
		}
		b.WriteString(`</row>`)
	}
	b.WriteString(`</sheetData></worksheet>`)
	return b.String()
}

// xmlEsc 转义 XML 文本节点：只处理 & < >（以及控制字符剔除），中文保持原生 UTF-8。
func xmlEsc(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '"':
			b.WriteString("&quot;")
		default:
			if r < 0x20 && r != '\t' && r != '\n' && r != '\r' {
				continue
			}
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ImpWriteXlsx 生成 xlsx 字节串。
func ImpWriteXlsx(sheets []ImpXlsxSheet) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name, body string) error {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = w.Write([]byte(body))
		return err
	}

	var overrides strings.Builder
	for i := range sheets {
		fmt.Fprintf(&overrides, `<Override PartName="/xl/worksheets/sheet%d.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`, i+1)
	}
	if err := add("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
		`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`+
		`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`+
		`<Default Extension="xml" ContentType="application/xml"/>`+
		`<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`+
		overrides.String()+
		`<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`+
		`</Types>`); err != nil {
		return nil, err
	}
	if err := add("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`+
		`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`+
		`</Relationships>`); err != nil {
		return nil, err
	}

	var wb strings.Builder
	wb.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
		`xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`)
	for i, s := range sheets {
		fmt.Fprintf(&wb, `<sheet name="%s" sheetId="%d" r:id="rId%d"/>`, xmlEsc(s.Name), i+1, i+1)
	}
	wb.WriteString(`</sheets></workbook>`)
	if err := add("xl/workbook.xml", wb.String()); err != nil {
		return nil, err
	}

	var rels strings.Builder
	rels.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
		`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`)
	for i := range sheets {
		fmt.Fprintf(&rels, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet%d.xml"/>`, i+1, i+1)
	}
	fmt.Fprintf(&rels, `<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`, len(sheets)+1)
	rels.WriteString(`</Relationships>`)
	if err := add("xl/_rels/workbook.xml.rels", rels.String()); err != nil {
		return nil, err
	}
	// 最小样式表：一个默认字体 + 两个单元格式（Excel 要求 styles 部件存在）
	if err := add("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`+
		`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`+
		`<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`+
		`<fills count="1"><fill><patternFill patternType="none"/></fill></fills>`+
		`<borders count="1"><border/></borders>`+
		`<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`+
		`<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>`+
		`</styleSheet>`); err != nil {
		return nil, err
	}

	for i, s := range sheets {
		if err := add(fmt.Sprintf("xl/worksheets/sheet%d.xml", i+1), impSheetXML(s)); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
