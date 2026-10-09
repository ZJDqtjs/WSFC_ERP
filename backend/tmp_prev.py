import sys

sys.path.insert(0, ".")

from starlette.datastructures import UploadFile

from app.database import get_sessionmaker
from app.routers import warehouse_in as wi

print("pick_sheets(real file):", wi._pick_sheets(
    ["什锦菜", "薯条", "常温贴单", "冷冻贴单"], ""))
print("pick_sheets(wanted only):", wi._pick_sheets(
    ["什锦菜", "常温贴单", "冷冻贴单"], "冷冻贴单"))
print("pick_sheets(no hit):", wi._pick_sheets(["Sheet1", "Sheet2"], ""))
print()

for wh in ("wh02", "wh01", "aosidi"):
    db = get_sessionmaker(wh)()
    try:
        with open("/tmp/x.xlsx", "rb") as fh:
            uf = UploadFile(filename="入仓配送明细.xlsx", file=fh)
            out = wi.import_preview(file=uf, sheet="", date="2026-10-08", db=db, user=None)
        print("=" * 34, wh)
        print("sheet=[%s] auto=%s used=%s" % (out["sheet"], out["sheet_auto"], out["sheets_used"]))
        print("items=%s matched=%s unmatched=%s failed=%s" % (
            len(out["items"]), out["matched"], out["unmatched"], out["failed_count"]))
        for it in out["items"][:14]:
            print("   %-16s qty=%-6s tbl_sku=%-14s -> %-16s sku=%-14s score=%s" % (
                it["product_name"], it["quantity"], it["sku"],
                it["matched_name"] or "(未匹配)", it["matched_sku"], it["match_score"]))
        print("   totals:", out["totals"])
        if out["failed"]:
            print("   failed sample:", out["failed"][:3])
    finally:
        db.close()
    print()
