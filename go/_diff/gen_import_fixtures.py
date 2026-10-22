# -*- coding: utf-8 -*-
"""生成 imports 模块差分用的 xlsx 夹具（同一份文件同时喂 Python 与 Go，保证输入字节一致）。

用法：backend/.venv/Scripts/python.exe go/_diff/gen_import_fixtures.py
输出：_gosb/fixtures/*.xlsx
"""
import glob
import os
import sys

import openpyxl
from openpyxl import Workbook

ROOT = os.environ.get("REPO", r"D:/code/WSFC_ERP").replace("\\", "/")
OUT = os.path.join(ROOT, "_gosb", "fixtures")
os.makedirs(OUT, exist_ok=True)


def write(name, header, rows, sheet="Sheet1"):
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    ws.append(header)
    for r in rows:
        ws.append(r)
    path = os.path.join(OUT, name)
    wb.save(path)
    print("wrote", path, len(rows), "rows")


# ---- 商品导入：新建 2 个库存商品 + 1 行与已有商品重名（应 skipped）----
write(
    "products.xlsx",
    ["商品编码", "商品名称*", "分类", "规格", "基础单位", "单位换算", "默认售价", "打包费", "关联商品清单"],
    [
        ["DIFFP001", "差分导入土豆", "蔬菜", "每个约150克", "克", "克=1;斤=500;公斤=1000;个=150", 0.016, 1, ""],
        ["DIFFP002", "差分导入泡沫箱", "包材", "", "个", "克=1;个=20", 2.5, 0, "差分导入胶带=2个"],
        ["", "七彩土豆3斤打包", "蔬菜", "", "单", "", 9.9, 0, ""],
        ["DIFFP003", "", "蔬菜", "", "斤", "克=1;斤=500", 1, 0, ""],  # 空名 → 跳过
    ],
    "商品导入",
)

# ---- 入库导入：2 行（1 行商品不存在、1 行单位非法），含运费/装卸 ----
write(
    "inbounds.xlsx",
    ["商品编码或名称*", "进货单位*", "数量*", "单价*", "供应商", "日期*", "运费", "装卸费", "操作员", "备注"],
    [
        ["七彩土豆3斤打包", "单", 10, 3.33, "差分供应商", "2026-10-01", 20, 10, "", "差分入库甲"],
        ["100156788969", "单", 5.5, 19.9, "差分供应商2", "2026-10-02", "", "", "张三", "差分入库乙"],
        ["差分不存在的商品", "单", 1, 1, "差分供应商", "2026-10-01", "", "", "", "应失败"],
        ["七彩土豆3斤打包", "公斤", 1, 1, "差分供应商", "2026-10-01", "", "", "", "单位未配置应失败"],
    ],
    "入库导入",
)

# ---- 出库导入：同单号合并 2 行 + 单号留空 1 行 ----
write(
    "outbounds.xlsx",
    ["单号", "日期*", "客户", "商品编码或名称*", "销售单位*", "数量*", "单价*", "打包费", "操作员", "备注"],
    [
        ["DIFFA001", "2026-10-01", "差分客户", "七彩土豆3斤打包", "单", 2, 19.9, 1, "", "同单号合并"],
        ["DIFFA001", "2026-10-01", "差分客户", "100156788969", "单", 1, 35, 0.5, "小万", "第二行"],
        ["", "2026-10-02", "差分客户2", "云南大香芋头3斤2-3个打包", "单", 1, 20, 0, "", "单号留空每行一单"],
        ["DIFFA002", "2026-10-03", "差分客户", "差分不存在的商品", "单", 1, 1, 0, "", "应失败"],
    ],
    "出库导入",
)

# ---- 聚水潭出库单：取自真实导出的前若干行，再补 待出库/作废/放单仓/未关联 ----
JST_HEADER = ["出仓单号", "出库日期", "状态", "商品名称", "卖家实收", "店铺名称", "快递公司",
              "快递单号", "业务员", "线下客户", "仓储方"]


def jst_rows():
    files = sorted(glob.glob(os.path.join(ROOT, "backend/data/jst_exports/aosidi/*.xlsx")))
    if not files:
        return [
            ["9000001", "2026-10-12 09:36:50", "已出库", "2.京鲜生五指毛桃250g*2", 35, "差分店铺", "京东快递",
             "JDVA00000000001", "小万", "", "自持干货打单仓"],
        ]
    wb = openpyxl.load_workbook(files[-1], data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    head = [str(h or "") for h in rows[0]]
    idx = {k: head.index(k) for k in JST_HEADER if k in head}
    out = []
    for r in rows[1:]:
        if len(out) >= 8:
            break
        get = lambda k: (r[idx[k]] if k in idx and idx[k] < len(r) else "")
        if not str(get("商品名称") or ""):
            continue
        out.append([str(get(k) if get(k) is not None else "") for k in JST_HEADER])
    return out


rows = jst_rows()
base = rows[0] if rows else ["9000001", "2026-10-12", "已出库", "2.京鲜生五指毛桃250g*2", 35,
                             "差分店铺", "京东快递", "JDVA00000000001", "小万", "", "自持干货打单仓"]
rows.append([str(int(float(base[0])) + 1), base[1], "待出库", base[3], base[4], base[5], base[6], base[7], base[8], base[9], base[10]])
rows.append([str(int(float(base[0])) + 2), base[1], "作废", base[3], base[4], base[5], base[6], base[7], base[8], base[9], base[10]])
rows.append([str(int(float(base[0])) + 3), base[1], "已出库", base[3], base[4], base[5], base[6], base[7], base[8], base[9], "芳谊放单仓"])
rows.append([str(int(float(base[0])) + 4), base[1], "已出库", "差分查无此商品999g*1", 66, base[5], base[6], base[7], base[8], "线下客户甲", base[10]])
write("jst.xlsx", JST_HEADER, rows, "出库单")

# ---- 表头不对的文件（应 400，文案一致性）----
write("bad_header.xlsx", ["甲", "乙", "丙"], [["1", "2", "3"]], "Sheet")
# ---- 空明细（表头正确但没有数据行）----
write("empty_inbounds.xlsx", ["商品编码或名称*", "进货单位*", "数量*", "单价*", "日期*"], [], "入库导入")
print("fixtures:", sorted(os.listdir(OUT)))
