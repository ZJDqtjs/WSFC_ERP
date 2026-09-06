import unittest

from app.routers.imports import jushuitan_rows, parse_jushuitan_name, to_float


class JushuitanParserTests(unittest.TestCase):
    def test_parse_jushuitan_name_handles_common_export_variants(self):
        name = "2.京鲜生茯苓500g*1，山药片500g*1；番茄*2，青椒*1"
        self.assertEqual(
            parse_jushuitan_name(name),
            [
                ("京鲜生茯苓500g", 1.0),
                ("山药片500g", 1.0),
                ("番茄", 2.0),
                ("青椒", 1.0),
            ],
        )

    def test_jushuitan_rows_normalizes_status_and_amount(self):
        rows = [
            [
                "出库单号",
                "出库日期",
                "状态",
                "商品名称",
                "卖家实收",
                "店铺名称",
                "快递公司",
                "快递单号",
                "业务员",
            ],
            [
                "JST-001",
                "2024/08/01",
                " 已出库 \n",
                "2.京鲜生茯苓500g*1,山药片500g*1",
                "￥99.90元",
                "京鲜生自营店",
                "顺丰",
                "SF001",
                "张三",
            ],
            [
                "JST-002",
                "2024/08/01",
                "待出库",
                "2.京鲜生茯苓500g*1",
                "24.0",
                "京鲜生自营店",
                "顺丰",
                "SF002",
                "张三",
            ],
        ]

        orders, skip = jushuitan_rows(rows)
        self.assertEqual(len(orders), 1)
        self.assertEqual(orders[0]["doc_no"], "JST-001")
        self.assertEqual(orders[0]["amount"], 99.9)
        self.assertEqual(skip["待出库"], 1)
        self.assertEqual(skip["其他"], 0)

    def test_to_float_accepts_currency_and_thousands_format(self):
        self.assertEqual(to_float("￥1,234.50元"), 1234.5)
        self.assertEqual(to_float("  99.90  "), 99.9)


if __name__ == "__main__":
    unittest.main()
