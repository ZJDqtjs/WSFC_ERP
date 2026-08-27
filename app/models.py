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
    conversions: Mapped[dict] = mapped_column(JSON, default=dict)  # {单位: 换算到基础单位的系数}
    # 销售关联商品/包装清单：[{product_id, quantity, unit}]
    pack_items: Mapped[list] = mapped_column(JSON, default=list)
    pack_fee: Mapped[float] = mapped_column(Float, default=0.0)  # 每单固定人工/包装费
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    # 订单商品 → 库存商品 的关联（解耦）
    stock_product_id: Mapped[int | None] = mapped_column(
        ForeignKey("products.id"), nullable=True, index=True
    )  # 关联的库存商品（大类）
    multiplier: Mapped[float] = mapped_column(Float, default=1.0)  # 1单订单商品 = multiplier × 库存商品默认单位

    # 缓存聚合（由库存流水重算）
    stock: Mapped[float] = mapped_column(Float, default=0.0)
    avg_cost: Mapped[float] = mapped_column(Float, default=0.0)
    stock_value: Mapped[float] = mapped_column(Float, default=0.0)

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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    product: Mapped[Product] = relationship()


class Outbound(Base):
    """出库/销售单。一个订单可含多行商品，并自动结转关联商品(包装材料)与固定费用。"""

    __tablename__ = "outbounds"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    code: Mapped[str] = mapped_column(String(32), index=True)
    customer: Mapped[str] = mapped_column(String(64), default="")
    operator: Mapped[str] = mapped_column(String(32), default="")
    date: Mapped[str] = mapped_column(String(10), index=True)
    remark: Mapped[str] = mapped_column(String(255), default="")
    total_amount: Mapped[float] = mapped_column(Float, default=0.0)  # 销售收入
    total_cogs: Mapped[float] = mapped_column(Float, default=0.0)  # 商品成本+包装材料成本
    total_fee: Mapped[float] = mapped_column(Float, default=0.0)  # 人工/打包等固定费用
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    lines: Mapped[list["OutboundLine"]] = relationship(
        back_populates="outbound", cascade="all, delete-orphan"
    )


class OutboundLine(Base):
    """出库单行。line_type: sale=销售商品, pack=关联结算的包装材料。"""

    __tablename__ = "outbound_lines"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    outbound_id: Mapped[int] = mapped_column(ForeignKey("outbounds.id"))
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    line_type: Mapped[str] = mapped_column(String(8), default="sale")  # sale / pack
    unit: Mapped[str] = mapped_column(String(32))
    quantity: Mapped[float] = mapped_column(Float)
    quantity_base: Mapped[float] = mapped_column(Float)
    unit_price: Mapped[float] = mapped_column(Float, default=0.0)
    amount: Mapped[float] = mapped_column(Float, default=0.0)
    cogs: Mapped[float] = mapped_column(Float, default=0.0)  # 该行成本
    pack_fee: Mapped[float] = mapped_column(Float, default=0.0)  # 该行固定费用(sale 行)

    outbound: Mapped[Outbound] = relationship(back_populates="lines")
    product: Mapped[Product] = relationship()


class StockMovement(Base):
    """库存流水（源数据）。move_type: in / out / pack_out / adjust。quantity_base 有符号。"""

    __tablename__ = "stock_movements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"), index=True)
    move_type: Mapped[str] = mapped_column(String(16))
    quantity_base: Mapped[float] = mapped_column(Float)  # +入库 / -出库
    amount: Mapped[float] = mapped_column(Float, default=0.0)  # 入库金额 / 出库成本
    ref_type: Mapped[str] = mapped_column(String(16), default="")  # inbound / outbound / manual
    ref_id: Mapped[int] = mapped_column(Integer, nullable=True)
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
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.now)

    product: Mapped[Product | None] = relationship()


class User(Base):
    """系统用户（业务员）。不开放注册，由开发者在代码中维护。"""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(64), default="")  # 业务员姓名
    role: Mapped[str] = mapped_column(String(16), default="user")  # admin / user
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
