"""商品资料解耦：将商品相关的「主数据」以 5 个 JSON 备份到 json 目录，可独立手动备份/恢复/迁移。

5 类商品资料（对应 5 张数据表）：
- units            计量单位        -> units.json
- products_stock   库存商品(大类)   -> products_stock.json  (含 包材/人工/快递 等分类)
- products_order   订单商品(小类)   -> products_order.json (关联结算)
- pack_rules       一单多货打包规则 -> pack_rules.json
- code_mappings    聚水潭编码关联   -> code_mappings.json

解耦原则：JSON 只存业务内容，商品的相互引用（order.stock_product、pack_items、
pack_rules.items、code_mappings.product）一律用「商品名称」表达，导入时再按名称解析成
数据库 id。因此可跨库/跨设备迁移，不依赖原来的自增 id。
"""
import json
from datetime import datetime
from pathlib import Path

from sqlalchemy import func, select

from .models import CodeMapping, PackRule, Product, Unit
from .services import default_conversions

ROOT = Path(__file__).resolve().parent.parent
JSON_DIR = ROOT / "backend" / "json"

# kind -> (文件名, 显示名, 列表字段名)
KINDS = {
    "units": ("units.json", "计量单位", "units"),
    "products_stock": ("products_stock.json", "库存商品", "items"),
    "products_order": ("products_order.json", "订单商品", "items"),
    "pack_rules": ("pack_rules.json", "一单多货规则", "rules"),
    "code_mappings": ("code_mappings.json", "聚水潭编码关联", "mappings"),
}
# 导入先后顺序：被引用的先导入，引用方的名称解析才不会缺目标
IMPORT_ORDER = ["units", "products_stock", "products_order", "pack_rules", "code_mappings"]


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _product_dict(p: Product, db) -> dict:
    """商品导出字典：引用一律用名称，避免依赖 id。"""
    sp_name = ""
    if p.stock_product_id:
        sp = db.get(Product, p.stock_product_id)
        sp_name = sp.name if sp else ""
    pack_items = []
    for it in (p.pack_items or []):
        pid = (it or {}).get("product_id")
        name = ""
        if pid:
            mp = db.get(Product, pid)
            name = mp.name if mp else ""
        if not name:
            name = str((it or {}).get("name", "") or "")
        pack_items.append({
            "name": name,
            "quantity": (it or {}).get("quantity", 1),
            "unit": (it or {}).get("unit", "个"),
        })
    return {
        "code": p.code,
        "name": p.name,
        "category": p.category,
        "product_type": p.product_type,
        "base_unit": p.base_unit,
        "default_unit": p.default_unit or p.base_unit,
        "spec": p.spec,
        "sale_price": p.sale_price,
        "unit_cost": p.unit_cost,
        "conversions": p.conversions or {},
        "pack_items": pack_items,
        "pack_fee": p.pack_fee,
        "stock_product": sp_name,  # 订单商品关联的库存商品名称
        "multiplier": p.multiplier,
        "is_active": p.is_active,
    }


def export_payload(db, kind: str) -> dict:
    """生成某一类商品资料的导出内容（字典，不落盘），供页面导出/下载。"""
    if kind == "units":
        rows = db.execute(select(Unit).order_by(Unit.id)).scalars()
        data = [
            {
                "name": u.name, "category": u.category,
                "gram_per_unit": u.gram_per_unit, "is_standard": u.is_standard,
            }
            for u in rows
        ]
    elif kind in ("products_stock", "products_order"):
        typ = "stock" if kind == "products_stock" else "order"
        rows = db.execute(
            select(Product).where(Product.product_type == typ).order_by(Product.category, Product.name)
        ).scalars()
        data = [_product_dict(p, db) for p in rows]
    elif kind == "pack_rules":
        rows = db.execute(select(PackRule).order_by(PackRule.id)).scalars()
        data = [
            {
                "name": r.name, "items": r.items or [], "box_type": r.box_type,
                "labor_price": r.labor_price, "box_ratio": r.box_ratio,
                "remark": r.remark, "is_active": r.is_active,
            }
            for r in rows
        ]
    elif kind == "code_mappings":
        rows = db.execute(select(CodeMapping).order_by(CodeMapping.id)).scalars()
        data = [
            {
                "source": m.source, "external_code": m.external_code,
                "external_name": m.external_name,
                "product": m.product.name if m.product else "",
                "auto_score": m.auto_score,
            }
            for m in rows
        ]
    else:
        raise ValueError(f"未知的商品资料类型: {kind}")
    fname, label, listkey = KINDS[kind]
    return {"kind": kind, "label": label, "file": fname, "exported_at": _now(), listkey: data}


def _write_file(db, kind: str) -> dict:
    payload = export_payload(db, kind)
    fname, label, listkey = KINDS[kind]
    data = payload[listkey]
    JSON_DIR.mkdir(parents=True, exist_ok=True)
    fp = JSON_DIR / fname
    fp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"kind": kind, "file": fname, "count": len(data)}


def export_all(db) -> dict:
    """把全部 5 类商品资料写入 json 目录，返回清单。"""
    return {"ok": True, "exported_at": _now(), "files": [_write_file(db, k) for k in IMPORT_ORDER]}


def _get_product_by_name(db, name: str) -> Product | None:
    name = (name or "").strip()
    if not name:
        return None
    return db.scalar(select(Product).where(Product.name == name))


def _import_units(db, items) -> dict:
    created = updated = 0
    warnings = []
    for it in items:
        name = str(it.get("name", "")).strip()
        if not name:
            continue
        u = db.scalar(select(Unit).where(Unit.name == name))
        if u is None:
            u = Unit(name=name, category="weight", is_standard=False)
            db.add(u)
            created += 1
        else:
            updated += 1
        if it.get("category") in ("weight", "count"):
            u.category = it["category"]
        g = it.get("gram_per_unit")
        if g not in (None, ""):
            u.gram_per_unit = float(g)
        u.is_standard = bool(it.get("is_standard", u.is_standard))
    db.commit()
    return {"created": created, "updated": updated, "skipped": 0, "warnings": warnings}


def _import_products(db, items, default_type: str) -> dict:
    created = updated = 0
    warnings = []
    for it in items:
        name = str(it.get("name", "")).strip()
        if not name:
            continue
        p = _get_product_by_name(db, name)
        is_new = p is None
        if is_new:
            p = Product(name=name, product_type=default_type)
            db.add(p)
            created += 1
        else:
            updated += 1
        p.code = str(it.get("code", "")).strip()
        p.category = str(it.get("category", "")).strip()
        p.product_type = it.get("product_type", default_type)
        base = str(it.get("base_unit", "") or p.base_unit or "克").strip()
        p.base_unit = base
        p.default_unit = str(it.get("default_unit", "") or base).strip()
        p.spec = str(it.get("spec", "")).strip()
        p.sale_price = float(it.get("sale_price", p.sale_price) or 0)
        p.unit_cost = float(it.get("unit_cost", p.unit_cost) or 0)
        p.conversions = it.get("conversions") or default_conversions(base)
        p.multiplier = float(it.get("multiplier", p.multiplier) or 1)
        p.pack_fee = float(it.get("pack_fee", p.pack_fee) or 0)
        p.is_active = bool(it.get("is_active", True))
        # 关联库存商品（按名称）
        sp_name = str(it.get("stock_product", "")).strip()
        p.stock_product_id = None
        if sp_name:
            sp = _get_product_by_name(db, sp_name)
            if sp:
                p.stock_product_id = sp.id
            else:
                warnings.append(f"商品「{name}」关联的库存商品「{sp_name}」不存在，关联已置空")
        # 关联结算清单（按名称）
        pack = []
        for pi in (it.get("pack_items") or []):
            piname = str(pi.get("name", "")).strip()
            if not piname:
                continue
            mp = _get_product_by_name(db, piname)
            if not mp:
                warnings.append(f"商品「{name}」的关联结算项「{piname}」不存在，已跳过")
                continue
            pack.append({
                "product_id": mp.id,
                "quantity": float(pi.get("quantity", 1) or 1),
                "unit": str(pi.get("unit", "个") or "个").strip(),
            })
        p.pack_items = pack
    db.commit()
    return {"created": created, "updated": updated, "skipped": 0, "warnings": warnings}


def _import_pack_rules(db, items) -> dict:
    created = updated = 0
    warnings = []
    for it in items:
        name = str(it.get("name", "")).strip()
        if not name:
            continue
        r = db.scalar(select(PackRule).where(PackRule.name == name))
        if r is None:
            r = PackRule(name=name, items=[], box_type="", labor_price=None,
                         box_ratio=1.0, remark="", is_active=True)
            db.add(r)
            created += 1
        else:
            updated += 1
        rule_items = []
        for ri in (it.get("items") or []):
            rn = str(ri.get("name", "")).strip()
            product_id = None
            if rn:
                mp = _get_product_by_name(db, rn)
                product_id = mp.id if mp else None
            rule_items.append({
                "product_id": product_id,
                "name": rn,
                "quantity": float(ri.get("quantity", 1) or 1),
            })
        r.items = rule_items
        r.box_type = str(it.get("box_type", "")).strip()
        lp = it.get("labor_price")
        r.labor_price = float(lp) if lp is not None else None
        r.box_ratio = float(it.get("box_ratio", r.box_ratio) or 1)
        r.remark = str(it.get("remark", "")).strip()
        r.is_active = bool(it.get("is_active", True))
    db.commit()
    return {"created": created, "updated": updated, "skipped": 0, "warnings": warnings}


def _import_code_mappings(db, items) -> dict:
    created = updated = 0
    warnings = []
    for it in items:
        source = str(it.get("source", "jushuitan")).strip()
        ext_code = str(it.get("external_code", "")).strip()
        if not ext_code:
            continue
        m = db.scalar(
            select(CodeMapping).where(
                CodeMapping.source == source, CodeMapping.external_code == ext_code
            )
        )
        if m is None:
            m = CodeMapping(source=source, external_code=ext_code)
            db.add(m)
            created += 1
        else:
            updated += 1
        m.external_name = str(it.get("external_name", "")).strip()
        pname = str(it.get("product", "")).strip()
        if pname:
            mp = _get_product_by_name(db, pname)
            m.product_id = mp.id if mp else None
            if not mp:
                warnings.append(f"编码关联「{ext_code}」映射的商品「{pname}」不存在，映射已置空")
        else:
            m.product_id = None
        m.auto_score = float(it.get("auto_score", 0) or 0)
        m.updated_at = datetime.now()
    db.commit()
    return {"created": created, "updated": updated, "skipped": 0, "warnings": warnings}


def import_payload(db, payload: dict) -> dict:
    """根据一个已解析的 JSON payload 导入对应类目。"""
    kind = payload.get("kind")
    if kind not in KINDS:
        raise ValueError(f"未知的商品资料类型: {kind}")
    fname, label, listkey = KINDS[kind]
    items = payload.get(listkey, [])
    if kind == "units":
        stats = _import_units(db, items)
    elif kind in ("products_stock", "products_order"):
        stats = _import_products(db, items, "stock" if kind == "products_stock" else "order")
    elif kind == "pack_rules":
        stats = _import_pack_rules(db, items)
    else:
        stats = _import_code_mappings(db, items)
    return {"kind": kind, "file": fname, "label": label, **stats}


def import_from_file(db, kind: str) -> dict:
    """从 json 目录读取某一类并导入。文件不存在则报错/跳过。"""
    fname, label, listkey = KINDS[kind]
    fp = JSON_DIR / fname
    if not fp.exists():
        raise FileNotFoundError(f"缺少 {fname}")
    payload = json.loads(fp.read_text(encoding="utf-8"))
    return import_payload(db, payload)


def import_all(db) -> dict:
    """从 json 目录一键导入全部 5 类（按依赖顺序）。返回逐类统计。"""
    result = {"ok": True, "imported_at": _now(), "results": []}
    for kind in IMPORT_ORDER:
        fname, label, listkey = KINDS[kind]
        if not (JSON_DIR / fname).exists():
            result["results"].append({"kind": kind, "file": fname, "label": label, "created": 0,
                                      "updated": 0, "skipped": 0, "warnings": ["文件不存在，已跳过"], "loaded": False})
            continue
        try:
            stats = import_from_file(db, kind)
            stats["loaded"] = True
            result["results"].append(stats)
        except Exception as e:
            result["results"].append({"kind": kind, "file": fname, "label": label, "created": 0,
                                      "updated": 0, "skipped": 0, "warnings": [f"导入失败：{e}"], "loaded": False})
    return result


def status(db) -> dict:
    """查看 json 目录与数据库的对照状态。"""
    rows = []
    for kind in IMPORT_ORDER:
        fname, label, listkey = KINDS[kind]
        fp = JSON_DIR / fname
        file_info = None
        if fp.exists():
            st = fp.stat()
            try:
                payload = json.loads(fp.read_text(encoding="utf-8"))
                count_in_file = len(payload.get(listkey, []))
            except Exception:
                count_in_file = 0
            file_info = {
                "exists": True, "size": st.st_size,
                "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                "count_in_file": count_in_file,
            }
        else:
            file_info = {"exists": False, "count_in_file": 0}
        rows.append({
            "kind": kind, "file": fname, "label": label,
            "count_in_db": _count_db(db, kind, listkey),
            **file_info,
        })
    return {"dir": str(JSON_DIR), "rows": rows}


def _count_db(db, kind: str, listkey: str) -> int:
    if kind == "units":
        return db.scalar(select(func.count()).select_from(Unit))
    if kind in ("products_stock", "products_order"):
        typ = "stock" if kind == "products_stock" else "order"
        return db.scalar(select(func.count()).select_from(Product).where(Product.product_type == typ))
    if kind == "pack_rules":
        return db.scalar(select(func.count()).select_from(PackRule))
    if kind == "code_mappings":
        return db.scalar(select(func.count()).select_from(CodeMapping))
    return 0