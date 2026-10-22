package erp

import (
	"context"
	"database/sql"
	"regexp"
	"sort"
	"strings"
)

// 本文件是「其他开支」的读写口径，对齐 Python routers/others.py。
// 其他开支与单据付款状态联动：入库/出库单带出的镜像行（金额调整、运费/装卸费）不允许在此直接改删。

// PresetExpenseCategories 前端下拉建议（也允许自定义类型，保存后自动进入建议列表）。
var PresetExpenseCategories = []string{"金额调整", "运费", "装卸费", "网线费", "安装费", "机器费", "样品费", "设备维修", "水电费", "搬运费", "办公用品", "其他"}

var otherDateRE = regexp.MustCompile("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

// OtherExpense 一行开支。
type OtherExpense struct {
	ID        int
	Category  string
	Amount    float64
	Date      string
	Remark    string
	Operator  string
	PayStatus string
	PaidAt    string
	RefType   string
	RefID     sql.NullInt64
	CreatedAt string
}

// JSON 输出（键名与 Python _to_dict 一致）。
func (e OtherExpense) JSON() map[string]any {
	var refID any
	if e.RefID.Valid {
		refID = int(e.RefID.Int64)
	}
	return map[string]any{"id": e.ID, "category": e.Category, "amount": Round2(e.Amount), "date": e.Date,
		"remark": e.Remark, "operator": e.Operator, "pay_status": e.PayStatus, "paid_at": e.PaidAt,
		"ref_type": e.RefType, "ref_id": refID, "created_at": isoSeconds(e.CreatedAt)}
}

const otherExpenseColumns = "id, category, amount, date, COALESCE(remark,''), COALESCE(operator,''), " +
	"COALESCE(pay_status,'paid'), COALESCE(paid_at,''), COALESCE(ref_type,''), ref_id, COALESCE(created_at,'')"

func scanOtherExpense(scan func(dest ...any) error) (OtherExpense, error) {
	var e OtherExpense
	var refID sql.NullInt64
	err := scan(&e.ID, &e.Category, &e.Amount, &e.Date, &e.Remark, &e.Operator, &e.PayStatus, &e.PaidAt, &e.RefType, &refID, &e.CreatedAt)
	e.RefID = refID
	return e, err
}

// queryOtherExpenses 取原始行（金额保留库里的精度，统计口径要用它而不是 JSON 里的两位小数）。
func queryOtherExpenses(ctx context.Context, q Querier, dateFrom, dateTo, category, orderBy string) ([]OtherExpense, error) {
	where := " WHERE 1=1"
	args := []any{}
	if dateFrom != "" {
		where += " AND date >= ?"
		args = append(args, dateFrom)
	}
	if dateTo != "" {
		where += " AND date <= ?"
		args = append(args, dateTo)
	}
	if category != "" {
		where += " AND category = ?"
		args = append(args, category)
	}
	rows, err := q.QueryContext(ctx, "SELECT "+otherExpenseColumns+" FROM other_expenses"+where+orderBy, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []OtherExpense{}
	for rows.Next() {
		e, err := scanOtherExpense(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ListOtherExpenses 明细：日期倒序（可按区间/类型过滤；类型是精确匹配）。
func ListOtherExpenses(ctx context.Context, q Querier, dateFrom, dateTo, category string) ([]map[string]any, error) {
	rows, err := queryOtherExpenses(ctx, q, dateFrom, dateTo, category, " ORDER BY date DESC, id DESC")
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for i := range rows {
		out = append(out, rows[i].JSON())
	}
	return out, nil
}

// OtherExpenseStats 今日/本月/区间合计 + 按类型、按日、按月分布。
// 口径照抄 Python：分桶只统计区间内的行、金额累加用库里的原始精度（最后一步才四舍五入），
// 行序按 id 升序（Python 那边 select 不带 ORDER BY，取回的就是 rowid 序），
// 因为「按类型」在金额相同时依赖首次出现顺序。
func OtherExpenseStats(ctx context.Context, q Querier, dateFrom, dateTo string) (map[string]any, error) {
	rows, err := queryOtherExpenses(ctx, q, "", "", "", " ORDER BY id")
	if err != nil {
		return nil, err
	}
	today := Today()
	month := today[:7]
	todayTotal, monthTotal := 0.0, 0.0
	byCat := newStatBucket()
	byDay := newStatBucket()
	byMonth := newStatBucket()
	rangeTotal, rangeCount := 0.0, 0
	var rangeDates []string
	used := map[string]bool{}
	for i := range rows {
		r := &rows[i]
		amt := r.Amount
		d := r.Date
		used[r.Category] = true
		if d == today {
			todayTotal += amt
		}
		if len(d) >= 7 && d[:7] == month {
			monthTotal += amt
		}
		if (dateFrom == "" || d >= dateFrom) && (dateTo == "" || d <= dateTo) {
			rangeTotal += amt
			rangeCount++
			if otherDateRE.MatchString(d) {
				rangeDates = append(rangeDates, d)
			}
			byCat.add(r.Category, amt)
			byDay.add(d, amt)
			if len(d) >= 7 {
				byMonth.add(d[:7], amt)
			}
		}
	}
	spanDays := 0
	if dateFrom != "" && dateTo != "" && dateTo >= dateFrom {
		spanDays = DaysBetween(dateFrom, dateTo) + 1
	} else if len(rangeDates) > 0 {
		sort.Strings(rangeDates)
		spanDays = DaysBetween(rangeDates[0], rangeDates[len(rangeDates)-1]) + 1
	} else if rangeCount > 0 {
		spanDays = 1
	}
	dailyAvg := 0.0
	if spanDays > 0 {
		dailyAvg = Round2(rangeTotal / float64(spanDays))
	}
	return map[string]any{
		"today": today, "month": month, "today_total": Round2(todayTotal), "month_total": Round2(monthTotal),
		"date_from": dateFrom, "date_to": dateTo, "range_total": Round2(rangeTotal), "range_count": rangeCount,
		"range_days": spanDays, "range_daily_avg": dailyAvg,
		"by_category": byCat.rowsByAmountDesc("category"),
		"by_day":      byDay.rowsByKeyDesc("date"),
		"by_month":    byMonth.rowsByKeyDesc("month"),
		"presets":     mergedPresets(used),
	}, nil
}

// statBucket 保序聚合桶（键的首次出现顺序决定并列名次）。
type statBucket struct {
	order []string
	amt   map[string]float64
	cnt   map[string]int
}

func newStatBucket() *statBucket {
	return &statBucket{amt: map[string]float64{}, cnt: map[string]int{}}
}

func (b *statBucket) add(key string, amount float64) {
	if _, ok := b.cnt[key]; !ok {
		b.order = append(b.order, key)
	}
	b.amt[key] += amount
	b.cnt[key]++
}

func (b *statBucket) rowsByAmountDesc(key string) []map[string]any {
	out := b.rows(key)
	sort.SliceStable(out, func(i, j int) bool { return ToFloat(out[i]["amount"]) > ToFloat(out[j]["amount"]) })
	return out
}

func (b *statBucket) rowsByKeyDesc(key string) []map[string]any {
	out := b.rows(key)
	sort.SliceStable(out, func(i, j int) bool { return ToStr(out[i][key]) > ToStr(out[j][key]) })
	return out
}

func (b *statBucket) rows(key string) []map[string]any {
	out := make([]map[string]any, 0, len(b.order))
	for _, k := range b.order {
		out = append(out, map[string]any{key: k, "amount": Round2(b.amt[k]), "count": b.cnt[k]})
	}
	if out == nil {
		out = []map[string]any{}
	}
	return out
}

// mergedPresets 下拉建议 = 预设类型（保持声明顺序）+ 用过的自定义类型（字典序）。
func mergedPresets(used map[string]bool) []string {
	out := make([]string, len(PresetExpenseCategories))
	copy(out, PresetExpenseCategories)
	var extra []string
	isPreset := map[string]bool{}
	for _, c := range PresetExpenseCategories {
		isPreset[c] = true
	}
	for c := range used {
		if c != "" && !isPreset[c] {
			extra = append(extra, c)
		}
	}
	sort.Strings(extra)
	return append(out, extra...)
}

// CleanOtherExpense 校验并归一化请求体（文案与 Python _clean 一致）。
func CleanOtherExpense(body map[string]any) (OtherExpense, error) {
	e := OtherExpense{
		Category: strings.TrimSpace(ToStr(body["category"])),
		Date:     strings.TrimSpace(ToStr(body["date"])),
		Remark:   strings.TrimSpace(ToStr(body["remark"])),
	}
	if e.Category == "" {
		return e, ErrText("请填写费用类型（如 网线费 / 安装费 / 机器费 / 样品费）")
	}
	if len([]rune(e.Category)) > 32 {
		return e, ErrText("费用类型过长（≤32 字）")
	}
	amt, ok := toFloat(body["amount"])
	if !ok {
		return e, ErrText("金额格式不正确")
	}
	e.Amount = Round2(amt)
	if e.Amount <= 0 {
		return e, ErrText("金额必须大于 0")
	}
	if !otherDateRE.MatchString(e.Date) {
		return e, ErrText("日期格式应为 YYYY-MM-DD")
	}
	if strings.TrimSpace(ToStr(body["pay_status"])) == "unpaid" {
		e.PayStatus = "unpaid"
	} else {
		e.PayStatus = "paid"
	}
	return e, nil
}

// CreateOtherExpense 手工登记一笔开支；已付款的支付日期就是单据日期本身。
func CreateOtherExpense(ctx context.Context, q Querier, in map[string]any, operator string) (OtherExpense, error) {
	e, err := CleanOtherExpense(in)
	if err != nil {
		return e, err
	}
	e.Operator = operator
	e.PaidAt = ""
	if e.PayStatus == "paid" {
		e.PaidAt = e.Date
	}
	e.CreatedAt = NowDB()
	res, err := q.ExecContext(ctx,
		"INSERT INTO other_expenses (category, amount, date, remark, operator, created_at, pay_status, paid_at, ref_type, ref_id) VALUES (?,?,?,?,?,?,?,?,?,null)",
		e.Category, e.Amount, e.Date, e.Remark, e.Operator, e.CreatedAt, e.PayStatus, e.PaidAt, "")
	if err != nil {
		return e, err
	}
	id64, _ := res.LastInsertId()
	e.ID = int(id64)
	return e, nil
}

// UpdateOtherExpense 只改类型/金额/日期/备注/付款状态；自动带出的行禁止改。
func UpdateOtherExpense(ctx context.Context, q Querier, id int, in map[string]any, operator string) (OtherExpense, error) {
	var e OtherExpense
	row := q.QueryRowContext(ctx, "SELECT "+otherExpenseColumns+" FROM other_expenses WHERE id = ?", id)
	got, err := scanOtherExpense(row.Scan)
	if err == sql.ErrNoRows {
		return e, Err404("开支记录不存在")
	} else if err != nil {
		return e, err
	}
	e = got
	if e.RefType != "" {
		return e, ErrText("该笔开支由单据自动带出（金额调整 / 入库运费·装卸费），请在来源单据中修改或删除")
	}
	cleaned, err := CleanOtherExpense(in)
	if err != nil {
		return e, err
	}
	cleaned.Operator = operator
	// 只有付款状态变化时才重置支付日期，避免把历史 paid_at 冲掉
	if cleaned.PayStatus == e.PayStatus {
		cleaned.PaidAt = e.PaidAt
	} else if cleaned.PayStatus == "paid" {
		cleaned.PaidAt = cleaned.Date
	} else {
		cleaned.PaidAt = ""
	}
	_, err = q.ExecContext(ctx, "UPDATE other_expenses SET category=?, amount=?, date=?, remark=?, operator=?, pay_status=?, paid_at=? WHERE id=?",
		cleaned.Category, cleaned.Amount, cleaned.Date, cleaned.Remark, cleaned.Operator, cleaned.PayStatus, cleaned.PaidAt, id)
	if err != nil {
		return e, err
	}
	cleaned.ID = id
	cleaned.RefType = e.RefType
	cleaned.RefID = e.RefID
	cleaned.CreatedAt = e.CreatedAt
	return cleaned, nil
}

// DeleteOtherExpense 删除手工开支；自动带出的行要在源单据里改。
func DeleteOtherExpense(ctx context.Context, q Querier, id int) error {
	var refType string
	var name sql.NullString
	row := q.QueryRowContext(ctx, "SELECT COALESCE(ref_type,''), category FROM other_expenses WHERE id = ?", id)
	if err := row.Scan(&refType, &name); err == sql.ErrNoRows {
		return Err404("开支记录不存在")
	} else if err != nil {
		return err
	}
	if refType != "" {
		return ErrText("该开支由单据自动带出，需在对应入库/出库单据中修改或删除")
	}
	_, err := q.ExecContext(ctx, "DELETE FROM other_expenses WHERE id = ?", id)
	return err
}

