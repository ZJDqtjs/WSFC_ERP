package erp

// 本文件对齐 Python backend/app/jst/config.py：时间区间规则（yesterday/d2/last7d/last24h…）
// 与定时点（HH:MM[:区间规则]）的解析与校验。文案逐字照抄 Python（含 repr 形式的引号），
// 因为这些字符串会原样出现在 HTTP 400 的 detail 里。

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// JstWindowYesterday 等三个具名区间规则（Python 里的常量）。
const (
	JstWindowYesterday = "yesterday"
	JstWindowToday     = "today"
	JstWindowLast24h   = "last24h"
)

// JstWindowHelp 区间规则说明（同时用于错误文案的尾部）。
const JstWindowHelp = "可用的区间规则：\n" +
	"  today            今天 00:00 ~ 明天 00:00\n" +
	"  yesterday / d1   昨天 00:00 ~ 今天 00:00\n" +
	"  dN               第 N 天前那一整天，如 d2=前天、d3=大前天\n" +
	"  lastNd           最近 N 个整天，如 last7d=今天往前 7 天\n" +
	"  lastNh           最近 N 小时（向上取整到整点），如 last2h、last24h"

// JstWindowChoices 前端下拉：值 → 说明（顺序与 Python 一致）。
var JstWindowChoices = [][2]string{
	{"yesterday", "昨天 00:00 ~ 今天 00:00"},
	{"today", "今天 00:00 ~ 明天 00:00"},
	{"d2", "前天那一天"},
	{"d3", "大前天那一天"},
	{"last3d", "最近 3 个整天"},
	{"last7d", "最近 7 个整天"},
	{"last24h", "最近 24 小时（按整点）"},
	{"last2h", "最近 2 小时（按整点）"},
}

var (
	reJstDayAgo   = regexp.MustCompile(`^d(\d+)$`)   // d1=昨天，d2=前天
	reJstLastDays = regexp.MustCompile(`^last(\d+)d$`) // last7d=最近 7 个整天
	reJstLastHrs  = regexp.MustCompile(`^last(\d+)h$`) // last2h=最近 2 小时（含 last24h）
)

// pyRepr 复刻 Python 的 str repr（f"{x!r}"）：默认单引号，含单引号且不含双引号时改用双引号。
// 错误文案里带着它，必须与 Python 一致，否则 400 的 detail 对不上。
func pyRepr(s string) string {
	q := byte('\'')
	if strings.Contains(s, "'") && !strings.Contains(s, "\"") {
		q = '"'
	}
	var b strings.Builder
	b.WriteByte(q)
	for _, r := range s {
		switch {
		case r == rune(q) || r == '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case r == '\n':
			b.WriteString("\\n")
		case r == '\r':
			b.WriteString("\\r")
		case r == '\t':
			b.WriteString("\\t")
		case r < 0x20 || r == 0x7f:
			b.WriteString(fmt.Sprintf("\\x%02x", r))
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte(q)
	return b.String()
}

// JstResolveWindow 把区间规则解析成 [start, end)（左闭右开）；无效时返回带 Python 文案的错误。
func JstResolveWindow(window string, now time.Time) (time.Time, time.Time, error) {
	window = strings.ToLower(strings.TrimSpace(orStr(window, JstWindowYesterday)))
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())

	switch window {
	case JstWindowToday:
		return today, today.AddDate(0, 0, 1), nil
	case JstWindowYesterday, "d1":
		return today.AddDate(0, 0, -1), today, nil
	}
	if m := reJstDayAgo.FindStringSubmatch(window); m != nil {
		days, _ := strconv.Atoi(m[1])
		if days < 1 {
			return time.Time{}, time.Time{}, fmt.Errorf("区间规则 %s 无效：N 必须 >= 1\n%s", pyRepr(window), JstWindowHelp)
		}
		end := today.AddDate(0, 0, -days)
		return end.AddDate(0, 0, -1), end, nil
	}
	if m := reJstLastDays.FindStringSubmatch(window); m != nil {
		days, _ := strconv.Atoi(m[1])
		if days < 1 {
			return time.Time{}, time.Time{}, fmt.Errorf("区间规则 %s 无效：N 必须 >= 1\n%s", pyRepr(window), JstWindowHelp)
		}
		return today.AddDate(0, 0, -days), today, nil
	}
	if m := reJstLastHrs.FindStringSubmatch(window); m != nil {
		hours, _ := strconv.Atoi(m[1])
		if hours < 1 {
			return time.Time{}, time.Time{}, fmt.Errorf("区间规则 %s 无效：N 必须 >= 1\n%s", pyRepr(window), JstWindowHelp)
		}
		// 结束点向上取整到下一个整点，保证同一小时内多次运行结果稳定
		end := time.Date(now.Year(), now.Month(), now.Day(), now.Hour(), 0, 0, 0, now.Location()).Add(time.Hour)
		return end.Add(-time.Duration(hours) * time.Hour), end, nil
	}
	return time.Time{}, time.Time{}, fmt.Errorf("无法识别的区间规则 %s\n%s", pyRepr(window), JstWindowHelp)
}

// JstValidWindow 区间规则是否可用（Python valid_window）。
func JstValidWindow(window string) bool {
	_, _, err := JstResolveWindow(window, time.Now())
	return err == nil
}

// JstSchedule 一个定时执行点；Window 为空表示用该分仓配置的区间规则。
// Python 的 @dataclass(frozen=True, order=True) 按 (hour, minute, window) 排序。
type JstSchedule struct {
	Hour   int
	Minute int
	Window string
}

// String 定时点的文本形式（HH:MM 或 HH:MM:区间规则），与 Python __str__ 一致。
func (s JstSchedule) String() string {
	base := fmt.Sprintf("%02d:%02d", s.Hour, s.Minute)
	if s.Window != "" {
		return base + "(" + s.Window + ")"
	}
	return base
}

// JstParseSchedule 解析定时点：["07:30","19:30:today"] 或 "07:30,19:30:today"，去重后升序。
func JstParseSchedule(items any) ([]JstSchedule, error) {
	var raw []string
	switch v := items.(type) {
	case string:
		raw = strings.Split(v, ",")
	case []string:
		raw = v
	case []any:
		for _, it := range v {
			raw = append(raw, ToStr(it))
		}
	case nil:
	default:
		return nil, fmt.Errorf("无法解析定时时间")
	}
	slots := []JstSchedule{}
	seen := map[JstSchedule]bool{}
	for _, item := range raw {
		item = strings.TrimSpace(orStr(item))
		if item == "" {
			continue
		}
		parts := strings.SplitN(item, ":", 3)
		if len(parts) < 2 || !isAllDigits(strings.TrimSpace(parts[0])) || !isAllDigits(strings.TrimSpace(parts[1])) {
			return nil, fmt.Errorf("无法解析定时时间 %s，应为 HH:MM 或 HH:MM:区间规则（如 07:30、19:30:today）", pyRepr(item))
		}
		hour, _ := strconv.Atoi(strings.TrimSpace(parts[0]))
		minute, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
		if !(hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
			return nil, fmt.Errorf("定时时间超出范围: %s（小时 0-23，分钟 0-59）", pyRepr(item))
		}
		window := ""
		if len(parts) > 2 {
			window = strings.ToLower(strings.TrimSpace(parts[2]))
		}
		if window != "" && !JstValidWindow(window) {
			return nil, fmt.Errorf("定时时间 %s 里的区间规则无法识别\n%s", pyRepr(item), JstWindowHelp)
		}
		s := JstSchedule{Hour: hour, Minute: minute, Window: window}
		if !seen[s] {
			seen[s] = true
			slots = append(slots, s)
		}
	}
	// sorted(set(slots))：按 (hour, minute, window) 升序
	sort.SliceStable(slots, func(i, j int) bool {
		a, b := slots[i], slots[j]
		if a.Hour != b.Hour {
			return a.Hour < b.Hour
		}
		if a.Minute != b.Minute {
			return a.Minute < b.Minute
		}
		return a.Window < b.Window
	})
	return slots, nil
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// orStr 实现 Python 的 `x or default`（空串/nil 走默认值）。
func orStr(v string, def ...string) string {
	if v != "" {
		return v
	}
	if len(def) > 0 {
		return def[0]
	}
	return ""
}

// Python strptime 的字段语法：%Y 恰好 4 位，%m/%d/%H/%M/%S 允许不补零，
// 且格式里的空白匹配一段 \\s+；整串必须被消耗完。这里用同样的语法写死三种受支持格式。
var jstDateFormats = []struct {
	name string
	re   *regexp.Regexp
}{
	{"%Y-%m-%d %H:%M:%S", regexp.MustCompile(`^(\d\d\d\d)-(` + jstMonthPat + `)-(` + jstDayPat + `)\s+(` + jstHourPat + `):(` + jstMinSecPat + `):(` + jstMinSecPat + `)$`)},
	{"%Y-%m-%d %H:%M", regexp.MustCompile(`^(\d\d\d\d)-(` + jstMonthPat + `)-(` + jstDayPat + `)\s+(` + jstHourPat + `):(` + jstMinSecPat + `)$`)},
	{"%Y-%m-%d", regexp.MustCompile(`^(\d\d\d\d)-(` + jstMonthPat + `)-(` + jstDayPat + `)$`)},
}

const (
	jstMonthPat  = `1[0-2]|0[1-9]|[1-9]`
	jstDayPat    = `3[01]|[12]\d|0[1-9]|[1-9]`
	jstHourPat   = `2[0-3]|[0-1]\d|\d`
	jstMinSecPat = `[0-5]\d|\d`
)

// JstParseDatetime 解析 2026-09-18 / 2026-09-18 08:00 / 2026-09-18 08:00:00。
// 与 Python parse_datetime 一致：逐个格式尝试，全都不合就报同一条文案（repr 用原始入参）。
func JstParseDatetime(raw string) (time.Time, error) {
	s := strings.TrimSpace(raw)
	for _, f := range jstDateFormats {
		m := f.re.FindStringSubmatch(s)
		if m == nil {
			continue
		}
		nums := make([]int, 0, len(m)-1)
		bad := false
		for _, g := range m[1:] {
			n, err := strconv.Atoi(g)
			if err != nil {
				bad = true
				break
			}
			nums = append(nums, n)
		}
		if bad {
			continue
		}
		for len(nums) < 6 {
			nums = append(nums, 0)
		}
		if !validCalendarDate(nums[0], nums[1], nums[2]) || nums[3] > 23 || nums[4] > 59 || nums[5] > 59 {
			continue // datetime(...) 越界 → Python 也当解析失败，换下一个格式
		}
		return time.Date(nums[0], time.Month(nums[1]), nums[2], nums[3], nums[4], nums[5], 0, time.Local), nil
	}
	return time.Time{}, fmt.Errorf("无法解析时间 %s，支持 YYYY-MM-DD 或 YYYY-MM-DD HH:MM[:SS]", pyRepr(raw))
}

func validCalendarDate(y, m, d int) bool {
	if m < 1 || m > 12 {
		return false
	}
	t := time.Date(y, time.Month(m), d, 0, 0, 0, 0, time.Local)
	return t.Year() == y && int(t.Month()) == m && t.Day() == d
}

// jstStamp 定时点标记文本（done_slots 用的 "YYYY-MM-DD HH:MM"）。
func jstStamp(hour, minute int, day string) string {
	return fmt.Sprintf("%s %02d:%02d", day, hour, minute)
}
