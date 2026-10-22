// Command xlsxprobe 把 internal/erp 的单元格读取结果按 Python 的 str(v) 打印出来，
// 与 _diff/xlsx_dump.py（openpyxl 基准）逐行对比，用于验证移植后的 Excel 口径。
package main

import (
	"fmt"
	"os"
	"strconv"
	"time"
	"wsfc-erp-go/internal/erp"
)

func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	maxRows := 1 << 30
	if len(os.Args) > 2 {
		maxRows, _ = strconv.Atoi(os.Args[2])
	}
	rows, err := erp.ImpReadRows(data)
	if err != nil {
		fmt.Println("ERR", err)
		return
	}
	for ri, row := range rows {
		if ri >= maxRows {
			break
		}
		for ci, c := range row {
			fmt.Printf("%d,%d\t%s\t%s\n", ri, ci, impTypeName(c), erp.ImpCellText(c))
		}
	}
}

func impTypeName(v any) string {
	switch v.(type) {
	case nil:
		return "NoneType"
	case bool:
		return "bool"
	case string:
		return "str"
	case int, int64:
		return "int"
	case float64:
		return "float"
	case time.Time:
		return "datetime"
	}
	return fmt.Sprintf("%T", v)
}
