<template>
  <div class="sub-page">
    <van-nav-bar title="财务报表" left-arrow fixed placeholder @click-left="goBack" />
    <div style="padding:12px;">
      <!-- 查询条件 -->
      <div class="card">
        <div class="row wrap" style="gap:6px;">
          <van-field v-model="df" type="date" placeholder="起" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-field v-model="dt" type="date" placeholder="止" style="max-width:132px;background:#f7f8fa;border-radius:6px;padding:6px 10px;" />
          <van-button size="small" type="primary" @click="load">查询</van-button>
        </div>
        <div class="seg" style="margin:8px 0 0;">
          <div class="seg-item" :class="{ active: quickKey === 'today' }" @click="quick('today')">今天</div>
          <div class="seg-item" :class="{ active: quickKey === 'month' }" @click="quick('month')">本月</div>
          <div class="seg-item" :class="{ active: quickKey === 'all' }" @click="quick('all')">全部</div>
        </div>
      </div>

      <!-- 报表口径开关：开启后不计入「其他开支」的款项，只看商品售卖利润（默认开启） -->
      <div class="caliber" :class="{ off: !excludeOther }">
        <span class="grow">
          {{ excludeOther ? '排除其他开支 · 只看商品售卖利润' : '含其他开支（并入期间费用）' }}
        </span>
        <van-switch v-model="excludeOther" size="18" @update:model-value="onExcludeOther" />
      </div>

      <!-- 顶层：全仓总览 / 单仓总览 -->
      <div class="seg">
        <div class="seg-item" :class="{ active: scope === 'all' }" @click="setScope('all')">全仓总览</div>
        <div class="seg-item" :class="{ active: scope === 'one' }" @click="setScope('one')">单仓总览</div>
      </div>

      <!-- 查看分仓（只有单仓总览需要选看哪个仓） -->
      <div v-if="scope === 'one'" class="card" style="padding:10px 12px;" @click="whShow = true">
        <div class="row">
          <span class="grow">查看分仓：<b>{{ whName }}</b>{{ isCurrent ? '（当前分仓）' : '' }}</span>
          <van-icon name="arrow" color="#969799" />
        </div>
        <div class="muted" style="font-size:12px;margin-top:2px;">换一个只是换看谁的数据，不会改变你的工作分仓</div>
      </div>

      <!-- 分区 tab：全仓总览 / 单仓总览 两种视角都用（数据源由请求的 wh 决定） -->
      <div class="seg">
        <div class="seg-item" :class="{ active: tab === 'summary' }" @click="tab = 'summary'">汇总</div>
        <div class="seg-item" :class="{ active: tab === 'expense' }" @click="tab = 'expense'">支出</div>
        <div class="seg-item" :class="{ active: tab === 'goods' }" @click="tab = 'goods'">商品</div>
        <div class="seg-item" :class="{ active: tab === 'flow' }" @click="tab = 'flow'">流水</div>
      </div>

      <!-- 汇总 -->
      <template v-if="tab === 'summary'">
      <!-- 全仓总览：全仓合计 + 各分仓收入 / 支出 / 利润（支出/商品/流水分区用 wh=all 的合并数据） -->
      <template v-if="scope === 'all'">
        <div class="stat-grid" style="margin-bottom:12px;">
          <div class="stat accent"><div class="label">全仓销售收入</div><div class="value">{{ fmtMoney(allTot.revenue) }}</div><div class="sub">{{ allTot.orders || 0 }} 单 · {{ allTot.warehouse_count || 0 }} 个分仓</div></div>
          <div class="stat warn"><div class="label">全仓结转成本</div><div class="value">{{ fmtMoney(allTot.cogs) }}</div><div class="sub">毛利 {{ fmtMoney(allTot.gross) }}（{{ pct(allTot.gross, allTot.revenue) }}）</div></div>
          <div class="stat danger"><div class="label">全仓支出</div><div class="value">{{ fmtMoney(allTot.total_expense) }}</div><div class="sub">采购 {{ fmtMoney(allTot.purchase) }} ＋ 期间费用 {{ fmtMoney(allTot.expense) }}</div></div>
          <div class="stat" :class="num(allTot.net_profit) >= 0 ? 'success' : 'danger'"><div class="label">全仓净利润</div><div class="value">{{ fmtMoney(allTot.net_profit) }}</div><div class="sub">净利率 {{ pct(allTot.net_profit, allTot.revenue) }}</div></div>
        </div>
        <div class="card">
          <div class="card-title"><span class="grow">各分仓收入 / 支出 / 利润</span></div>
          <div v-if="!allItems.length" class="empty">暂无分仓数据</div>
          <div v-for="w in allItems" :key="w.key" class="list-item" @click="viewWarehouse(w.key)">
            <div class="row">
              <span class="grow item-title">
                {{ w.name }}
                <van-tag v-if="w.key === allCurrent" type="primary" plain style="margin-left:6px;">当前</van-tag>
              </span>
              <span class="bold" :class="num(w.net_profit) >= 0 ? 'up' : 'down'">{{ fmtMoney(w.net_profit) }}</span>
            </div>
            <div class="item-meta">收入 {{ fmtMoney(w.revenue) }} · 成本 {{ fmtMoney(w.cogs) }} · 毛利 {{ fmtMoney(w.gross) }}（{{ pct(w.gross, w.revenue) }}）</div>
            <div class="item-meta">期间费用 {{ fmtMoney(w.expense) }} · 采购 {{ fmtMoney(w.purchase) }} · 订单 {{ w.orders || 0 }} · 库存 {{ fmtMoney(w.stock_value) }}</div>
            <div v-if="w.error" class="item-meta down">{{ w.error }}</div>
          </div>
          <div v-if="allItems.length" class="row" style="margin-top:8px;">
            <span class="grow bold">全仓合计</span>
            <span class="bold" :class="num(allTot.net_profit) >= 0 ? 'up' : 'down'">{{ fmtMoney(allTot.net_profit) }}</span>
          </div>
        </div>
        <div class="muted" style="font-size:12px;padding:2px;">
          每个分仓独立账套，只统计「已付款」单据{{ allPendingText }}。点任一分仓可看它的单仓明细。
        </div>
      </template>

      <!-- 单仓总览：以下为原有内容（汇总 / 支出 / 商品 / 流水） -->
      <template v-else>
      <div class="stat-grid" style="margin-bottom:12px;">
        <div class="stat accent"><div class="label">销售收入</div><div class="value">{{ fmtMoney(rep.revenue) }}</div><div class="sub">{{ rep.order_count || 0 }} 单</div></div>
        <div class="stat warn"><div class="label">结转成本</div><div class="value">{{ fmtMoney(rep.cogs) }}</div><div class="sub">含关联结算 {{ fmtMoney(rep.pack_cost_total) }}</div></div>
        <div class="stat success"><div class="label">毛利</div><div class="value">{{ fmtMoney(rep.gross_profit) }}</div><div class="sub">{{ rep.revenue ? ((rep.gross_profit / rep.revenue) * 100).toFixed(1) + '%' : '—' }}</div></div>
        <div class="stat danger"><div class="label">期间费用</div><div class="value">{{ fmtMoney(rep.expense) }}</div><div class="sub">其他开支 {{ fmtMoney(rep.other_expense) }} · 手工 {{ fmtMoney(rep.manual_expense) }}</div></div>
        <div class="stat" :class="rep.net_profit >= 0 ? 'success' : 'danger'"><div class="label">净利润</div><div class="value">{{ fmtMoney(rep.net_profit) }}</div></div>
        <div class="stat"><div class="label">本期进货</div><div class="value">{{ fmtMoney(rep.purchase) }}</div></div>
        <div class="stat danger"><div class="label">本期总支出</div><div class="value">{{ fmtMoney(rep.total_expense) }}</div><div class="sub">含采购 {{ fmtMoney(rep.purchase) }}</div></div>
      </div>
      <div class="stat-grid cols2" style="margin-bottom:12px;">
        <div class="stat accent"><div class="label">当前库存总值</div><div class="value">{{ fmtMoney(rep.stock_value) }}</div></div>
        <div class="stat"><div class="label">本期入库单数</div><div class="value">{{ rep.inbound_count || 0 }}</div></div>
      </div>

      <!-- 销售成本构成 -->
      <div class="card">
        <div class="card-title"><span class="grow">销售成本构成</span><span class="muted">{{ rep.cogs ? '合计 ' + fmtMoney(rep.cogs) : '' }}</span></div>
        <div v-if="!rep.cogs" class="empty">本期无销售成本</div>
        <template v-else>
          <div class="cost-stack">
            <span
              v-for="(r, i) in costRows.filter((x) => x.value > 0)"
              :key="i"
              :style="{ width: pctOf(r.value) + '%', background: r.color }"
            ></span>
          </div>
          <div v-for="(r, i) in costRows" :key="i" class="list-item">
            <div class="row">
              <span class="dot" :style="{ background: r.color }"></span>
              <span class="grow item-title">
                {{ r.name }}
                <van-tag v-if="r.tag" type="warning" plain style="margin-left:4px;">{{ r.tag }}</van-tag>
              </span>
              <span class="bold">{{ fmtMoney(r.value) }}</span>
            </div>
            <div class="item-meta">
              {{ pctOf(r.value).toFixed(1) }}% · {{ r.tag ? '出库时按包装清单自动结算，已计入结转成本' : '销售商品本身的先进先出成本' }}
            </div>
          </div>
          <div class="divider"></div>
          <div class="row">
            <span class="grow bold">结转成本合计</span>
            <span class="bold">{{ fmtMoney(rep.cogs) }}</span>
          </div>
          <div v-if="!rep.pack_cost_total" class="alert warn">
            本期没有包材 / 人工 / 快递等关联结算成本。若商品已配置包装清单，请确认出库时是否生成了关联结算行。
          </div>
        </template>
      </div>
      </template>   <!-- /单仓总览·汇总 -->

      </template>

      <!-- 支出（期间费用 = 其他开支 + 手工记账） -->
      <template v-else-if="tab === 'expense'">
      <div class="card">
        <div class="card-title">
          <span class="grow">支出</span>
          <span class="bold up">{{ fmtMoney(rep.total_expense) }}</span>
        </div>
        <div class="muted" style="margin-bottom:8px;">
          采购 {{ fmtMoney(rep.purchase) }} + 其他开支 {{ fmtMoney(rep.other_expense) }} + 手工记账 {{ fmtMoney(rep.manual_expense) }}；
          其中期间费用 {{ fmtMoney(rep.expense) }} 从毛利中扣减（采购已计入结转成本，不重复扣）
        </div>
        <div v-if="staleApi" class="alert warn" style="margin-bottom:8px;">
          明细数据缺失：后端未返回「按日 / 按月支出明细」或缺少采购字段，说明后端服务还是旧版本，请更新并重启后端后刷新。
        </div>
        <div class="seg" style="margin-bottom:8px;">
          <div class="seg-item" :class="{ active: expTab === 'cat' }" @click="expTab = 'cat'">按类型</div>
          <div class="seg-item" :class="{ active: expTab === 'day' }" @click="expTab = 'day'">按日</div>
          <div class="seg-item" :class="{ active: expTab === 'month' }" @click="expTab = 'month'">按月</div>
          <div class="seg-item" :class="{ active: expTab === 'item' }" @click="expTab = 'item'">逐笔</div>
        </div>

        <!-- 按类型：其他开支 + 手工记账 -->
        <template v-if="expTab === 'cat'">
          <div v-if="!rep.purchase && !Object.keys(rep.other_expenses || {}).length && !Object.keys(rep.manual_fees || {}).length" class="empty">本期无支出</div>
          <div v-if="rep.purchase" class="muted" style="margin:4px 0;">采购支出（进货）</div>
          <div v-if="rep.purchase" class="list-item">
            <div class="row">
              <van-tag type="primary" plain>采购支出</van-tag>
              <span class="grow"></span>
              <span class="bold up">{{ fmtMoney(rep.purchase) }}</span>
            </div>
          </div>
          <div v-if="Object.keys(rep.other_expenses || {}).length" class="muted" style="margin:8px 0 4px;">其他开支（网线费 / 安装费 / 机器费 / 样品费…）</div>
          <div v-for="(v, k) in rep.other_expenses || {}" :key="'o' + k" class="list-item">
            <div class="row">
              <van-tag type="danger" plain>{{ k }}</van-tag>
              <span class="grow"></span>
              <span class="bold up">{{ fmtMoney(v) }}</span>
            </div>
          </div>
          <div v-if="Object.keys(rep.manual_fees || {}).length" class="muted" style="margin:8px 0 4px;">手工记账（财务流水中的支出）</div>
          <div v-for="(v, k) in rep.manual_fees || {}" :key="'m' + k" class="list-item">
            <div class="row">
              <van-tag plain>{{ k }}</van-tag>
              <span class="grow"></span>
              <span class="bold up">{{ fmtMoney(v) }}</span>
            </div>
          </div>
        </template>

        <!-- 按日 -->
        <template v-else-if="expTab === 'day'">
          <div v-if="!expDays.length" class="empty">本期无支出</div>
          <div v-for="d in expDays" :key="d.date" class="list-item" @click="openExpDrill(d.date, '')">
            <div class="row">
              <span class="grow item-title">{{ d.date }}</span>
              <span class="bold up">{{ fmtMoney(d.total) }}</span>
            </div>
            <div class="item-meta">
              采购 {{ fmtMoney(d.purchase) }} · 其他开支 {{ fmtMoney(d.other_expense) }} · 手工记账 {{ fmtMoney(d.manual_expense) }} · {{ d.count }} 笔 · <span class="muted">明细 ›</span>
            </div>
            <div class="exp-track" style="margin-top:6px;"><span class="exp-fill" :style="{ width: pctOfExp(d.total) + '%' }" /></div>
          </div>
          <div v-if="expDayTruncated" class="muted">共有 {{ (rep.expense_by_day || []).length }} 天支出，仅显示最近 {{ MAX_EXP_DAYS }} 天</div>
        </template>

        <!-- 按月 -->
        <template v-else-if="expTab === 'month'">
          <div v-if="!(rep.expense_by_month || []).length" class="empty">本期无支出</div>
          <div v-for="(m, i) in rep.expense_by_month || []" :key="m.month" class="list-item" @click="openExpDrill(m.month, '')">
            <div class="row">
              <span class="grow item-title">{{ m.month }}</span>
              <span class="bold up">{{ fmtMoney(m.total) }}</span>
            </div>
            <div class="item-meta">
              采购 {{ fmtMoney(m.purchase) }} · 其他开支 {{ fmtMoney(m.other_expense) }} · 手工记账 {{ fmtMoney(m.manual_expense) }} · {{ m.count }} 笔 · <span class="muted">明细 ›</span>
              <template v-if="expMomText(i) !== '—'"> · 环比 <b :class="expMom(i) >= 0 ? 'up' : 'down'">{{ expMomText(i) }}</b></template>
            </div>
          </div>
        </template>

        <!-- 逐笔明细：每一条支出（采购 / 其他开支 / 手工记账），与「支出合计」同口径 -->
        <template v-else>
          <div v-if="!expItems.length" class="empty">本期无支出</div>
          <div v-for="(r, i) in expItems" :key="i" class="list-item">
            <div class="row">
              <van-tag :type="r.source === '采购' ? 'primary' : (r.source === '其他开支' ? 'warning' : 'default')" plain>{{ r.source }}</van-tag>
              <span class="grow item-title ellipsis" style="margin-left:6px;">{{ r.item || r.category }}</span>
              <span class="bold up">{{ fmtMoney(r.amount) }}</span>
            </div>
            <div class="item-meta">
              {{ r.date }}{{ r.operator ? ' · ' + r.operator : '' }}{{ r.auto ? ' · 单据自动生成' : '' }}{{ r.ref ? ' · ' + r.ref : '' }}
            </div>
            <div v-if="r.remark" class="item-meta">{{ r.remark }}</div>
          </div>
          <div v-if="expItems.length" class="muted" style="margin-top:6px;">
            共 {{ (rep.expense_items || []).length }} 笔{{ expItemsTruncated ? '，仅显示最近 ' + MAX_EXP_ITEMS + ' 笔' : '' }}
          </div>
        </template>

        <div class="divider"></div>
        <div class="row">
          <span class="grow bold">支出合计（采购＋其他＋手工）</span>
          <span class="bold up">{{ fmtMoney(rep.total_expense) }}</span>
        </div>
        <div class="row" style="margin-top:2px;">
          <span class="grow muted">其中期间费用（从毛利中扣减，采购已计入结转成本）</span>
          <span class="muted">{{ fmtMoney(rep.expense) }}</span>
        </div>
        <div class="row" style="margin-top:8px;">
          <span class="grow"></span>
          <van-button size="mini" plain type="primary" @click="$router.push('/otherexp')">去登记其他开支</van-button>
        </div>
      </div>
      </template>

      <!-- 商品 -->
      <template v-else-if="tab === 'goods'">
      <div class="card">
        <div class="card-title">
          <span class="grow">商品销售明细</span>
          <span class="muted">成本为总成本</span>
        </div>
        <div v-if="!(rep.by_product || []).length" class="empty">本期无销售</div>
        <div v-for="(p, i) in rep.by_product || []" :key="i" class="list-item">
          <div class="row">
            <span class="grow item-title">{{ p.name }}</span>
            <van-tag v-if="p.is_dropship" type="warning" plain>代发</van-tag>
            <van-tag v-else type="primary" plain style="margin-left:4px;">库存出库</van-tag>
            <span class="bold" style="margin-left:6px;">{{ fmtMoney(p.amount) }}</span>
          </div>
          <div class="item-meta">
            <template v-if="p.spec">规格 {{ p.spec }} · </template>销量 {{ fmtNum(p.qty) }}
          </div>
          <div class="item-meta">
            总成本 {{ fmtMoney(totalCogsOf(p)) }} · 毛利
            <b :class="grossProfitOf(p) >= 0 ? 'up' : 'down'">{{ fmtMoney(grossProfitOf(p)) }}</b>
            · 毛利率
            <b :class="grossProfitOf(p) >= 0 ? 'up' : 'down'">{{ gpRateText(p) }}</b>
          </div>
          <div v-if="costSplitText(p)" class="item-meta cost-split">{{ costSplitText(p) }}</div>
        </div>
      </div>
      </template>

      <!-- 流水 -->
      <template v-else>
      <div class="card">
        <div class="card-title">
          <span class="grow">财务流水</span>
          <van-button size="mini" plain type="primary" icon="plus" @click="openFinance">手动记账</van-button>
        </div>
        <van-field v-model="fkw" placeholder="筛选分类 / 商品 / 备注 / 操作员" style="background:#f7f8fa;border-radius:6px;" />
        <div v-if="!financeFiltered.length" class="empty">本期无财务流水</div>
        <div v-for="f in financeFiltered" :key="f.id" class="list-item">
          <div class="row">
            <van-tag :type="f.type === 'income' ? 'success' : 'danger'" plain>{{ f.type === 'income' ? '收入' : '支出' }}</van-tag>
            <span class="grow item-title" style="margin-left:6px;">{{ f.category }}</span>
            <span :class="f.type === 'income' ? 'down' : 'up'">{{ f.type === 'income' ? '+' : '-' }}{{ fmtMoney(f.amount) }}</span>
          </div>
          <div class="item-meta">
            <template v-if="f.warehouse">{{ f.warehouse }} · </template>{{ f.date }}{{ f.product_name ? ' · ' + f.product_name : '' }}{{ f.operator ? ' · ' + f.operator : '' }}
            <template v-if="f.ref_type !== 'manual'"> · 单据自动生成</template>
          </div>
          <div v-if="f.remark" class="item-meta">{{ f.remark }}</div>
          <div v-if="f.ref_type === 'manual'" class="row" style="margin-top:6px;">
            <van-button size="mini" plain type="danger" @click="delFinance(f)">删除</van-button>
          </div>
        </div>
      </div>
      </template>

      <!-- 查看分仓选择 -->
      <van-action-sheet v-model:show="whShow" :actions="whActions" title="查看哪个分仓" cancel-text="取消" @select="pickWh" />
    </div>

    <!-- 手动记账 -->
    <van-popup v-model:show="finShow" position="bottom" round>
      <div class="sheet-body">
        <div class="sheet-title">手动记账</div>
        <van-cell-group inset>
          <van-field label="类型">
            <template #input>
              <van-radio-group v-model="fin.type" direction="horizontal">
                <van-radio name="expense">支出</van-radio>
                <van-radio name="income">收入</van-radio>
              </van-radio-group>
            </template>
          </van-field>
          <van-field v-model="fin.category" label="分类" placeholder="如 人工费 / 房租 / 其他支出" />
          <van-field v-model="fin.amount" type="number" label="金额" placeholder="0.00" />
          <van-field v-model="fin.date" label="日期" type="date" />
          <OperatorField v-model="fin.operator" />
          <van-field v-model="fin.remark" label="备注" placeholder="可留空" />
        </van-cell-group>
        <div class="sheet-foot">
          <van-button block plain @click="finShow = false">取消</van-button>
          <van-button block type="primary" :loading="finSaving" @click="submitFinance">保存</van-button>
        </div>
      </div>
    </van-popup>

    <!-- 支出下钻：点某天/某月看该时段构成明细（采购 / 其他开支 / 手工记账） -->
    <van-popup v-model:show="drillShow" position="bottom" round :style="{ height: '86%' }">
      <div class="sheet-body">
        <div class="sheet-title">
          {{ drillTitle }}
          <span class="muted" style="font-size:12px;">共 {{ drillRows.length }} 笔 · {{ fmtMoney(drillSum) }}</span>
        </div>
        <div class="seg" style="margin-bottom:8px;">
          <div v-for="t in DRILL_TABS" :key="t.v" class="seg-item" :class="{ active: drillSrc === t.v }" @click="drillSrc = t.v">{{ t.label }}</div>
        </div>
        <div v-if="!drillRows.length" class="empty">
          {{ Array.isArray(rep.expense_items) ? '该时段没有此类支出' : '后端未返回逐笔明细字段（expense_items）：请更新并重启后端服务' }}
        </div>
        <div v-for="(r, i) in drillRows" :key="i" class="list-item">
          <div class="row">
            <van-tag :type="r.source === '采购' ? 'primary' : (r.source === '其他开支' ? 'warning' : 'default')" plain>{{ r.source }}</van-tag>
            <span class="grow item-title ellipsis" style="margin-left:6px;">{{ r.item || r.category }}</span>
            <span class="bold up">{{ fmtMoney(r.amount) }}</span>
          </div>
          <div class="item-meta">
            {{ r.warehouse ? r.warehouse + ' · ' : '' }}{{ r.date }}{{ r.operator ? ' · ' + r.operator : '' }}{{ r.auto ? ' · 单据自动生成' : '' }}{{ r.ref ? ' · ' + r.ref : '' }}
          </div>
          <div v-if="r.remark" class="item-meta">{{ r.remark }}</div>
        </div>
        <div v-if="drillRows.length" class="row" style="margin-top:10px;">
          <span class="grow bold">合计（{{ drillRows.length }} 笔）</span>
          <span class="bold up">{{ fmtMoney(drillSum) }}</span>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast, showConfirmDialog } from 'vant'
import api from '../api'
import OperatorField from '../components/OperatorField.vue'
import { fmtMoney, fmtNum, num, todayStr } from '../utils/format'
import { userName, ensureUserName } from '../utils/user'
import { getExcludeOther, setExcludeOther, excludeOtherQs } from '../utils/reportPref'

const router = useRouter()
const route = useRoute()

/* 报表口径：是否排除其他开支（开关在本页顶部，与 web 端共用同一偏好） */
const excludeOther = ref(getExcludeOther())

function onExcludeOther(v) {
  setExcludeOther(v)
  showToast(v ? '已排除其他开支：只看商品售卖利润' : '已计入其他开支：含全部期间费用')
  load()   // 口径变了，按新口径重算
}

function goBack() {
  if (window.history.length > 1) router.back()
  else router.replace('/mine')
}

const df = ref(todayStr())
const dt = ref(todayStr())
const quickKey = ref('today')
const rep = ref({})
const finance = ref([])
const fkw = ref('')
let inited = false

const COST_COLORS = { 包材耗材: '#ff976a', 人工打包费: '#7232dd', 快递运费: '#07c160', 其他关联结算: '#969799' }
const pctOf = (v) => (rep.value.cogs ? (v / rep.value.cogs) * 100 : 0)

// 商品总成本：后端 by_product.total_cogs（商品成本 + 打包人工/耗材 + 快递费），
// 旧版后端不返回该字段，回退到 cogs（此时等于商品本身成本），避免整列显示成 ¥0.00
const totalCogsOf = (p) => num(p.total_cogs != null ? p.total_cogs : p.cogs)
const grossProfitOf = (p) => num(p.amount) - totalCogsOf(p)

// 毛利率分母用扣点前销售金额（gross_sales），无值时回退实收金额——与出库批次页口径一致
function gpRateText(p) {
  const denom = num(p.gross_sales) || num(p.amount)
  if (!denom) return '—'
  const rate = p.gp_rate != null ? num(p.gp_rate) : (grossProfitOf(p) / denom) * 100
  return rate.toFixed(1) + '%'
}

// 成本构成小字：代发成本/商品成本 ＋ 打包人工 ＋ 耗材 ＋ 其他关联结算 ＋ 快递费（有哪项列哪项）。
// 后端已把关联结算拆成 labor_cogs / material_cogs / other_cogs / express_cogs；
// 旧后端只给合并的 pack_cogs 时，退回「打包人工+耗材」展示。
function costSplitText(p) {
  const express = num(p.express_cogs)
  const oldPack = num(p.pack_cogs)
  const split = p.labor_cogs != null || p.material_cogs != null || p.other_cogs != null
  const labor = split ? num(p.labor_cogs) : 0
  const material = split ? num(p.material_cogs) : 0
  const other = split ? num(p.other_cogs) : 0
  if (!(p.is_dropship || oldPack || express || labor || material || other)) return ''
  const goods = num(p.goods_cogs != null ? p.goods_cogs : p.cogs)
  const parts = [`${p.is_dropship ? '代发成本' : '商品成本'} ${fmtMoney(goods)}`]
  if (split) {
    if (labor) parts.push(`打包人工 ${fmtMoney(labor)}`)
    if (material) parts.push(`耗材 ${fmtMoney(material)}`)
    if (other) parts.push(`其他关联结算 ${fmtMoney(other)}`)
  } else if (oldPack) {
    parts.push(`打包人工+耗材 ${fmtMoney(oldPack)}`)
  }
  if (express) parts.push(`快递费 ${fmtMoney(express)}`)
  return parts.join(' ＋ ')
}

const costRows = computed(() => {
  const goods = rep.value.goods_cogs != null ? rep.value.goods_cogs : num(rep.value.cogs) - num(rep.value.pack_cost_total)
  const packs = rep.value.pack_costs || {}
  const rows = [{ name: '商品成本', value: goods, color: '#1989fa', tag: '' }]
  Object.entries(packs)
    .sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => rows.push({ name: k, value: v, color: COST_COLORS[k] || '#969799', tag: '自动结算' }))
  return rows
})

/* ---------- 顶层：全仓总览 / 单仓总览（单仓可切换查看其他分仓，仅查看不改工作分仓） ---------- */
const scope = ref('one')      // all 全仓总览 / one 单仓总览
const whKey = ref('')         // 单仓总览查看的分仓 key；'' = 当前分仓
const whList = ref([])
const whCurrent = ref('')
const whShow = ref(false)
const allItems = ref([])
const allTot = ref({})
const allCurrent = ref('')
const allPendingText = ref('')

const whName = computed(() => {
  const w = whList.value.find((x) => x.key === whKey.value) || whList.value.find((x) => x.is_current)
  return w ? w.name : '当前分仓'
})
const isCurrent = computed(() => !whKey.value || whKey.value === whCurrent.value)
const whActions = computed(() =>
  whList.value.map((w) => ({ name: `${w.name}${w.is_current ? '（当前分仓）' : ''}`, key: w.key }))
)
const pct = (v, base) => (num(base) ? ((num(v) / num(base)) * 100).toFixed(1) + '%' : '—')

async function ensureWh() {
  if (whList.value.length) return
  try {
    const d = await api('/api/warehouses')
    whList.value = d.warehouses || []
    whCurrent.value = d.current || ''
  } catch (e) { /* 拿不到就用当前分仓 */ }
}
function setScope(v) { scope.value = v; load() }
function pickWh(a) { whKey.value = a.key; whShow.value = false; load() }
/** 全仓总览点某个分仓 → 回到单仓总览看它的明细 */
function viewWarehouse(key) { whKey.value = key; scope.value = 'one'; load() }

/* ---------- 报表分区 tab（汇总 / 支出 / 商品 / 流水）与支出子页签 ---------- */
const tab = ref('summary')
const expTab = ref('cat')   // cat 按类型 / day 按日 / month 按月 / item 逐笔
const MAX_EXP_DAYS = 90
const expDays = computed(() => (rep.value.expense_by_day || []).slice(0, MAX_EXP_DAYS))
const expDayTruncated = computed(() => (rep.value.expense_by_day || []).length > MAX_EXP_DAYS)

/* 逐笔支出明细：采购 / 其他开支 / 手工记账（与「支出合计」同口径） */
const MAX_EXP_ITEMS = 100
const expItems = computed(() => (rep.value.expense_items || []).slice(0, MAX_EXP_ITEMS))
const expItemsTruncated = computed(() => (rep.value.expense_items || []).length > MAX_EXP_ITEMS)

/* 支出下钻：点按日/按月的某条，弹层看该时段构成（二级页面） */
const DRILL_TABS_ALL = [
  { v: '', label: '全部' },
  { v: '采购', label: '采购' },
  { v: '其他开支', label: '其他' },
  { v: '手工记账', label: '手工' },
]
// 已排除其他开支时，逐笔明细里不会有该来源，对应筛选项一并隐藏
const DRILL_TABS = computed(() =>
  excludeOther.value ? DRILL_TABS_ALL.filter((t) => t.v !== '其他开支') : DRILL_TABS_ALL
)
const drillShow = ref(false)
const drillKey = ref('')
const drillSrc = ref('')
function openExpDrill(key, src = '') {
  drillKey.value = key
  drillSrc.value = src
  drillShow.value = true
}
const drillItems = computed(() => {
  const k = drillKey.value
  if (!k) return rep.value.expense_items || []
  const isMonth = /^\d{4}-\d{2}$/.test(k)
  return (rep.value.expense_items || []).filter((r) => (isMonth ? (r.date || '').slice(0, 7) === k : r.date === k))
})
const drillRows = computed(() => (drillSrc.value ? drillItems.value.filter((r) => r.source === drillSrc.value) : drillItems.value))
const drillSum = computed(() => drillRows.value.reduce((a, r) => a + (r.amount || 0), 0))
const drillTitle = computed(() => {
  const k = drillKey.value
  if (!k) return '支出明细'
  return `${k}${/^\d{4}-\d{2}$/.test(k) ? '（整月）' : '（当天）'}支出明细`
})

/** 后端未更新时（没返回逐日/逐月明细，或行内缺少采购字段）给出明确提示 */
const staleApi = computed(() =>
  !Array.isArray(rep.value.expense_by_day) || !Array.isArray(rep.value.expense_by_month)
  || (rep.value.expense_by_day || []).some((r) => r.purchase == null)
)

/** 单日/单月支出占本期「全部支出（含采购）」的百分比（用于占比条） */
function pctOfExp(v) {
  const t = num(rep.value.total_expense)
  return t ? Math.min(100, (num(v) / t) * 100).toFixed(1) : '0.0'
}

/** 环比：expense_by_month 为倒序，下一项即上一个月 */
function expMom(i) {
  const list = rep.value.expense_by_month || []
  const cur = list[i]
  const prev = list[i + 1]
  if (!cur || !prev || !num(prev.total)) return null
  return ((num(cur.total) - num(prev.total)) / num(prev.total)) * 100
}
function expMomText(i) {
  const d = expMom(i)
  return d == null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`
}

const financeFiltered = computed(() => {
  const s = (fkw.value || '').trim().toLowerCase()
  if (!s) return finance.value
  return finance.value.filter((f) =>
    [f.category, f.product_name, f.remark, f.operator, f.type].join(' ').toLowerCase().includes(s)
  )
})

async function load() {
  await ensureWh()
  // 全仓总览：各分仓收入 / 支出 / 利润明细（合计卡由下面 wh=all 的 rep 提供）
  if (scope.value === 'all') {
    try {
      const d = await api(`/api/report/all-warehouses?date_from=${df.value}&date_to=${dt.value}${excludeOtherQs()}`)
      allItems.value = d.items || []
      allTot.value = d.total || {}
      allCurrent.value = d.current || ''
      const p = allTot.value.pending || {}
      allPendingText.value = (p.payables_amount || p.receivables_amount)
        ? `；另有 ${p.payables_count || 0} 笔待付款 ${fmtMoney(p.payables_amount)} / ${p.receivables_count || 0} 笔待收款 ${fmtMoney(p.receivables_amount)} 未计入`
        : ''
      inited = true
    } catch (e) { showToast(e.message || '加载失败') }
  }
  // 四个分区（汇总 / 支出 / 商品 / 流水）两种视角共用：全仓 = wh=all（后端合并各分仓独立账套）
  try {
    const whqs = scope.value === 'all'
      ? '&wh=all'
      : (whKey.value ? `&wh=${encodeURIComponent(whKey.value)}` : '')
    const [r1, r2] = await Promise.all([
      api(`/api/report/summary?date_from=${df.value}&date_to=${dt.value}${whqs}${excludeOtherQs()}`),
      api(`/api/finance?date_from=${df.value}&date_to=${dt.value}${whqs}`),
    ])
    rep.value = r1
    finance.value = r2
    inited = true
  } catch (e) { showToast(e.message || '加载失败') }
}

function quick(kind) {
  quickKey.value = kind
  if (kind === 'today') { df.value = todayStr(); dt.value = todayStr() }
  else if (kind === 'month') { df.value = todayStr().slice(0, 8) + '01'; dt.value = todayStr() }
  else { df.value = ''; dt.value = '' }
  load()
}

/* ---------- 手动记账 ---------- */
const finShow = ref(false)
const finSaving = ref(false)
const fin = reactive({ type: 'expense', category: '其他支出', amount: '', date: todayStr(), operator: '', remark: '' })

async function openFinance() {
  fin.type = 'expense'
  fin.category = '其他支出'
  fin.amount = ''
  fin.date = dt.value || todayStr()
  fin.operator = await ensureUserName()   // 操作员固定为当前登录账号
  fin.remark = ''
  finShow.value = true
}

async function submitFinance() {
  if (!(num(fin.amount) > 0)) { showToast('金额必须大于 0'); return }
  finSaving.value = true
  try {
    await api('/api/finance', 'POST', {
      type: fin.type,
      category: fin.category.trim() || (fin.type === 'income' ? '销售收入' : '其他支出'),
      amount: num(fin.amount),
      date: fin.date,
      operator: fin.operator || userName.value,
      remark: fin.remark,
    })
    showToast('已记账')
    finShow.value = false
    load()
  } catch (e) { showToast(e.message || '保存失败') }
  finSaving.value = false
}

async function delFinance(f) {
  try { await showConfirmDialog({ title: '删除财务记录', message: `确认删除 ${f.date} ${f.category} ${fmtMoney(f.amount)}？` }) } catch (e) { return }
  try {
    await api(`/api/finance/${f.id}`, 'DELETE')
    showToast('已删除')
    load()
  } catch (e) { showToast(e.message || '删除失败') }
}

/** 工作台统计卡片深链进来时带上口径：/report?quick=month&tab=summary */
function applyQuery() {
  const q = route.query || {}
  const k = String(q.quick || '')
  if (k === 'today' || k === 'month' || k === 'all') {
    quickKey.value = k
    if (k === 'today') { df.value = todayStr(); dt.value = todayStr() }
    else if (k === 'month') { df.value = todayStr().slice(0, 8) + '01'; dt.value = todayStr() }
    else { df.value = ''; dt.value = '' }
  }
  const t = String(q.tab || '')
  if (['summary', 'expense', 'goods', 'flow'].includes(t)) tab.value = t
}

onMounted(() => { applyQuery(); if (!inited) load() })
</script>

<style scoped>
.sub-page { min-height: 100vh; background: #f7f8fa; }
.caliber {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; margin-bottom: 8px;
  border-radius: 6px; background: #e8f7ee; color: #07a05a;
  font-size: 12px; line-height: 1.5;
}
.caliber.off { background: #f2f3f5; color: #646566; }
.cost-stack { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: #f2f3f5; margin-bottom: 10px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; flex-shrink: 0; }
.cost-split { color: #969799; font-size: 11px; }
.exp-track { height: 6px; background: #f2f3f5; border-radius: 3px; overflow: hidden; display: block; }
.exp-fill { display: block; height: 100%; background: #f97316; border-radius: 3px; min-width: 2px; }
.alert { border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-top: 8px; }
.alert.warn { background: #fffbe8; color: #ed6a0c; }
</style>
