package erp

import (
	"strconv"
	"time"
)

// ShiftDate 按天偏移（YYYY-MM-DD 字符串，本地无时区）。
func ShiftDate(s string, days int) string {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return s
	}
	return t.AddDate(0, 0, days).Format("2006-01-02")
}

func shiftDate(s string, days int) string { return ShiftDate(s, days) }

// DaysBetween 两个日期相差的天数（end-start）。
func DaysBetween(start, end string) int {
	a, err1 := time.Parse("2006-01-02", start)
	b, err2 := time.Parse("2006-01-02", end)
	if err1 != nil || err2 != nil {
		return 0
	}
	return int(b.Sub(a).Hours() / 24)
}

func daysBetween(start, end string) int { return DaysBetween(start, end) }

// ListDates 列出 [start, end] 区间内的每一天。
func ListDates(start, end string) []string {
	a, err1 := time.Parse("2006-01-02", start)
	b, err2 := time.Parse("2006-01-02", end)
	if err1 != nil || err2 != nil {
		return []string{start}
	}
	out := []string{}
	for d := a; !d.After(b); d = d.AddDate(0, 0, 1) {
		out = append(out, d.Format("2006-01-02"))
	}
	return out
}

func listDates(start, end string) []string { return ListDates(start, end) }

// MustAtoi 宽松整数解析。
func MustAtoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}

