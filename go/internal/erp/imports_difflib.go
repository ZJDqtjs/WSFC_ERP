package erp

import (
	"sort"
)

// imports_difflib.go 复刻 Python difflib.SequenceMatcher(None, a, b).ratio()，
// 供 auto_suggest / _match_stock / _suggest_candidates 做模糊匹配。口径要点：
//   - 序列按 Unicode 码点（Python str 是字符序列，不是字节）；
//   - ratio = 2 * M / (len(a) + len(b))，M 是「最长匹配块」递归分解后各块长度之和；
//   - 最长匹配块用 difflib 的 j2len 动态规划 + 双向扩展（含 junk 处理）；
//   - autojunk：仅当 len(b) >= 200 且某字符出现次数 > 1% 时视为 junk（本系统商品名都远短于此，
//     实际不会触发，但仍完整实现以防长串调用不一致）。

type importsSeqMatcher struct {
	a, b  []rune
	b2j   map[rune][]int
	bjunk map[rune]bool
}

func newImportsMatcher(a, b string) *importsSeqMatcher {
	ar, br := []rune(a), []rune(b)
	m := &importsSeqMatcher{a: ar, b: br, b2j: map[rune][]int{}, bjunk: map[rune]bool{}}
	for i, elt := range br {
		m.b2j[elt] = append(m.b2j[elt], i)
	}
	// autojunk（Python: if autojunk and n >= 200）
	if n := len(br); n >= 200 {
		for elt, idx := range m.b2j {
			if len(idx)*100 > n {
				m.bjunk[elt] = true
			}
		}
		for elt := range m.bjunk {
			delete(m.b2j, elt)
		}
	}
	return m
}

func (m *importsSeqMatcher) isBJunk(r rune) bool { return m.bjunk[r] }

// findLongestMatch 复刻 difflib.SequenceMatcher.find_longest_match。
func (m *importsSeqMatcher) findLongestMatch(alo, ahi, blo, bhi int) (i, j, k int) {
	besti, bestj, bestsize := alo, blo, 0
	j2len := map[int]int{}
	for ii := alo; ii < ahi; ii++ {
		newj2len := map[int]int{}
		for _, jj := range m.b2j[m.a[ii]] {
			if jj < blo {
				continue
			}
			if jj >= bhi {
				break
			}
			kk := j2len[jj-1] + 1
			newj2len[jj] = kk
			if kk > bestsize {
				besti, bestj, bestsize = ii-kk+1, jj-kk+1, kk
			}
		}
		j2len = newj2len
	}
	// 非 junk 向左扩展
	for besti > alo && bestj > blo && !m.isBJunk(m.b[bestj-1]) && m.a[besti-1] == m.b[bestj-1] {
		besti, bestj, bestsize = besti-1, bestj-1, bestsize+1
	}
	// 非 junk 向右扩展
	for besti+bestsize < ahi && bestj+bestsize < bhi && !m.isBJunk(m.b[bestj+bestsize]) && m.a[besti+bestsize] == m.b[bestj+bestsize] {
		bestsize++
	}
	// junk 向左扩展
	for besti > alo && bestj > blo && m.isBJunk(m.b[bestj-1]) && m.a[besti-1] == m.b[bestj-1] {
		besti, bestj, bestsize = besti-1, bestj-1, bestsize+1
	}
	// junk 向右扩展
	for besti+bestsize < ahi && bestj+bestsize < bhi && m.isBJunk(m.b[bestj+bestsize]) && m.a[besti+bestsize] == m.b[bestj+bestsize] {
		bestsize++
	}
	return besti, bestj, bestsize
}

// matchingBlocksTotal 复刻 get_matching_blocks 的递归分解，只求长度之和 M。
func (m *importsSeqMatcher) matchingBlocksTotal() int {
	type box struct{ alo, ahi, blo, bhi int }
	total := 0
	queue := []box{{0, len(m.a), 0, len(m.b)}}
	for len(queue) > 0 {
		q := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		i, j, k := m.findLongestMatch(q.alo, q.ahi, q.blo, q.bhi)
		if k == 0 {
			continue
		}
		total += k
		if q.alo < i && q.blo < j {
			queue = append(queue, box{q.alo, i, q.blo, j})
		}
		if i+k < q.ahi && j+k < q.bhi {
			queue = append(queue, box{i + k, q.ahi, j + k, q.bhi})
		}
	}
	return total
}

// ImportsDifflibRatio 与 Python difflib.SequenceMatcher(None, a, b).ratio() 等价。
func ImportsDifflibRatio(a, b string) float64 {
	la, lb := len([]rune(a)), len([]rune(b))
	total := la + lb
	if total == 0 {
		return 1.0
	}
	m := newImportsMatcher(a, b)
	return 2.0 * float64(m.matchingBlocksTotal()) / float64(total)
}

// importsSortByFloatDesc 稳定排序辅助（候选列表 -score 再 id 升序时用）。
func importsSortByFloatDesc(scores []float64) []int {
	idx := make([]int, len(scores))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(i, j int) bool { return scores[idx[i]] > scores[idx[j]] })
	return idx
}
