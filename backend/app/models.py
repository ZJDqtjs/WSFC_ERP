from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class Unit(Base):
    """计量单位。weight 类有固定的克数换算，count 类由商品自定义换算系数。"""

    __tablename__ = "units"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    category: Mapped[str] = mapped_column(String(16))  # weight / count
    gram_per_unit: Mapped[float | None] = mapped_column(Float, nullable=True)
    is_standard: Mapped[bool] = mapped_column(Boolean, default=False)


class Product(Base):
    """商品。product_type:
    - stock 库存商品（大类，如 佛手柑大果）：真实库存，可入库/盘点
    - order 订单商品（小类，如 佛手柑大果2个）：用于出库销售，不存库存，
            通过 stock_product_id + multiplier 关联到库存商品，出库时按倍数扣减大类库存。
    conversions: {单位名: 每1单位=多少基础单位}；pack_items: 销售关联商品清单(包材/人工)。"""

    __tablename__ = "products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(128), default="", index=True)  # 商品编码
    name: Mapped[str] = mapped_column(String(128), index=True)
    category: Mapped[str] = mapped_column(String(64), default="")  # 商品类型/分类
    product_type: Mapped[str] = mapped_column(String(8), default="stock")  # stock 库存 / order 订单
    base_unit: Mapped[str] = mapped_column(String(32))  # 基础单位：通常 克 或 个
    default_unit: Mapped[str] = mapped_column(String(32), default="")  # 默认出库/展示单位，如 斤
    spec: Mapped[str] = mapped_column(String(255), default="")  # 规格说明，如 每个约150克
    sale_price: Mapped[float] = mapped_column(Float, default=0.0)  # 默认售价(每基础单位)
    unit_cost: Mapped[float] = mapped_column(Float, default=0.0)  # 参考成本/采购单价(每基础单位)
    weight_kg: Mapped[float] = mapped_column(Float, default=0.0)  # 单件毛重(kg/默认单位)，用于自动计算快递费
    # 包邮：该商品出库时不参与快递费结算（订单商品勾了它、或其关联的库存大类勾了，都算包邮）；
    # 整单所有销售行都是包邮时不会生成「快递费(自动)」行。
    free_shipping: Mapped[bool] = mapped_column(Boolean, default=False)
    conversions: Mapped[dict] = mapped_column(JSON, default=dict)  # {单位: 换算到基础单位的系数}
    # 销售关联商品/包装清单：[{product_id, quantity, unit}]
    pack_items: Mapped[list] = mapped_column(JSON, default=list)
    pack_fee: Mapped[float] = mapped_column(Float, default=0.0)  # 每单固定人工/包装费
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # 订单商品 → 库存商品 的关联（解耦）
    stock_product_id: Mapped[int | None] = mapped_column(
        ForeignKey("products.id"), nullable=True, index=True
    )  # 关联的库存商品（大类）；多关联时为首项（兼容旧逻辑/扣点分类）
    multiplier: Mapped[float] = mapped_column(Float, default=1.0)  # 1单订单商品 = multiplier × 库存商品默认单位
    # 订单商品 → 库存商品 的**多扣减关联**：[{product_id, multiplier}, ...]
    # 卖 1 单该订单商品时依次扣减这些库存商品（如 礼盒 = 苹果1斤 + 梨1斤）；空 = 代发（不扣库存）
    stock_links: Mapped[list] = mapped_column(JSON, default=list)

    # 缓存聚合（由库存流水重算）
    stock: Mapped[float] = mapped_column(Float, default=0.0)
    avg_cost: Mapped[float] = mapped_column(Float, default=0.0)
    stock_value: Mapped[float] = mapped_column(Float, default=0.0)
    workload: Mapped[float] = mapped_column(Float, default=0.0)  # 人工分类的工作量（单，正数）

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class Inbound(Base):
    """入库单。"""

    __tablename__ = "inbounds"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    unit: Mapped[str] = mapped_column(String(32))
    quantity: Mapped[float] = mapped_column(Float)  # 以所选单位计
    quantity_base: Mapped[float] = mapped_column(Float)  # 折算成基础单位
    unit_price: Mapped[float] = mapped_column(Float)  # 所选单位的单价
    total_amount: Mapped[float] = mapped_column(Float)
    supplier: Mapped[str] = mapped_column(String(64), default="")
    operator: Mapped[str] = mapped_column(String(32), default="")
    date: Mapped[str] = mapped_column(String(10), index=True)  # YYYY-MM-DD
    remark: Mapped[str] = mapped_column(String(255), default="")
    # 付款状态：paid 已付款（默认，直接进报表）/ unpaid 待付款（先进「待付款账单」，点「已支付」后才进报表）
    pay_status: Mapped[str] = mapped_column(String(8), default="paid")
    paid_at: Mapped[str] = mapped_column(String(10), default="")  # 标记已支付那天（YYYY-MM-DD）
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    product: Mapped[Product] = relationship()


class Outbound(Base):
    """出库/销售单。一个订单可含多行商品，并自动结转关联商品(包装材料)与固定费用。"""

    __tablename__ = "outbounds"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), index=True)
    import_group: Mapped[str] = mapped_column(String(32), index=True, default="")  # 批量导入批次号，空=单条
    pack_rule_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 命中的一单多货规则ID
    pack_rule_name: Mapped[str] = mapped_column(String(255), default="")  # 规则名快照（规则改动不影响历史）
    customer: Mapped[str] = mapped_column(String(64), default="")
    operator: Mapped[str] = mapped_column(String(32), default="")
    date: Mapped[str] = mapped_column(String(10), index=True)
    remark: Mapped[str] = mapped_column(String(255), default="")
    total_amount: Mapped[float] = mapped_column(Float, default=0.0)  # 销售收入
    total_cogs: Mapped[float] = mapped_column(Float, default=0.0)  # 商品成本+包装材料成本
    total_fee: Mapped[float] = mapped_column(Float, default=0.0)  # 人工/打包等固定费用
    # 付款状态：paid 已付款/已回款（默认，整单进报表）/ unpaid 待付款（未回款，整单先进待付款账单，不进报表）
    pay_status: Mapped[str] = mapped_column(String(8), default="paid")
    paid_at: Mapped[str] = mapped_column(String(10), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    lines: Mapped[list["OutboundLine"]] = relationship(
        back_populates="outbound", cascade="all, delete-orphan"
    )


class OutboundLine(Base):
    """出库单行。line_type: sale=销售商品, pack=关联结算的包装材料。
    sale_product_id：pack 行所属的销售商品（小类）ID，用于打包人工+耗材按销售商品组合统计；sale 行为空。"""

    __tablename__ = "outbound_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    outbound_id: Mapped[int] = mapped_column(ForeignKey("outbounds.id"))
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    line_type: Mapped[str] = mapped_column(String(8), default="sale")  # sale / pack
    sale_product_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # pack 行所属销售商品 ID
    spec: Mapped[str] = mapped_column(String(64), default="")  # 销售行规格来源，如 每件2斤 / 每件1单
    unit: Mapped[str] = mapped_column(String(32))
    quantity: Mapped[float] = mapped_column(Float)
    quantity_base: Mapped[float] = mapped_column(Float)
    unit_price: Mapped[float] = mapped_column(Float, default=0.0)
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    cogs: Mapped[float] = mapped_column(Float, default=0.0)  # 该行成本
    gross_sales: Mapped[float] = mapped_column(Float, default=0.0)  # 扣点前销售金额（原始金额，未扣店铺扣点）
    pack_fee: Mapped[float] = mapped_column(Float, default=0.0)  # 该行固定费用(sale 行)
    # 代发（订单商品未关联库存大类）：不扣任何库存，只记代发数量与代发成本
    is_dropship: Mapped[bool] = mapped_column(Boolean, default=False)

    outbound: Mapped[Outbound] = relationship(back_populates="lines")
    product: Mapped[Product] = relationship()


class StockMovement(Base):
    """库存流水（源数据）。move_type: in / out / pack_out / adjust / avg / ucost。quantity_base 有符号。"""

    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    move_type: Mapped[str] = mapped_column(String(16))
    quantity_base: Mapped[float] = mapped_column(Float)  # +入库 / -出库
    amount: Mapped[float] = mapped_column(Float, default=0.0)  # 入库金额 / 出库成本
    ref_type: Mapped[str] = mapped_column(String(16), default="")  # inbound / outbound / manual
    ref_id: Mapped[int] = mapped_column(Integer, nullable=True)
    # 出库行 id（仅出库产生的流水）：一行出库明细可能对应多条流水（订单商品关联多个库存商品），
    # 供 FIFO 成本重算精确回写到对应出库行；空 = 旧数据（按顺序一一对应）
    line_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    date: Mapped[str] = mapped_column(String(10), index=True)
    operator: Mapped[str] = mapped_column(String(32), default="")
    remark: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    product: Mapped[Product] = relationship()


class FinanceRecord(Base):
    """财务流水。type: income/expense；category: 销售收入/采购支出/包装耗材/人工打包费/其他。"""

    __tablename__ = "finance_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    type: Mapped[str] = mapped_column(String(8))  # income / expense
    category: Mapped[str] = mapped_column(String(32))
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True)
    amount: Mapped[float] = mapped_column(Float)  # 正数
    date: Mapped[str] = mapped_column(String(10), index=True)
    operator: Mapped[str] = mapped_column(String(32), default="")
    remark: Mapped[str] = mapped_column(String(255), default="")
    ref_type: Mapped[str] = mapped_column(String(16), default="")
    ref_id: Mapped[int] = mapped_column(Integer, nullable=True)
    # 付款状态：由来源单据（入库/出库/其他开支）带过来，或有手动记账时自己设
    pay_status: Mapped[str] = mapped_column(String(8), default="paid")
    paid_at: Mapped[str] = mapped_column(String(10), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    product: Mapped[Product | None] = relationship()


class OtherExpense(Base):
    """其他开支：仓库/经营中发生的零散支出（网线费、安装费、机器费、样品费等）。

    独立于 FinanceRecord（财务流水）：这里只按「费用类型 + 日期」记账，用于经营分析页的
    按日/按月/按类型统计；财务报表把它并入「期间费用」，从毛利中扣减得到净利。
    """

    __tablename__ = "other_expenses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    category: Mapped[str] = mapped_column(String(32), index=True)  # 费用类型：网线费/安装费/机器费/样品费…
    amount: Mapped[float] = mapped_column(Float, default=0.0)  # 金额（元，正数）
    date: Mapped[str] = mapped_column(String(10), index=True)  # YYYY-MM-DD
    remark: Mapped[str] = mapped_column(String(255), default="")
    operator: Mapped[str] = mapped_column(String(32), default="")
    # 付款状态：paid 已付款（默认，直接进报表）/ unpaid 待付款（先进「待付款账单」）
    pay_status: Mapped[str] = mapped_column(String(8), default="paid")
    paid_at: Mapped[str] = mapped_column(String(10), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class User(Base):
    """系统用户（业务员）。业务员使用 SSH 指纹（Ed25519 私钥）登录；
    管理员账号保留密码用于引导登录。不开放注册，由管理员在密钥管理页创建。"""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), default="")  # 空串=仅密钥登录
    name: Mapped[str] = mapped_column(String(64), default="")  # 业务员姓名
    role: Mapped[str] = mapped_column(String(16), default="user")  # admin / user
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    public_key: Mapped[str | None] = mapped_column(String(512), nullable=True)  # OpenSSH 公钥
    fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)  # SHA256 指纹
    key_created_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class PackRule(Base):
    """一单多货合并打包规则（多货打包）。区别于一单一货的 pack_items/pack_fee。

    name 为组合标识(如 '七彩土豆3斤*1,京鲜生七彩花生1斤*1')；
    items 为组合条目列表 [{product_id, name, quantity}]（product_id 可空=未关联订单商品）：
    - box_type 纸箱型号(如 '7号+8号')
    - labor_price 工人单价(元/单，可空)
    - box_ratio 箱单比(默认 1)
    - remark 备注
    """

    __tablename__ = "pack_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(512), unique=True, index=True)
    items: Mapped[list] = mapped_column(JSON, default=list)
    box_type: Mapped[str] = mapped_column(String(64), default="")
    box_items: Mapped[list] = mapped_column(JSON, default=list)  # [{product_id,name,quantity}] 箱型号关联的包材纸箱
    labor_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    box_ratio: Mapped[float] = mapped_column(Float, default=1.0)
    remark: Mapped[str] = mapped_column(String(255), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class CodeMapping(Base):
    """外部单据商品编码 → 系统商品 的关联（如聚水潭商品名称）。"""

    __tablename__ = "code_mappings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source: Mapped[str] = mapped_column(String(32), default="jushuitan", index=True)
    external_code: Mapped[str] = mapped_column(String(128), index=True)
    external_name: Mapped[str] = mapped_column(String(255), default="")
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id"), nullable=True)
    auto_score: Mapped[float] = mapped_column(Float, default=0.0)  # 自动匹配得分
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    product: Mapped[Product | None] = relationship()


class Deduction(Base):
    """扣点规则：按商品类别设置入库扣点百分比。

    批量导入→入库 解析「进货单价」时，若商品类别命中规则，
    实际入库单价 = 原单价 × (1 - percent/100)，直接以折算价作为入库成本。
    """

    __tablename__ = "deductions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    category: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # 商品类别，与 Product.category 精确匹配
    percent: Mapped[float] = mapped_column(Float, default=0.0)  # 扣点百分比 0~99.99，如 7 表示 7%
    remark: Mapped[str] = mapped_column(String(255), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now, onupdate=datetime.now)


class WarehouseProduct(Base):
    """入仓品：按「袋」采购的备货商品（半加工等），与库存商品(Product)解耦。

    采购价、运费均以「袋」为单位（每袋采购价 / 每袋运费）；运费暂留空，后续在系统维护。
    用于「入仓」台账与入仓成本核算（入仓成本 = 数量 × (采购价 + 运费)）。
    """

    __tablename__ = "warehouse_products"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(128), index=True)  # 入仓品名称
    category: Mapped[str] = mapped_column(String(64), default="")  # 类目，如 半加工叶梅
    sku: Mapped[str] = mapped_column(String(64), default="")  # SKU
    barcode: Mapped[str] = mapped_column(String(64), default="")  # 69 码
    box_spec: Mapped[float] = mapped_column(Float, default=0.0)  # 箱规（袋/箱）
    purchase_price: Mapped[float] = mapped_column(Float, default=0.0)  # 采购价（元/袋）＝给「我」的收入单价
    freight: Mapped[float] = mapped_column(Float, default=0.0)  # 运费（元/袋），暂空待维护
    stock_product_id: Mapped[int | None] = mapped_column(
        ForeignKey("products.id"), nullable=True, index=True
    )  # 关联的库存商品（成本按库存管理的均价/参考成本计算）
    bag_weight: Mapped[float] = mapped_column(Float, default=0.0)  # 每袋净重（关联库存商品的基础单位，通常克）
    shelf_life: Mapped[str] = mapped_column(String(32), default="")  # 保质期，如 半年/一年
    remark: Mapped[str] = mapped_column(String(255), default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # 关联结算（随货包材）：**每袋**入仓品配套消耗的包材清单 [{product_id, quantity, unit}]。
    # 入仓时按「每袋用量 × 入仓袋数」结算：扣减包材库存并计入入仓成本（口径同出库的 pack_items）。
    pack_items: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)


class WarehouseIn(Base):
    """入仓记录：某入仓品入库数量与成本（按袋）。

    amount = 数量 × (采购价 + 运费)；采购价/运费均为快照，后续可在系统单独维护。
    可按「采购单号 + 配送中心」保留入仓明细，供导入《入仓配送明细》常温贴单使用。
    pack_items / pack_cost：入仓时按入仓品「关联结算（随货包材）」结算出来的包材明细快照与成本合计，
    计入毛利（毛利 = 收入 − 商品成本 − 运费 − 包材成本），并同步扣减包材库存。
    """

    __tablename__ = "warehouse_ins"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), index=True)  # 入仓单号 RC{date}-NNN
    product_id: Mapped[int | None] = mapped_column(
        ForeignKey("warehouse_products.id"), nullable=True, index=True
    )  # 关联入仓品（可空，导入未匹配时留空）
    product_name: Mapped[str] = mapped_column(String(128), default="")  # 名称快照
    category: Mapped[str] = mapped_column(String(64), default="")
    unit: Mapped[str] = mapped_column(String(16), default="袋")
    purchase_no: Mapped[str] = mapped_column(String(64), default="")  # 采购单号
    center: Mapped[str] = mapped_column(String(64), default="")  # 配送中心
    quantity: Mapped[float] = mapped_column(Float, default=0.0)  # 数量（袋）
    box_count: Mapped[float] = mapped_column(Float, default=0.0)  # 箱数
    box_spec: Mapped[float] = mapped_column(Float, default=0.0)  # 箱规（袋/箱）
    unit_price: Mapped[float] = mapped_column(Float, default=0.0)  # 采购价（元/袋）＝收入单价（扣点前）
    deduction_percent: Mapped[float] = mapped_column(Float, default=0.0)  # 采购价扣点%快照
    freight: Mapped[float] = mapped_column(Float, default=0.0)  # 运费（元/袋）
    # 成本口径：收入 = 数量×采购价；商品成本 = 数量×每袋净重×库存单位成本；运费 = 数量×运费单价
    stock_product_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # 关联库存商品
    bag_weight: Mapped[float] = mapped_column(Float, default=0.0)  # 每袋净重快照（基础单位）
    unit_cost: Mapped[float] = mapped_column(Float, default=0.0)  # 库存单位成本快照（元/基础单位）
    cogs: Mapped[float] = mapped_column(Float, default=0.0)  # 商品成本
    amount: Mapped[float] = mapped_column(Float, default=0.0)  # 收入合计（=数量×采购价）
    freight_total: Mapped[float] = mapped_column(Float, default=0.0)  # 运费合计
    # 随货包材结算快照 + 成本：pack_items=[{product_id,name,unit,quantity,quantity_base,cost}]，pack_cost 为合计
    pack_items: Mapped[list] = mapped_column(JSON, default=list)
    pack_cost: Mapped[float] = mapped_column(Float, default=0.0)
    profit: Mapped[float] = mapped_column(Float, default=0.0)  # 毛利 = 收入 - 商品成本 - 运费 - 包材成本
    date: Mapped[str] = mapped_column(String(10), index=True)  # YYYY-MM-DD
    operator: Mapped[str] = mapped_column(String(32), default="")
    remark: Mapped[str] = mapped_column(String(255), default="")
    import_group: Mapped[str] = mapped_column(String(32), default="")  # 导入批次号，空=手动
    # 付款状态：paid 已付款（默认）/ unpaid 待付款（先进「待付款账单」）
    pay_status: Mapped[str] = mapped_column(String(8), default="paid")
    paid_at: Mapped[str] = mapped_column(String(10), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    product: Mapped[WarehouseProduct | None] = relationship()
