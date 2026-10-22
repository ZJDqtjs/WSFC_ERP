package erp

// ---------------- Excel 读取：逐格复刻 openpyxl load_workbook(data_only=True) + iter_rows(values_only=True)
//
// imports.py 里所有表头识别、单元格取值都建立在「单元格的 Python 对象」之上：
//   - 数字：底层存 "5" 的是一般整型（int），存 "5.5"/"5E0" 的是浮点（float），str() 结果分别是 "5" / "5.5"
//   - 日期：数字序列 + 样式里的日期格式码 → datetime，str() 是 "2026-10-19 00:00:00"
//   - 布尔：True/False；字符串：原样；错误单元格：错误码字符串；空：None
// 因此这里不用 excelize 的高层取值（它会做本地化格式化），而是直接解 xlsx 里的 XML，
// 保证 Go 侧拿到的类型与 Python 完全一致（否则 to_float/cell/norm_date 的口径都会偏）。

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ImpError 读取失败（对齐 Python 的 HTTPException(400, "无法读取文件，请上传 .xlsx 格式")）。
var impErrRead = ErrText("无法读取文件，请上传 .xlsx 格式")

type impNumFmtDef struct {
	id   int
	code string
}

type impXlsx struct {
	raw       []byte
	cellXfs   []int // 样式索引 -> numFmtId
	numFmts   map[int]string
	date1904  bool
	sheetPath string
	shared    []string
}

// impOpen 解 zip 并读出口径所需的最小信息（第一个工作表，等价 wb.worksheets[0]）。
func impOpen(data []byte) (*impXlsx, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, impErrRead
	}
	x := &impXlsx{numFmts: map[int]string{}, raw: data}
	read := func(name string) ([]byte, error) {
		for _, f := range zr.File {
			if strings.TrimPrefix(f.Name, "/") == name {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(rc)
			}
		}
		return nil, fmt.Errorf("missing %s", name)
	}
	// workbook.xml：第一个 sheet 的 r:id + date1904
	wb, err := read("xl/workbook.xml")
	if err != nil {
		return nil, impErrRead
	}
	var firstSheetID, target string
	x.date1904 = bytes.Contains(wb, []byte("date1904=\"1\"")) || bytes.Contains(wb, []byte("date1904=\"true\""))
	dec := xml.NewDecoder(bytes.NewReader(wb))
	inSheets := false
	for {
		tk, err := dec.Token()
		if err != nil {
			break
		}
		switch t := tk.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "sheets":
				inSheets = true
			case "sheet":
				if inSheets && firstSheetID == "" {
					for _, a := range t.Attr {
						switch a.Name.Local {
						case "id":
							firstSheetID = a.Value // r:id
						}
					}
				}
			}
		case xml.EndElement:
			if t.Name.Local == "sheets" {
				inSheets = false
			}
		}
	}
	if firstSheetID == "" {
		return nil, impErrRead
	}
	rels, err := read("xl/_rels/workbook.xml.rels")
	if err == nil {
		dec = xml.NewDecoder(bytes.NewReader(rels))
		for {
			tk, err := dec.Token()
			if err != nil {
				break
			}
			if st, ok := tk.(xml.StartElement); ok && st.Name.Local == "Relationship" {
				var id, tgt string
				for _, a := range st.Attr {
					switch a.Name.Local {
					case "Id":
						id = a.Value
					case "Target":
						tgt = a.Value
					}
				}
				if id == firstSheetID {
					target = tgt
				}
			}
		}
	}
	switch {
	case target == "":
		x.sheetPath = "xl/worksheets/sheet1.xml"
	case strings.HasPrefix(target, "/"):
		x.sheetPath = strings.TrimPrefix(target, "/")
	default:
		x.sheetPath = "xl/" + target
	}
	// styles.xml：cellXfs 顺序 + 自定义 numFmt
	if st, err := read("xl/styles.xml"); err == nil {
		dec = xml.NewDecoder(bytes.NewReader(st))
		mode := ""
		idx := 0
		for {
			tk, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tk.(type) {
			case xml.StartElement:
				switch t.Name.Local {
				case "numFmts":
					mode = "numFmts"
				case "numFmt":
					if mode == "numFmts" {
						var id int
						var code string
						for _, a := range t.Attr {
							switch a.Name.Local {
							case "numFmtId":
								id, _ = strconv.Atoi(a.Value)
							case "formatCode":
								code = a.Value
							}
						}
						x.numFmts[id] = code
					}
				case "cellXfs":
					mode = "cellXfs"
				case "xf":
					if mode == "cellXfs" {
						var id int
						for _, a := range t.Attr {
							if a.Name.Local == "numFmtId" {
								id, _ = strconv.Atoi(a.Value)
							}
						}
						x.cellXfs = append(x.cellXfs, id)
						idx++
					}
				}
			case xml.EndElement:
				if t.Name.Local == "numFmts" || t.Name.Local == "cellXfs" {
					mode = ""
				}
			}
		}
	}
	// sharedStrings.xml
	if ss, err := read("xl/sharedStrings.xml"); err == nil {
		dec = xml.NewDecoder(bytes.NewReader(ss))
		var cur strings.Builder
		inSI := false
		for {
			tk, err := dec.Token()
			if err != nil {
				break
			}
			switch t := tk.(type) {
			case xml.StartElement:
				switch t.Name.Local {
				case "si":
					inSI = true
					cur.Reset()
				case "t":
					if inSI {
						_ = dec.DecodeElement(&cur, &t)
					}
				}
			case xml.EndElement:
				if t.Name.Local == "si" {
					x.shared = append(x.shared, cur.String())
					inSI = false
				}
			}
		}
	}
	return x, nil
}

// isDateStyle 判断某个样式索引是不是日期/时间格式（口径同 openpyxl 的 is_date_format）。
func (x *impXlsx) isDateStyle(style int) bool {
	if style < 0 || style >= len(x.cellXfs) {
		return false
	}
	return x.fmtIsDate(x.cellXfs[style])
}

var impBuiltinDateFmt = func() map[int]bool {
	m := map[int]bool{}
	for _, ids := range [][2]int{{14, 22}, {27, 36}, {45, 47}, {50, 58}} {
		for i := ids[0]; i <= ids[1]; i++ {
			m[i] = true
		}
	}
	return m
}()

var impReFmtQuoted = regexp.MustCompile(`"[^"]*"|'[^']*'|\\[^\s]|_\([^)]*\)|\[[^\]]*\]|[@;]`)
var impReFmtDateLetter = regexp.MustCompile(`(?i)[ymdhs]`)

// 判断格式码是否日期/时间格式：先保护 [h]/[m]/[s] 这类时长占位，再剥掉字面量与括号段，
// 剩下的字符里出现 y/m/d/h/s 就算日期（口径同 openpyxl 的 is_date_format）。
func impStripFmtLiterals(code string) string {
	code = impReFmtDuration.ReplaceAllString(code, "\x00")
	code = impReFmtQuoted.ReplaceAllString(code, "")
	code = strings.ReplaceAll(code, "\x00", "h")
	return code
}

var impReFmtDuration = regexp.MustCompile(`(?i)\[[hms]+\]`)

func (x *impXlsx) fmtIsDate(id int) bool {
	if code, ok := x.numFmts[id]; ok {
		return impReFmtDateLetter.MatchString(impStripFmtLiterals(code))
	}
	return impBuiltinDateFmt[id]
}

// Rows 读整张表，每格返回 Python 语义的 any（nil / string / int / float64 / bool / time.Time）。
func (x *impXlsx) Rows() ([][]any, error) {
	zr, err := zip.NewReader(bytes.NewReader(x.raw), int64(len(x.raw)))
	if err != nil {
		return nil, impErrRead
	}
	var sheetXML []byte
	for _, f := range zr.File {
		if strings.TrimPrefix(f.Name, "/") == x.sheetPath {
			rc, err := f.Open()
			if err != nil {
				return nil, impErrRead
			}
			sheetXML, err = io.ReadAll(rc)
			rc.Close()
			if err != nil {
				return nil, impErrRead
			}
			break
		}
	}
	if sheetXML == nil {
		return nil, impErrRead
	}
	out := [][]any{}
	dec := xml.NewDecoder(bytes.NewReader(sheetXML))
	var (
		row       []any
		rowNum    int
		colPtr    int
		maxCol    int
		curT      string
		curStyle  int
		curInline strings.Builder
		inValue   bool
		valueBuf  strings.Builder
		hasCell   bool
		sawText   bool
	)
	flushRow := func() {
		for len(row) < maxCol {
			row = append(row, nil)
		}
		out = append(out, row)
		row = nil
		colPtr = 0
	}
	put := func(col int, v any) {
		for len(row) <= col {
			row = append(row, nil)
		}
		row[col] = v
		if col+1 > maxCol {
			maxCol = col + 1
		}
	}
	for {
		tk, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, impErrRead
		}
		switch t := tk.(type) {
		case xml.StartElement:
			switch t.Name.Local {
			case "row":
				r := 0
				for _, a := range t.Attr {
					if a.Name.Local == "r" {
						r, _ = strconv.Atoi(a.Value)
					}
				}
				if r == 0 {
					r = rowNum + 1
				}
				for rowNum < r-1 {
					flushRow()
					rowNum++
				}
				rowNum = r
				row = nil
				colPtr = 0
			case "c":
				hasCell = true
				curT = ""
				curStyle = -1
				ref := ""
				for _, a := range t.Attr {
					switch a.Name.Local {
					case "t":
						curT = a.Value
					case "s":
						curStyle, _ = strconv.Atoi(a.Value)
					case "r":
						ref = a.Value
					}
				}
				col := colPtr
				if ref != "" {
					if c, err := impColIndex(ref); err == nil {
						col = c
					}
				}
				colPtr = col + 1
				curInline.Reset()
				valueBuf.Reset()
				sawText = false
				_ = col
			case "v", "t":
				inValue = true
				valueBuf.Reset()
				if t.Name.Local == "t" {
					sawText = true
				}
			case "is":
				curInline.Reset()
			}
		case xml.EndElement:
			switch t.Name.Local {
			case "v", "t":
				inValue = false
			case "c":
				if !hasCell {
					continue
				}
				hasCell = false
				col := colPtr - 1
				if col < 0 {
					continue
				}
				raw := valueBuf.String()
				if curInline.Len() > 0 {
					raw = curInline.String()
				}
				put(col, x.cellValue(curT, curStyle, raw, sawText))
			case "row":
				flushRow()
				rowNum++
			}
		case xml.CharData:
			if inValue {
				valueBuf.Write(t)
			}
		}
	}
	return out, nil
}

// cellValue 把一个单元格的 XML 表示转成 openpyxl 会给的 Python 对象。
func (x *impXlsx) cellValue(t string, style int, raw string, sawText bool) any {
	switch t {
	case "inlineStr":
		// <c r="H2" t="inlineStr"/> 这种空内联串，openpyxl 给的是 None 而不是 ""
		if !sawText && raw == "" {
			return nil
		}
		return raw
	case "", "n":
		if raw == "" {
			return nil
		}
		if x.isDateStyle(style) {
			f, err := strconv.ParseFloat(raw, 64)
			if err == nil {
				return impSerialToTime(f, x.date1904)
			}
			return raw
		}
		if strings.ContainsAny(raw, ".eE") {
			if f, err := strconv.ParseFloat(raw, 64); err == nil {
				return f
			}
			return raw
		}
		if i, err := strconv.ParseInt(raw, 10, 64); err == nil {
			return int(i)
		}
		if f, err := strconv.ParseFloat(raw, 64); err == nil {
			return f
		}
		return raw
	case "s":
		i, err := strconv.Atoi(strings.TrimSpace(raw))
		if err == nil && i >= 0 && i < len(x.shared) {
			return x.shared[i]
		}
		return ""
	case "b":
		return strings.TrimSpace(raw) == "1"
	case "d": // ISO8601 日期（t="d"）
		if tt, err := time.Parse(time.RFC3339, strings.TrimSpace(raw)); err == nil {
			return tt
		}
		return raw
	case "e", "str":
		return raw
	default:
		return raw
	}
}

// impColIndex "BC12" -> 列下标（0 基）。
func impColIndex(ref string) (int, error) {
	i := 0
	n := 0
	for i < len(ref) {
		c := ref[i]
		if c < 'A' || c > 'Z' {
			break
		}
		n = n*26 + int(c-'A') + 1
		i++
	}
	if n == 0 {
		return 0, fmt.Errorf("bad ref %q", ref)
	}
	return n - 1, nil
}

var impExcelEpoch = time.Date(1899, 12, 30, 0, 0, 0, 0, time.UTC)
var impExcelEpoch1904 = time.Date(1904, 1, 1, 0, 0, 0, 0, time.UTC)

// impSerialToTime Excel 日期序列 -> time.Time（openpyxl 用本地无时区的 naive datetime）。
func impSerialToTime(serial float64, d1904 bool) time.Time {
	if math.IsNaN(serial) || math.IsInf(serial, 0) {
		return impExcelEpoch
	}
	base := impExcelEpoch
	if d1904 {
		base = impExcelEpoch1904
	} else if serial < 60 {
		// 1900 体系里 60 号之前没有那个不存在的 2 月 29 日，起点要往后挪一天
		base = impExcelEpoch.Add(24 * time.Hour)
	}
	whole := math.Floor(serial)
	ns := int64(math.Round((serial - whole) * float64(24*time.Hour)))
	if ns >= int64(24*time.Hour) { // 显示精度四舍五入进位到第二天
		whole++
		ns = 0
	}
	return base.Add(time.Duration(whole) * 24 * time.Hour).Add(time.Duration(ns))
}

// ImpReadRows POST /api/import/* 的文件解析入口（等价 read_rows）。
func ImpReadRows(data []byte) ([][]any, error) {
	x, err := impOpen(data)
	if err != nil {
		return nil, err
	}
	return x.Rows()
}

// ---------------- 单元格取值小工具（对齐 imports.py 顶部那几个函数） ----------------

// ImpCellText Python str(v)：None/True/False/浮点 repr/整型/日期时间。
func ImpCellText(v any) string {
	switch x := v.(type) {
	case nil:
		return "None"
	case bool:
		if x {
			return "True"
		}
		return "False"
	case string:
		return x
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return PyFloatRepr(x)
	case time.Time:
		return impDateTimeStr(x)
	}
	return fmt.Sprintf("%v", v)
}

// impDateTimeStr str(datetime)：微秒为 0 时不输出小数秒，否则去掉尾部 0。
func impDateTimeStr(t time.Time) string {
	s := t.Format("2006-01-02 15:04:05")
	if us := t.Nanosecond() / 1000; us != 0 {
		return s + "." + strings.TrimRight(fmt.Sprintf("%06d", us), "0")
	}
	return s
}

var impReWhitespace = regexp.MustCompile(`\s+`)

// ImpNorm _norm(s)：str(s or "") 去全部空白再小写。
func ImpNorm(v any) string {
	if !truthyPy(v) {
		return ""
	}
	return strings.ToLower(impReWhitespace.ReplaceAllString(ImpCellText(v), ""))
}

// ImpNormCell _norm_cell(c)：表头单元格去空白、去星号。
func ImpNormCell(v any) string {
	if v == nil {
		return ""
	}
	return strings.TrimSpace(strings.TrimSpace(strings.ReplaceAll(ImpCellText(v), "*", "")))
}

// ImpCellRaw 取原始单元格对象（越界/空 -> nil）。
func ImpCellRaw(row []any, idx int) any {
	if idx < 0 || idx >= len(row) {
		return nil
	}
	return row[idx]
}

// ImpCell cell(row, idx, default)：转字符串并 strip。
func ImpCell(row []any, idx int, def string) string {
	if idx < 0 || idx >= len(row) {
		return def
	}
	v := row[idx]
	if v == nil {
		return def
	}
	return strings.TrimSpace(ImpCellText(v))
}

// ImpToFloat to_float(v, default)：先去货币符号/千分位，失败再抽数字。
func ImpToFloat(v any, def float64) float64 {
	if v == nil {
		return def
	}
	s := strings.TrimSpace(ImpCellText(v))
	if s == "" {
		return def
	}
	for _, rep := range [][2]string{{"￥", ""}, {"¥", ""}, {"元", ""}, {"，", ","}, {"；", ";"}} {
		s = strings.ReplaceAll(s, rep[0], rep[1])
	}
	s = strings.ReplaceAll(s, " ", "")
	s = strings.ReplaceAll(s, "\u00a0", "")
	s = strings.TrimSuffix(s, "元")
	s = strings.ReplaceAll(s, ",", "")
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return f
	}
	cleaned := impReNonNumeric.ReplaceAllString(s, "")
	switch cleaned {
	case "", "-", "+", ".", "-.", "+.":
		return def
	}
	if f, err := strconv.ParseFloat(cleaned, 64); err == nil {
		return f
	}
	return def
}

var impReNonNumeric = regexp.MustCompile(`[^\d\-+\.]+`)

// ImpNormDate norm_date(v)：datetime -> YYYY-MM-DD；字符串里带 4 位年 + / 或 - 分隔则规范化。
func ImpNormDate(v any) string {
	if t, ok := v.(time.Time); ok {
		return t.Format("2006-01-02")
	}
	s := strings.TrimSpace(ImpCellText(v))
	m := impReDateParts.FindStringSubmatch(s)
	if m != nil {
		y, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		d, _ := strconv.Atoi(m[3])
		return fmt.Sprintf("%04d-%02d-%02d", y, mo, d)
	}
	return s
}

var impReDateParts = regexp.MustCompile(`(\d{4})[/\-](\d{1,2})[/\-](\d{1,2})`)

// ImpDetectHeader detect_header(rows, aliases)：前 20 行里找命中两个以上别名的行。
func ImpDetectHeader(rows [][]any, aliases map[string][]string) (map[string]int, int) {
	flat := map[string]bool{}
	for _, names := range aliases {
		for _, n := range names {
			flat[n] = true
		}
	}
	limit := len(rows)
	if limit > 20 {
		limit = 20
	}
	for idx := 0; idx < limit; idx++ {
		hits := 0
		seen := map[string]bool{}
		for _, c := range rows[idx] {
			t := ImpNormCell(c)
			if t == "" || seen[t] {
				continue
			}
			if flat[t] {
				seen[t] = true
				hits++
			}
		}
		if hits >= 2 {
			mapping := map[string]int{}
			for i, c := range rows[idx] {
				t := ImpNormCell(c)
				if t == "" {
					continue
				}
				for field, names := range aliases {
					for _, n := range names {
						if t == n {
							mapping[field] = i
						}
					}
				}
			}
			return mapping, idx + 1
		}
	}
	return map[string]int{}, 0
}
