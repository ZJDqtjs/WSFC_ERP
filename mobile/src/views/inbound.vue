<template>
  <div>
    <div class="seg">
      <div class="seg-item" :class="{ active: tab === 'new' }" @click="tab = 'new'">新增入库单</div>
      <div class="seg-item" :class="{ active: tab === 'list' }" @click="switchList">入库记录</div>
    </div>

    <!-- ============ 新增入库单 ============ -->
    <template v-if="tab === 'new'">
      <div class="card">
        <div class="card-title">
          <span class="grow">新增入库单 <HelpTip title="入库说明" text="按采购单位录入，系统自动折算到基础单位并重算先进先出成本。" /></span>
          <van-button size="mini" plain type="primary" icon="down" @click="batchShow = true">批量入库</van-button>
        </div>
        <van-cell-group inset>
          <van-field v-model="form.date" label="日期" type="date" />
          <van-field v-model="form.supplier" label="供应商" placeholder="可留空" />
          <OperatorField v-model="form.operator" />
          <PayStatusField
            v-model="form.pay_status"
            allow-partial
            hint="待付款：先进「待付款账单」，点「已支付」后才计入财务报表；部分付款：已付部分计入报表，未付余额留在待付款账单"
          />
          <AttachmentField v-model="form.remark" />
        </van-cell-group>

        <div class="divider"></div>
        <div class="row" style="justify-content:space-between;">
          <span class="bold">入库明细（{{ rows.length }} 行）</span>
          <span class="muted">
            {{ form.pay_status === 'partial' ? `应付 ${fmtMoney(totalDue)} · 已付 ${fmtMoney(totalPaid)} · 未付 ${fmtMoney(totalUnpaid)}` : `合计 ${fmtMoney(totalAmount)}${totalAdjust ? ` · 实付 ${fmtMoney(totalDue)}` : ''}` }}
          </span>
        </div>

        <div v-for="(r, i) in rows" :key="i" class="io-row">
          <div class="row" style="justify-content:space-between;">
            <span class="grow io-name" @click="openPicker(i)">
              <template v-if="r.product_id">{{ r.name }}</template>
              <template v-else><span class="placeholder">＋ 点击选择商品</span></template>
            </span>
            <van-icon v-if="rows.length > 1" name="delete-o" color="#ee0a24" @click="rows.splice(i, 1)" />
          </div>
          <div v-if="r.product_id" class="muted io-hint" @click="openUnit(i)">
            进货单位：{{ r.unit }}（点此切换） · 折算 {{ conversionText(r) }}
          </div>
          <div class="row mt8">
            <van-field v-model="r.qty" type="number" label="数量" @update:model-value="calcRow(r)" />
            <van-field v-model="r.price" type="number" label="单价" @update:model-value="calcRow(r)" />
            <div class="io-amount">{{ fmtMoney(rowAmount(r)) }}</div>
          </div>
          <div v-if="r.product_id" class="row mt8">
            <van-field v-model="r.adjust" type="number" label="调整" placeholder="0.00" @update:model-value="calcRow(r)" />
          </div>
          <div v-if="form.pay_status === 'partial' && r.product_id" class="row mt8 partial-row">
            <van-field v-model="r.paid" type="number" label="已付" placeholder="0.00" />
            <span class="grow"></span>
            <span class="muted" style="font-size:12px;text-align:right;">
              应付 {{ fmtMoney(rowDue(r)) }}<br />
              未付 {{ fmtMoney(Math.max(0, rowDue(r) - num(r.paid))) }} 进待付款账单
            </span>
          </div>
          <div v-if="r.product_id" class="muted io-note">{{ adjustHint(r) }}</div>
        </div>

        <div class="row" style="gap:8px;margin-top:10px;">
          <van-button size="small" plain type="primary" icon="plus" @click="addRow">加一行</van-button>
          <van-button size="small" plain @click="clearRows">清空</van-button>
        </div>
      </div>

      <div class="card" style="padding:12px;">
        <van-button block round type="success" :loading="saving" @click="submit">确认入库</van-button>
      </div>
    </template>

    <!-- ============ 入库记录 ============ -->
    <template v-else>
      <div class="card">
        <div class="row wrap" style="gap:6px;">
          <van-field v-model="filter.from" type="date" class="m-date" />
          <van-field v-model="filter.to" type="date" class="m-date" />
          <van-button size="small" type="primary" @click="loadList">筛选</van-button>
        </div>
        <div class="chip-row mt8">
          <button type="button" class="chip-btn" @click="quick(0)">今天</button>
          <button type="button" class="chip-btn" @click="quick(7)">近7天</button>
          <button type="button" class="chip-btn" @click="quick(null)">全部</button>
        </div>
        <van-field v-model="kw" placeholder="搜索单号 / 商品 / 供应商…" class="m-input mt8" />

        <!-- 筛选实时汇总：笔数 / 数量（按单位分组）/ 应付 / 已付 / 未付 / 货款与附加费用 -->
        <div v-if="filteredList.length" class="io-sum">
          <div class="row">
            <span class="grow">
              {{ kw.trim() || filter.from || filter.to ? '筛选结果' : '当前列表' }}
              <b>{{ listSum.n }}</b> 笔{{ listSum.n === list.length ? '' : ` / 共 ${list.length} 笔` }}
            </span>
            <span>应付 <b>{{ fmtMoney(listSum.due) }}</b></span>
          </div>
          <div class="muted" style="margin-top:2px;">数量合计 {{ listSum.qtyText }}</div>
          <div class="muted">
            已付 <b style="color:#107c10;">{{ fmtMoney(listSum.paid) }}</b>
            ／ 未付 <b style="color:#d13438;">{{ fmtMoney(listSum.unpaid) }}</b>
            <template v-if="listSum.pend">（待结算 {{ listSum.pend }} 笔）</template>
          </div>
          <div class="muted">
            货款 {{ fmtMoney(listSum.goods) }}<template v-if="listSum.extras"> · {{ listSum.extras }}</template>
          </div>
        </div>

        <div v-if="selected.length" class="batch-bar">
          <span class="muted">已选 {{ selected.length }} 条 · 合计 {{ fmtMoney(selectedAmount) }}</span>
          <van-button size="mini" type="danger" @click="batchDelete">批量删除</van-button>
          <van-button size="mini" plain @click="selected = []">取消</van-button>
        </div>
        <div class="row" style="justify-content:space-between;margin-top:8px;">
          <span class="muted">共 {{ list.length }} 条</span>
          <van-button size="mini" plain @click="toggleAll">{{ allSelected ? '取消全选' : '全选' }}</van-button>
        </div>

        <van-pull-refresh v-model="refreshing" @refresh="loadList">
          <div v-if="!filteredList.length" class="empty">暂无入库记录</div>
          <div v-for="r in filteredList" :key="r.id" class="list-item">
            <div class="row">
              <van-checkbox
                :model-value="selected.includes(r.id)"
                style="margin-right:8px;"
                @click="toggleSel(r.id)"
              />
              <span class="grow item-title">{{ r.product_name }}</span>
              <van-tag v-if="r.pay_status === 'partial'" type="warning" plain style="margin-right:6px;">部分付款</van-tag>
              <van-tag v-else-if="r.pay_status === 'unpaid'" type="warning" plain style="margin-right:6px;">待付款</van-tag>
              <span class="bold">{{ fmtMoney(finalOf(r)) }}</span>
            </div>
            <div class="item-meta">
              {{ r.code }} · {{ fmtNum(r.quantity) }}{{ r.unit }} × {{ fmtMoney(r.unit_price) }} · {{ r.date }}
            </div>
            <div v-if="num(r.adjust_amount)" class="item-meta" style="color:#ed6a0c;">
              调整 {{ num(r.adjust_amount) > 0 ? '+' : '−' }}{{ fmtMoney(Math.abs(num(r.adjust_amount))) }} · 商品金额 {{ fmtMoney(r.total_amount) }}
            </div>
            <div v-if="r.pay_status === 'partial'" class="item-meta" style="color:#b45309;">
              已付 {{ fmtMoney(r.paid_amount) }} · 未付 {{ fmtMoney(r.unpaid_amount) }}（应付 {{ fmtMoney(r.due_amount) }}，余额在待付款账单）
            </div>
            <div v-if="num(r.compensation)" class="item-meta" style="color:#07c160;">
              供应商补偿 -{{ fmtMoney(r.compensation) }}（已记其他收支，冲减期间费用）
            </div>
            <div class="item-meta">
              {{ r.supplier || '无供应商' }}{{ r.operator ? ' · ' + r.operator : '' }}
              <span style="float:right;">
                <van-button size="mini" plain type="primary" @click="openEdit(r)">改</van-button>
                <van-button size="mini" plain type="danger" @click="del(r)">删除</van-button>
              </span>
            </div>
            <RemarkView v-if="r.remark" :remark="r.remark" />
          </div>
        </van-pull-refresh>
      </div>
    </template>

    <!-- 单位选择 -->
    <van-action-sheet v-model:show="unitShow" :actions="unitActions" cancel-text="取消" @select="onUnitSelect" />

    <ProductPicker
      v-model:show="pickerShow"
      title="选择入库商品"
      :products="pickableProducts"
      :type-tabs="false"
      @pick="onPick"
    />

    <!-- 修改入库单（只允许改 供应商 / 日期 / 付款状态） -->
    <van-popup v-model:show="editShow" position="bottom" round>
      <div class="sheet-body">
        <div class="sheet-title">修改入库单</div>
        <div class="muted" style="margin-bottom:10px;">
          {{ editForm.code }} · {{ editForm.product_name }} · 商品金额 {{ fmtMoney(editForm.total_amount) }}
          <template v-if="num(editForm.adjust_amount)">
            （调整 {{ num(editForm.adjust_amount) > 0 ? '+' : '−' }}{{ fmtMoney(Math.abs(num(editForm.adjust_amount))) }}，实付 {{ fmtMoney(editForm.total_amount + num(editForm.adjust_amount)) }}）
          </template>
        </div>
        <van-cell-group inset>
          <van-field
            v-model="editForm.quantity"
            type="number"
            :label="`数量（${editForm.unit || '单位'}）`"
            @update:model-value="onEditChanged"
          />
          <van-field
            v-model="editForm.unit_price"
            type="number"
            :label="`单价（元/${editForm.unit || '单位'}）`"
            @update:model-value="onEditChanged"
          />
        </van-cell-group>

        <!-- 影响范围：未被出库用到 → 可快速更改；已用到 → 列出受影响订单 -->
        <div v-if="editImpactLoading" class="io-note" style="padding:6px 16px;">正在核算影响范围…</div>
        <div v-else-if="editImpactError" class="alert err" style="margin:6px 16px;">{{ editImpactError }}</div>
        <div
          v-else-if="editImpact"
          class="impact"
          :class="editImpact.affected_count ? 'warn' : 'ok'"
        >
          <div class="bold">
            <template v-if="editImpact.affected_count">会影响 {{ editImpact.affected_count }} 张出库单，保存后按 FIFO 重算成本与毛利</template>
            <template v-else-if="editImpact.used">这批货已有出库用到，但按当前改动订单成本没有变化</template>
            <template v-else>可快速更改：这批货还没有被出库/包装消耗用到</template>
          </div>
          <div class="muted" style="margin-top:3px;">
            本单金额 {{ fmtMoney(editImpact.old_total_amount) }} → <b>{{ fmtMoney(editImpact.new_total_amount) }}</b>；
            库存 {{ fmtNum(num(editImpact.stock_before) / editImpactFactor) }}{{ editImpactUnit }} →
            <b>{{ fmtNum(num(editImpact.stock_after) / editImpactFactor) }}{{ editImpactUnit }}</b>；
            均价 {{ fmtMoney(num(editImpact.avg_cost_before) * editImpactFactor) }} →
            {{ fmtMoney(num(editImpact.avg_cost_after) * editImpactFactor) }}/{{ editImpactUnit }}
          </div>
          <div v-if="editImpact.affected_outbounds && editImpact.affected_outbounds.length" class="muted" style="margin-top:3px;">
            <div v-for="o in editImpact.affected_outbounds.slice(0, 5)" :key="o.id">
              {{ o.code }} · {{ o.date }}{{ o.customer ? ' · ' + o.customer : '' }}：
              成本 {{ fmtMoney(o.cogs_before) }} → {{ fmtMoney(o.cogs_after) }}
              （{{ num(o.delta) >= 0 ? '+' : '−' }}{{ fmtMoney(Math.abs(num(o.delta))) }}）
            </div>
            <div v-if="editImpact.affected_count > 5">…等共 {{ editImpact.affected_count }} 张</div>
          </div>
          <div v-if="editImpact.warnings && editImpact.warnings.length" style="margin-top:3px;color:#d13438;">
            ⚠ {{ editImpact.warnings.join('；') }}
          </div>
        </div>

        <van-cell-group inset>
          <van-field v-model="editForm.supplier" label="供应商" placeholder="可留空" />
          <van-field v-model="editForm.date" label="日期" type="date" @update:model-value="onEditChanged" />
          <PayStatusField
            v-model="editForm.pay_status"
            allow-partial
            hint="待付款：先进「待付款账单」，点「已支付」后才计入财务报表；部分付款：已付部分计入报表，未付余额留在待付款账单"
          />
          <van-field
            v-if="editForm.pay_status === 'partial'"
            v-model="editForm.paid_amount"
            type="number"
            label="已付金额"
            placeholder="0.00"
          >
            <template #button><span class="muted">元</span></template>
          </van-field>
          <div v-if="editForm.pay_status === 'partial'" class="muted io-note" style="padding:0 16px 8px;">
            应付 {{ fmtMoney(editDue) }} · 已付 {{ fmtMoney(editPaid) }} · 未付 {{ fmtMoney(editUnpaid) }}（余额进待付款账单）
          </div>
          <van-field v-model="editForm.compensation" type="number" label="供应商补偿" placeholder="0.00">
            <template #button><span class="muted">元</span></template>
          </van-field>
          <div class="muted io-note" style="padding:0 16px 8px;">
            选填：供应商退的钱 / 赔偿。保存后自动记一笔负数的「其他收支 → 供应商补偿」冲减期间费用；填 0 或清空即取消。不改货款与批次成本。
          </div>
        </van-cell-group>
        <div class="muted io-note" style="margin:8px 4px;">
          保存后操作员记为当前登录账号。数量 / 单价可直接修改（保存前会先核算影响范围，已有出库用到这批货时列出受影响订单并重算成本）；商品如需更换请删除后重新入库。
        </div>
        <div class="row" style="gap:8px;">
          <van-button block plain @click="editShow = false">取消</van-button>
          <van-button block type="success" :loading="editSaving" @click="saveEdit">保存</van-button>
        </div>
      </div>
    </van-popup>

    <!-- 批量入库 -->
    <van-popup v-model:show="batchShow" position="bottom" round :style="{ height: '88%' }">
      <div class="sheet-body">
        <div class="sheet-title">批量入库</div>
        <div class="muted" style="margin-bottom:10px;">
          按模板填写后上传，先解析预览（可勾选、改数量单价），确认后才真正入库。若商品类别配置了扣点，单价将按 原价×(1-扣点%) 自动折算。
        </div>
        <div class="row" style="gap:8px;margin-bottom:10px;">
          <van-button size="small" plain type="primary" icon="down" @click="downloadTpl('inbounds')">下载模板</van-button>
          <van-button size="small" plain icon="upgrade" @click="batchFile && batchFile.click()">选择 Excel</van-button>
        </div>
        <input ref="batchFile" type="file" accept=".xlsx" style="display:none" @change="parseBatch" />

        <div v-if="batchParsing" class="empty">正在解析…</div>

        <template v-if="batchItems.length">
          <div class="row" style="justify-content:space-between;margin-bottom:6px;">
            <span class="bold">解析出 {{ batchItems.length }} 行</span>
            <van-button size="mini" plain @click="toggleBatchAll">{{ batchAllOn ? '全部取消' : '全部勾选' }}</van-button>
          </div>
          <div v-for="(it, i) in batchItems" :key="i" class="io-row">
            <div class="row">
              <van-checkbox v-model="it._on" style="margin-right:8px;" />
              <span class="grow io-name">{{ it.product_name }}</span>
              <span class="muted">{{ it.unit }}</span>
            </div>
            <div class="row mt8">
              <van-field v-model="it.quantity" type="number" label="数量" />
              <van-field v-model="it.unit_price" type="number" label="单价" />
              <div class="io-amount">{{ fmtMoney(num(it.quantity) * num(it.unit_price)) }}</div>
            </div>
            <div class="muted">{{ it.supplier || '无供应商' }} · {{ it.date }}</div>
          </div>
          <div v-if="batchFailed.length" class="alert err">
            解析失败 {{ batchFailed.length }} 条：{{ batchFailed.slice(0, 5).map((f) => f.reason).join('；') }}
          </div>
        </template>

        <div class="sheet-foot">
          <van-button block plain @click="batchShow = false">关闭</van-button>
          <van-button block type="success" :disabled="!batchItems.length" :loading="batchSaving" @click="confirmBatch">
            确认入库
          </van-button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onActivated } from 'vue'
import { showToast, showConfirmDialog } from 'vant'
import api, { upload, downloadFile } from '../api'
import ProductPicker from '../components/ProductPicker.vue'
import AttachmentField from '../components/AttachmentField.vue'
import RemarkView from '../components/RemarkView.vue'
import OperatorField from '../components/OperatorField.vue'
import PayStatusField from '../components/PayStatusField.vue'
import { ensureUserName } from '../utils/user'
import { fmtMoney, fmtNum, num, defaultUnit, unitFactor, todayStr } from '../utils/format'

const tab = ref('new')
const refreshing = ref(false)

// ---------- 新增 ----------
const form = reactive({ date: todayStr(), supplier: '', operator: '', remark: '', pay_status: 'paid' })
const rows = ref([newRow()])
const saving = ref(false)

function newRow() {
  return { product_id: '', name: '', unit: '', qty: '1', price: '0', adjust: '', paid: '' }
}
const round2 = (v) => Math.round((+v || 0) * 100) / 100
const totalAmount = computed(() => rows.value.reduce((s, r) => s + rowAmount(r), 0))
// 金额调整（抹零/凑整）：正=多付给供应商，负=少付。只影响实付，商品成本按原价不变
const totalAdjust = computed(() => rows.value.reduce((s, r) => s + (r.product_id ? num(r.adjust) : 0), 0))
const rowAmount = (r) => (r.product_id ? num(r.qty) * num(r.price) : 0)
/** 本行应付合计 = 货款 + 金额调整（与后端 pay_due 口径一致） */
const rowDue = (r) => round2(rowAmount(r) + num(r.adjust))
const totalDue = computed(() => round2(totalAmount.value + totalAdjust.value))
// 部分付款：已付金额是唯一真相；已付款=应付全额，待付款=0
const totalPaid = computed(() => {
  if (form.pay_status === 'paid') return totalDue.value
  if (form.pay_status !== 'partial') return 0
  const sum = rows.value
    .filter((r) => r.product_id)
    .reduce((s, r) => s + Math.min(Math.max(num(r.paid), 0), rowDue(r)), 0)
  return round2(sum)
})
const totalUnpaid = computed(() => round2(Math.max(totalDue.value - totalPaid.value, 0)))
const rowFinal = (r) => rowAmount(r) + num(r.adjust)
const finalOf = (r) => num(r.final_amount != null ? r.final_amount : num(r.total_amount) + num(r.adjust_amount))
function adjustHint(r) {
  const base = rowAmount(r)
  const adj = num(r.adjust)
  if (!adj) return '正=多付，负=少付；差额自动记「金额调整」其他收支（商品成本不变）'
  return `商品金额 ${fmtMoney(base)} ${adj > 0 ? '+' : '−'} ${fmtMoney(Math.abs(adj))} · 差额记「金额调整」其他收支`
}
function calcRow() {}

function conversionText(r) {
  const f = num(r._factor) || 1
  const du = r.unit || ''
  if (!du) return '—'
  return `1 ${du} = ${fmtNum(f)} ${r._base_unit || ''}`
}

function addRow() { rows.value.push(newRow()) }
function clearRows() { rows.value = [newRow()] }

async function submit() {
  const lines = rows.value.filter((r) => r.product_id)
  if (!lines.length) { showToast('请至少选择一条商品'); return }
  for (const r of lines) {
    if (!(num(r.qty) > 0)) { showToast(`「${r.name}」数量必须大于 0`); return }
  }
  const partial = form.pay_status === 'partial'
  // 部分付款：已付金额必须大于 0 且小于应付合计（等于 0 / 填满都该选「待付款」/「已付款」）
  if (partial) {
    for (const [i, r] of lines.entries()) {
      const due = rowDue(r)
      const paid = round2(num(r.paid))
      if (!(paid > 0)) { showToast(`第 ${i + 1} 行选了「部分付款」，请填已付金额（应付 ${fmtMoney(due)}）`); return }
      if (paid >= due - 0.005) { showToast(`第 ${i + 1} 行已付已够 ${fmtMoney(due)}，付款状态请选「已付款」`); return }
    }
  }
  // 单价与最近一次入库价不同：先让用户确认（价格录错会连带批次成本与毛利）
  await ensureProducts()
  if (!(await confirmPriceWarnings(lines))) return
  saving.value = true
  try {
    const adjustTotal = lines.reduce((s, r) => s + num(r.adjust), 0)
    for (const r of lines) {
      const paidAmount = partial ? round2(num(r.paid)) : 0
      await api('/api/inbounds', 'POST', {
        product_id: +r.product_id,
        unit: r.unit || '个',
        quantity: num(r.qty),
        unit_price: num(r.price),
        supplier: form.supplier,
        operator: form.operator,
        date: form.date,
        remark: form.remark,
        pay_status: form.pay_status,
        paid_amount: paidAmount,        // 部分付款：已付部分计入报表，余额进待付款账单
        adjust_amount: num(r.adjust),   // 抹零/凑整：差额自动记「金额调整」其他收支
      })
    }
    showToast(
      '入库成功'
      + (adjustTotal ? `（调整 ${adjustTotal > 0 ? '+' : '−'}${Math.abs(adjustTotal).toFixed(2)}，已记其他收支）` : '')
      + (form.pay_status === 'unpaid' ? '（待付款，已进待付款账单）' : '')
      + (partial ? `（已付 ${fmtMoney(totalPaid)}，未付 ${fmtMoney(totalUnpaid)} 已进待付款账单）` : '')
    )
    clearRows()
    form.pay_status = 'paid'
    loadList()
  } catch (e) { showToast('入库失败：' + e.message) }
  saving.value = false
}

/* ---------- 商品 / 单位选择 ---------- */
const PRODUCTS = ref([])
const pickerShow = ref(false)
let pickIndex = 0
const pickableProducts = computed(() =>
  PRODUCTS.value.filter((p) => p.is_active && p.product_type === 'stock' && !['人工', '快递'].includes(p.category))
)

async function ensureProducts() {
  if (PRODUCTS.value.length) return
  try { PRODUCTS.value = await api('/api/products') } catch (e) {}
}

/**
 * 入库单价变动确认：本次录入价与「该商品最近一次入库价」不同就列出来让用户确认。
 * products.last_in_price 是「每基础单位」价格，比较前先按本次单位换算。
 */
function priceWarnings(lines) {
  const out = []
  for (const r of lines) {
    const pid = +(r.product_id || 0)
    if (!pid) continue
    const cur = num(r.price != null ? r.price : r.unit_price)
    if (!(cur > 0)) continue          // 未填价不提示
    const p = PRODUCTS.value.find((x) => x.id === pid)
    if (!p) continue
    const lastBase = num(p.last_in_price)
    if (!(lastBase > 0)) continue     // 还没入过库
    const unit = r.unit || defaultUnit(p)
    const f = num(r._factor) || unitFactor(p, unit) || 1
    const last = lastBase * f
    if (Math.abs(cur - last) <= 1e-4) continue
    const pct = last ? ((cur - last) / last) * 100 : 0
    out.push(`${p.name}：最近入库 ${fmtMoney(last)}/${unit}（${p.last_in_date || '日期未知'}）`
      + ` → 本次 ${fmtMoney(cur)}/${unit}（${pct >= 0 ? '涨' : '降'} ${Math.abs(pct).toFixed(1)}%）`)
  }
  return out
}

/** 有价格差异时弹二次确认；返回 true = 继续提交 */
async function confirmPriceWarnings(lines) {
  const warns = priceWarnings(lines)
  if (!warns.length) return true
  const list = warns.slice(0, 10)
  const more = warns.length > list.length ? `；…另有 ${warns.length - list.length} 个商品存在差异` : ''
  try {
    await showConfirmDialog({
      title: '入库单价与最近一次不同',
      message: `${list.join('；')}${more}。\n\n确认价格无误、仍按本次单价入库吗？`,
    })
    return true
  } catch (e) { return false }
}
async function openPicker(i) {
  pickIndex = i
  await ensureProducts()
  pickerShow.value = true
}
function onPick(p) {
  const r = rows.value[pickIndex]
  r.product_id = p.id
  r.name = p.name
  r.unit = defaultUnit(p)
  r._factor = unitFactor(p, r.unit)
  r._base_unit = p.base_unit
  r._conversions = p.conversions || {}
}

const unitShow = ref(false)
let unitIndex = 0
const unitActions = ref([])
function openUnit(i) {
  const r = rows.value[i]
  if (!r.product_id) return
  unitIndex = i
  unitActions.value = Object.keys(r._conversions || {}).map((u) => ({ name: u, value: u }))
  if (!unitActions.value.length) unitActions.value = [{ name: r.unit || '个', value: r.unit || '个' }]
  unitShow.value = true
}
function onUnitSelect(a) {
  const r = rows.value[unitIndex]
  r.unit = a.value
  r._factor = num((r._conversions || {})[a.value]) || 1
  unitShow.value = false
}

/* ---------- 记录 ---------- */
const list = ref([])
const kw = ref('')
const filter = reactive({ from: '', to: '' })
const selected = ref([])

const filteredList = computed(() => {
  const s = (kw.value || '').trim().toLowerCase()
  if (!s) return list.value
  return list.value.filter((r) =>
    (r.code || '').toLowerCase().includes(s) ||
    (r.product_name || '').toLowerCase().includes(s) ||
    (r.supplier || '').toLowerCase().includes(s)
  )
})
/** 筛选结果实时汇总：数量按单位分组（公斤/箱/袋不能直接相加），金额按应付口径 */
const listSum = computed(() => {
  const rows = filteredList.value
  const qtyMap = new Map()
  let goods = 0, adjust = 0, freight = 0, handling = 0, fee = 0
  let due = 0, paid = 0, unpaid = 0, pend = 0
  for (const r of rows) {
    const u = (r.unit || '').trim()
    qtyMap.set(u, (qtyMap.get(u) || 0) + num(r.quantity))
    goods += num(r.total_amount)
    adjust += num(r.adjust_amount)
    freight += num(r.freight)
    handling += num(r.handling)
    fee += num(r.fee)
    due += num(r.due_amount)
    paid += num(r.paid_amount)
    unpaid += num(r.unpaid_amount)
    if ((r.pay_status || 'paid') !== 'paid') pend += 1
  }
  const extras = [
    adjust ? `调整 ${adjust > 0 ? '+' : '−'}${fmtMoney(Math.abs(adjust))}` : '',
    freight ? `运费 ${fmtMoney(freight)}` : '',
    handling ? `装卸 ${fmtMoney(handling)}` : '',
    fee ? `手续费 ${fmtMoney(fee)}` : '',
  ].filter(Boolean).join(' · ')
  const qtyText = [...qtyMap.entries()].map(([u, q]) => `${fmtNum(q)}${u ? ' ' + u : ''}`).join(' / ') || '0'
  return { n: rows.length, qtyText, goods, due, paid, unpaid, pend, extras }
})

const selectedAmount = computed(() =>
  list.value.filter((r) => selected.value.includes(r.id)).reduce((s, r) => s + finalOf(r), 0)
)
const allSelected = computed(() => filteredList.value.length > 0 && filteredList.value.every((r) => selected.value.includes(r.id)))

async function loadList() {
  try {
    const q = []
    if (filter.from) q.push(`date_from=${filter.from}`)
    if (filter.to) q.push(`date_to=${filter.to}`)
    list.value = await api('/api/inbounds' + (q.length ? '?' + q.join('&') : ''))
    selected.value = selected.value.filter((id) => list.value.some((r) => r.id === id))
  } catch (e) { showToast(e.message || '加载失败') }
  refreshing.value = false
}
function quick(days) {
  if (days === null) { filter.from = ''; filter.to = '' }
  else {
    const d = new Date()
    d.setDate(d.getDate() - days)
    filter.from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    filter.to = todayStr()
  }
  loadList()
}
function toggleSel(id) {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}
function toggleAll() {
  selected.value = allSelected.value ? [] : filteredList.value.map((r) => r.id)
}
async function del(r) {
  try {
    await showConfirmDialog({ title: '删除入库单', message: `确认删除 ${r.code}（${r.product_name}）？库存与成本会自动回退。` })
  } catch (e) { return }
  try {
    await api(`/api/inbounds/${r.id}`, 'DELETE')
    showToast('已删除')
    loadList()
  } catch (e) { showToast(e.message || '删除失败') }
}
async function batchDelete() {
  try {
    await showConfirmDialog({ title: '批量删除入库单', message: `确认删除已选 ${selected.value.length} 条入库单？` })
  } catch (e) { return }
  try {
    const r = await api('/api/inbounds/batch-delete', 'POST', { ids: selected.value })
    showToast(`已删除 ${r.deleted} 条`)
    selected.value = []
    loadList()
  } catch (e) { showToast(e.message || '删除失败') }
}

function switchList() {
  tab.value = 'list'
  loadList()
}

/* ---------- 修改单据（数量 / 单价 / 日期 / 供应商 / 付款状态） ---------- */
const editShow = ref(false)
const editSaving = ref(false)
const editForm = reactive({
  id: null, code: '', product_name: '', total_amount: 0, adjust_amount: 0,
  quantity: '', unit_price: '', unit: '',
  supplier: '', date: todayStr(), pay_status: 'paid', paid_amount: '', compensation: '',
})
// 修改前的影响范围评估（后端 /api/inbounds/{id}/impact，不落库）
const editImpact = ref(null)
const editImpactLoading = ref(false)
const editImpactError = ref('')
const editImpactKey = ref('')
const editOrigin = { quantity: 0, unit_price: 0, date: '' }
let editTimer = null

const editImpactUnit = computed(() => editImpact.value?.unit || editImpact.value?.base_unit || '')
const editImpactFactor = computed(() => num(editImpact.value?.unit_factor) || 1)

/** 数量/单价/日期改动：防抖后重新核算影响范围（否则每次输入都打一次 FIFO 重放） */
function onEditChanged() {
  editImpact.value = null
  editImpactKey.value = ''
  clearTimeout(editTimer)
  editTimer = setTimeout(() => previewImpact(true), 400)
}

/** 调后端核算影响范围；force=false 时相同输入复用上次结果 */
async function previewImpact(silent) {
  const qty = num(editForm.quantity)
  const price = num(editForm.unit_price)
  if (!(qty > 0)) {
    editImpact.value = null
    editImpactError.value = '数量必须大于 0'
    return null
  }
  if (price < 0) {
    editImpact.value = null
    editImpactError.value = '单价不能为负数'
    return null
  }
  const key = `${qty}|${price}|${editForm.date}`
  if (editImpact.value && editImpactKey.value === key) return editImpact.value
  editImpactLoading.value = true
  editImpactError.value = ''
  try {
    const r = await api(
      `/api/inbounds/${editForm.id}/impact?quantity=${qty}&unit_price=${price}&date=${encodeURIComponent(editForm.date || '')}`
    )
    editImpact.value = r
    editImpactKey.value = key
    return r
  } catch (e) {
    editImpact.value = null
    editImpactKey.value = ''
    editImpactError.value = '影响核算失败：' + (e.message || '请重试')
    if (!silent) showToast(editImpactError.value)
    return null
  } finally {
    editImpactLoading.value = false
  }
}
const editGoods = computed(() => round2(num(editForm.quantity) * num(editForm.unit_price)))
const editDue = computed(() => round2(editGoods.value + num(editForm.adjust_amount)))
const editPaid = computed(() => {
  if (editForm.pay_status === 'paid') return editDue.value
  if (editForm.pay_status !== 'partial') return 0
  return round2(Math.min(Math.max(num(editForm.paid_amount), 0), editDue.value))
})
const editUnpaid = computed(() => round2(Math.max(editDue.value - editPaid.value, 0)))

function openEdit(r) {
  Object.assign(editForm, {
    id: r.id,
    code: r.code,
    product_name: r.product_name,
    total_amount: num(r.total_amount),
    adjust_amount: num(r.adjust_amount),
    quantity: String(num(r.quantity)),
    unit_price: String(num(r.unit_price)),
    unit: r.unit || '',
    supplier: r.supplier || '',
    date: r.date || todayStr(),
    pay_status: ['paid', 'partial', 'unpaid'].includes(r.pay_status) ? r.pay_status : 'paid',
    paid_amount: r.pay_status === 'partial' && num(r.paid_amount) > 0 ? String(num(r.paid_amount)) : '',
    compensation: num(r.compensation) > 0 ? String(num(r.compensation)) : '',
  })
  editOrigin.quantity = num(r.quantity)
  editOrigin.unit_price = num(r.unit_price)
  editOrigin.date = r.date || ''
  editImpact.value = null
  editImpactError.value = ''
  editImpactKey.value = ''
  editShow.value = true
  previewImpact(true)   // 打开就先算一遍：可快速更改，还是会影响哪些单
}

async function saveEdit() {
  if (!editForm.date) { showToast('请选择入库日期'); return }
  const qty = num(editForm.quantity)
  const price = num(editForm.unit_price)
  if (!(qty > 0)) { showToast('数量必须大于 0'); return }
  if (price < 0) { showToast('单价不能为负数'); return }
  const compensation = round2(num(editForm.compensation))
  if (compensation < 0) { showToast('供应商补偿不能为负数'); return }
  let paidAmount = 0
  if (editForm.pay_status === 'partial') {
    paidAmount = round2(num(editForm.paid_amount))
    if (!(paidAmount > 0)) { showToast(`部分付款请填已付金额（应付 ${fmtMoney(editDue.value)}）`); return }
    if (paidAmount >= editDue.value - 0.005) { showToast(`已付已够 ${fmtMoney(editDue.value)}，付款状态请选「已付款」`); return }
  }
  const qtyChanged = Math.abs(qty - editOrigin.quantity) > 1e-9 || Math.abs(price - editOrigin.unit_price) > 1e-9
  const dateChanged = editForm.date !== editOrigin.date
  // 数量/单价/日期改动：保存前再核算一次影响范围，有受影响的出库单就先让用户确认
  let impact = null
  if (qtyChanged || dateChanged) {
    impact = await previewImpact(false)
    if (!impact) { showToast('影响核算失败，请重试'); return }
    const warns = (impact.warnings || []).join('；')
    if (impact.affected_count > 0) {
      const list = (impact.affected_outbounds || []).slice(0, 8)
        .map((o) => `${o.code}（${o.date}${o.customer ? ' · ' + o.customer : ''}，成本 ${num(o.delta) >= 0 ? '+' : '−'}${fmtMoney(Math.abs(num(o.delta)))}）`)
        .join('\n')
      const more = impact.affected_count > 8 ? `\n…等共 ${impact.affected_count} 张` : ''
      try {
        await showConfirmDialog({
          title: '该批次已被出库使用',
          message: `保存后会重算 ${impact.affected_count} 张出库单的成本与毛利：\n${list}${more}\n\n确认修改？`,
        })
      } catch (e) { return }
    } else if (warns) {
      try { await showConfirmDialog({ title: '注意', message: `${warns}\n\n确认继续？` }) } catch (e) { return }
    }
  }
  editSaving.value = true
  try {
    const payload = {
      supplier: (editForm.supplier || '').trim(),
      date: editForm.date,
      pay_status: editForm.pay_status,
      paid_amount: paidAmount,
      compensation,
    }
    if (qtyChanged) {
      payload.quantity = qty
      payload.unit_price = price
    }
    await api(`/api/inbounds/${editForm.id}`, 'PUT', payload)
    editShow.value = false
    showToast('已保存，操作员记为当前登录账号'
      + (qtyChanged ? '；数量/单价已更新' : '')
      + (impact && impact.affected_count ? `；已重算 ${impact.affected_count} 张出库单成本` : '')
      + (compensation > 0 ? `；供应商补偿 ${fmtMoney(compensation)} 已计入其他收支` : ''))
    loadList()
  } catch (e) { showToast('保存失败：' + e.message) }
  editSaving.value = false
}

/* ---------- 批量入库 ---------- */
const batchShow = ref(false)
const batchFile = ref(null)
const batchParsing = ref(false)
const batchSaving = ref(false)
const batchItems = ref([])
const batchFailed = ref([])
const batchAllOn = computed(() => batchItems.value.length > 0 && batchItems.value.every((i) => i._on))

function downloadTpl(kind) {
  downloadFile(`/api/templates/${kind}`, `${kind}_template.xlsx`).catch((e) => showToast(e.message))
}

async function parseBatch(e) {
  const f = e.target.files && e.target.files[0]
  e.target.value = ''
  if (!f) return
  batchParsing.value = true
  batchItems.value = []
  batchFailed.value = []
  try {
    const r = await upload('/api/import/inbounds/preview', f)
    batchItems.value = (r.items || []).map((it) => ({ ...it, _on: true }))
    batchFailed.value = r.failed || []
    if (!batchItems.value.length) showToast('未解析出可入库的数据')
  } catch (err) { showToast('解析失败：' + err.message) }
  batchParsing.value = false
}

function toggleBatchAll() {
  const v = !batchAllOn.value
  batchItems.value.forEach((i) => { i._on = v })
}

async function confirmBatch() {
  const items = batchItems.value
    .filter((i) => i._on && num(i.quantity) > 0)
    .map((i) => ({
      product_id: i.product_id,
      product_name: i.product_name,
      unit: i.unit,
      quantity: num(i.quantity),
      unit_price: num(i.unit_price),
      supplier: i.supplier,
      date: i.date,
      operator: i.operator,
      remark: i.remark,
    }))
  if (!items.length) { showToast('没有勾选可入库的数据'); return }
  await ensureProducts()
  if (!(await confirmPriceWarnings(items))) return
  batchSaving.value = true
  try {
    const r = await api('/api/import/inbounds/confirm', 'POST', { items })
    showToast(`已入库 ${r.created} 条${r.failed_count ? `，失败 ${r.failed_count}` : ''}`)
    batchShow.value = false
    batchItems.value = []
    const dates = items.map((i) => i.date).filter(Boolean).sort()
    if (dates.length) { filter.from = dates[0]; filter.to = dates[dates.length - 1] }
    tab.value = 'list'
    loadList()
  } catch (e) { showToast('确认入库失败：' + e.message) }
  batchSaving.value = false
}

onMounted(async () => {
  form.operator = await ensureUserName()   // 操作员固定为当前登录账号
  loadList()
})
onActivated(() => { if (tab.value === 'list') loadList() })
</script>

<style scoped>
.io-row { padding: 10px 0; border-bottom: 1px solid #f5f5f5; }
.io-row:last-child { border-bottom: none; }
.io-name { font-weight: 600; font-size: 14px; }
.io-name .placeholder { color: #1989fa; font-weight: 500; }
.io-hint { color: #1989fa; font-size: 12px; cursor: pointer; }
.io-amount { min-width: 76px; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 13px; }
.io-note { font-size: 12px; line-height: 1.5; }
/* 筛选结果实时汇总条 */
.io-sum {
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid #e8f0fb;
  border-radius: 8px;
  background: var(--m-primary-light);
  font-size: 12.5px;
  color: var(--m-text);
  line-height: 1.6;
}
.io-sum b { color: #0067c0; }
/* 改单影响范围面板 */
.impact {
  margin: 6px 16px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.6;
}
.impact.ok { background: #e8f7ee; color: #07a05a; }
.impact.warn { background: #fffbe8; color: #b45309; }
.impact .muted { color: inherit; opacity: 0.85; }
.batch-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: #fff7e6; border-radius: 8px; padding: 8px 10px; margin-top: 8px;
}
.alert { border-radius: 8px; padding: 8px 10px; font-size: 12px; margin-top: 8px; }
.alert.err { background: #fff1f0; color: #ee0a24; }
</style>
