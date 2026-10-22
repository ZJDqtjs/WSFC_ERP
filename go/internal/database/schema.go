package database

// schemaDDL 与 Python 端 SQLAlchemy 建出的表结构保持一致（列名/类型/默认值逐列对齐），
// 全部使用 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，
// 因此既能给新分仓建库，也不会改动已有分仓库的结构。
const schemaDDL = `
CREATE TABLE IF NOT EXISTS units (
	id INTEGER NOT NULL,
	name VARCHAR(32) NOT NULL,
	category VARCHAR(16) NOT NULL,
	gram_per_unit FLOAT,
	is_standard BOOLEAN NOT NULL DEFAULT 0,
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_units_name ON units (name);

CREATE TABLE IF NOT EXISTS products (
	id INTEGER NOT NULL,
	code VARCHAR(128) NOT NULL DEFAULT '',
	name VARCHAR(128) NOT NULL,
	category VARCHAR(64) NOT NULL DEFAULT '',
	product_type VARCHAR(8) NOT NULL DEFAULT 'stock',
	base_unit VARCHAR(32) NOT NULL,
	default_unit VARCHAR(32) NOT NULL DEFAULT '',
	spec VARCHAR(255) NOT NULL DEFAULT '',
	sale_price FLOAT NOT NULL DEFAULT 0.0,
	unit_cost FLOAT NOT NULL DEFAULT 0.0,
	conversions JSON NOT NULL,
	pack_items JSON NOT NULL,
	pack_fee FLOAT NOT NULL DEFAULT 0.0,
	is_active BOOLEAN NOT NULL DEFAULT 1,
	stock_product_id INTEGER,
	multiplier FLOAT NOT NULL DEFAULT 1.0,
	stock FLOAT NOT NULL DEFAULT 0.0,
	avg_cost FLOAT NOT NULL DEFAULT 0.0,
	stock_value FLOAT NOT NULL DEFAULT 0.0,
	created_at DATETIME NOT NULL,
	workload FLOAT DEFAULT 0,
	weight_kg FLOAT DEFAULT 0,
	stock_links JSON,
	free_shipping BOOLEAN DEFAULT 0,
	stock_schemes JSON,
	PRIMARY KEY (id),
	FOREIGN KEY(stock_product_id) REFERENCES products (id)
);
CREATE INDEX IF NOT EXISTS ix_products_code ON products (code);
CREATE INDEX IF NOT EXISTS ix_products_name ON products (name);
CREATE INDEX IF NOT EXISTS ix_products_stock_product_id ON products (stock_product_id);

CREATE TABLE IF NOT EXISTS inbounds (
	id INTEGER NOT NULL,
	code VARCHAR(32) NOT NULL,
	product_id INTEGER NOT NULL,
	unit VARCHAR(32) NOT NULL,
	quantity FLOAT NOT NULL,
	quantity_base FLOAT NOT NULL,
	unit_price FLOAT NOT NULL,
	total_amount FLOAT NOT NULL,
	supplier VARCHAR(64) NOT NULL DEFAULT '',
	operator VARCHAR(32) NOT NULL DEFAULT '',
	date VARCHAR(10) NOT NULL,
	remark VARCHAR(255) NOT NULL DEFAULT '',
	created_at DATETIME NOT NULL,
	pay_status VARCHAR(8) DEFAULT 'paid',
	paid_at VARCHAR(10) DEFAULT '',
	adjust_amount FLOAT DEFAULT 0,
	freight FLOAT DEFAULT 0,
	handling FLOAT DEFAULT 0,
	PRIMARY KEY (id),
	FOREIGN KEY(product_id) REFERENCES products (id)
);
CREATE INDEX IF NOT EXISTS ix_inbounds_code ON inbounds (code);
CREATE INDEX IF NOT EXISTS ix_inbounds_date ON inbounds (date);

CREATE TABLE IF NOT EXISTS outbounds (
	id INTEGER NOT NULL,
	code VARCHAR(32) NOT NULL,
	customer VARCHAR(64) NOT NULL DEFAULT '',
	operator VARCHAR(32) NOT NULL DEFAULT '',
	date VARCHAR(10) NOT NULL,
	remark VARCHAR(255) NOT NULL DEFAULT '',
	total_amount FLOAT NOT NULL DEFAULT 0.0,
	total_cogs FLOAT NOT NULL DEFAULT 0.0,
	total_fee FLOAT NOT NULL DEFAULT 0.0,
	created_at DATETIME NOT NULL,
	import_group VARCHAR(32) DEFAULT '',
	pack_rule_id INTEGER,
	pack_rule_name VARCHAR(255) DEFAULT '',
	pay_status VARCHAR(8) DEFAULT 'paid',
	paid_at VARCHAR(10) DEFAULT '',
	adjust_amount FLOAT DEFAULT 0,
	brush_cost FLOAT DEFAULT 0,
	brush_fee FLOAT DEFAULT 0,
	brush_auto_fee FLOAT DEFAULT 0,
	settle_income FLOAT DEFAULT 0,
	settle_cats VARCHAR(64) DEFAULT '',
	PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS ix_outbounds_code ON outbounds (code);
CREATE INDEX IF NOT EXISTS ix_outbounds_date ON outbounds (date);

CREATE TABLE IF NOT EXISTS outbound_lines (
	id INTEGER NOT NULL,
	outbound_id INTEGER NOT NULL,
	product_id INTEGER NOT NULL,
	line_type VARCHAR(8) NOT NULL DEFAULT 'sale',
	unit VARCHAR(32) NOT NULL,
	quantity FLOAT NOT NULL,
	quantity_base FLOAT NOT NULL,
	unit_price FLOAT NOT NULL DEFAULT 0.0,
	amount FLOAT NOT NULL DEFAULT 0.0,
	cogs FLOAT NOT NULL DEFAULT 0.0,
	pack_fee FLOAT NOT NULL DEFAULT 0.0,
	sale_product_id INTEGER,
	spec VARCHAR(64) DEFAULT '',
	gross_sales FLOAT DEFAULT 0,
	is_dropship BOOLEAN DEFAULT 0,
	PRIMARY KEY (id),
	FOREIGN KEY(outbound_id) REFERENCES outbounds (id),
	FOREIGN KEY(product_id) REFERENCES products (id)
);
CREATE INDEX IF NOT EXISTS idx_outbound_lines_outbound ON outbound_lines (outbound_id);

CREATE TABLE IF NOT EXISTS stock_movements (
	id INTEGER NOT NULL,
	product_id INTEGER NOT NULL,
	move_type VARCHAR(16) NOT NULL,
	quantity_base FLOAT NOT NULL,
	amount FLOAT NOT NULL DEFAULT 0.0,
	ref_type VARCHAR(16) NOT NULL DEFAULT '',
	ref_id INTEGER,
	date VARCHAR(10) NOT NULL,
	operator VARCHAR(32) NOT NULL DEFAULT '',
	remark VARCHAR(255) NOT NULL DEFAULT '',
	created_at DATETIME NOT NULL,
	line_id INTEGER,
	PRIMARY KEY (id),
	FOREIGN KEY(product_id) REFERENCES products (id)
);
CREATE INDEX IF NOT EXISTS ix_stock_movements_product_id ON stock_movements (product_id);
CREATE INDEX IF NOT EXISTS ix_stock_movements_date ON stock_movements (date);
CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements (ref_type, ref_id);

CREATE TABLE IF NOT EXISTS finance_records (
	id INTEGER NOT NULL,
	type VARCHAR(8) NOT NULL,
	category VARCHAR(32) NOT NULL,
	product_id INTEGER,
	amount FLOAT NOT NULL,
	date VARCHAR(10) NOT NULL,
	operator VARCHAR(32) NOT NULL DEFAULT '',
	remark VARCHAR(255) NOT NULL DEFAULT '',
	ref_type VARCHAR(16) NOT NULL DEFAULT '',
	ref_id INTEGER,
	created_at DATETIME NOT NULL,
	pay_status VARCHAR(8) DEFAULT 'paid',
	paid_at VARCHAR(10) DEFAULT '',
	PRIMARY KEY (id),
	FOREIGN KEY(product_id) REFERENCES products (id)
);
CREATE INDEX IF NOT EXISTS ix_finance_records_date ON finance_records (date);
CREATE INDEX IF NOT EXISTS idx_finance_records_ref ON finance_records (ref_type, ref_id);

CREATE TABLE IF NOT EXISTS other_expenses (
	id INTEGER NOT NULL,
	category VARCHAR(32) NOT NULL,
	amount FLOAT NOT NULL DEFAULT 0.0,
	date VARCHAR(10) NOT NULL,
	remark VARCHAR(255) NOT NULL DEFAULT '',
	operator VARCHAR(32) NOT NULL DEFAULT '',
	created_at DATETIME NOT NULL,
	pay_status VARCHAR(8) DEFAULT 'paid',
	paid_at VARCHAR(10) DEFAULT '',
	ref_type VARCHAR(16) DEFAULT '',
	ref_id INTEGER,
	PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS ix_other_expenses_category ON other_expenses (category);
CREATE INDEX IF NOT EXISTS ix_other_expenses_date ON other_expenses (date);
CREATE INDEX IF NOT EXISTS idx_other_expenses_ref ON other_expenses (ref_type, ref_id);

CREATE TABLE IF NOT EXISTS users (
	id INTEGER NOT NULL,
	username VARCHAR(64) NOT NULL,
	password_hash VARCHAR(255) NOT NULL DEFAULT '',
	name VARCHAR(64) NOT NULL DEFAULT '',
	role VARCHAR(16) NOT NULL DEFAULT 'user',
	is_active BOOLEAN NOT NULL DEFAULT 1,
	created_at DATETIME NOT NULL,
	public_key VARCHAR(512),
	fingerprint VARCHAR(64),
	key_created_at DATETIME,
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_users_username ON users (username);

CREATE TABLE IF NOT EXISTS pack_rules (
	id INTEGER NOT NULL,
	name VARCHAR(512) NOT NULL,
	items JSON NOT NULL,
	box_type VARCHAR(64) NOT NULL DEFAULT '',
	labor_price FLOAT,
	box_ratio FLOAT NOT NULL DEFAULT 1.0,
	remark VARCHAR(255) NOT NULL DEFAULT '',
	is_active BOOLEAN NOT NULL DEFAULT 1,
	created_at DATETIME NOT NULL,
	box_items JSON,
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_pack_rules_name ON pack_rules (name);

CREATE TABLE IF NOT EXISTS code_mappings (
	id INTEGER NOT NULL,
	source VARCHAR(32) NOT NULL DEFAULT 'jushuitan',
	external_code VARCHAR(128) NOT NULL,
	external_name VARCHAR(255) NOT NULL DEFAULT '',
	product_id INTEGER,
	auto_score FLOAT NOT NULL DEFAULT 0.0,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(product_id) REFERENCES products (id)
);
CREATE INDEX IF NOT EXISTS ix_code_mappings_source ON code_mappings (source);
CREATE INDEX IF NOT EXISTS ix_code_mappings_external_code ON code_mappings (external_code);

CREATE TABLE IF NOT EXISTS deductions (
	id INTEGER NOT NULL,
	category VARCHAR(64) NOT NULL,
	percent FLOAT NOT NULL DEFAULT 0.0,
	remark VARCHAR(255) NOT NULL DEFAULT '',
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_deductions_category ON deductions (category);

CREATE TABLE IF NOT EXISTS warehouse_products (
	id INTEGER NOT NULL,
	name VARCHAR(128) NOT NULL,
	category VARCHAR(64) NOT NULL DEFAULT '',
	sku VARCHAR(64) NOT NULL DEFAULT '',
	barcode VARCHAR(64) NOT NULL DEFAULT '',
	box_spec FLOAT NOT NULL DEFAULT 0.0,
	purchase_price FLOAT NOT NULL DEFAULT 0.0,
	freight FLOAT NOT NULL DEFAULT 0.0,
	stock_product_id INTEGER,
	bag_weight FLOAT NOT NULL DEFAULT 0.0,
	shelf_life VARCHAR(32) NOT NULL DEFAULT '',
	remark VARCHAR(255) NOT NULL DEFAULT '',
	is_active BOOLEAN NOT NULL DEFAULT 1,
	created_at DATETIME NOT NULL,
	pack_items JSON,
	dropship_cost FLOAT DEFAULT 0,
	bag_net_weight FLOAT DEFAULT 0,
	bag_net_unit VARCHAR(8) DEFAULT '克',
	PRIMARY KEY (id),
	FOREIGN KEY(stock_product_id) REFERENCES products (id)
);
CREATE INDEX IF NOT EXISTS ix_warehouse_products_name ON warehouse_products (name);
CREATE INDEX IF NOT EXISTS ix_warehouse_products_stock_product_id ON warehouse_products (stock_product_id);

CREATE TABLE IF NOT EXISTS warehouse_ins (
	id INTEGER NOT NULL,
	code VARCHAR(32) NOT NULL,
	product_id INTEGER,
	product_name VARCHAR(128) NOT NULL DEFAULT '',
	category VARCHAR(64) NOT NULL DEFAULT '',
	unit VARCHAR(16) NOT NULL DEFAULT '袋',
	purchase_no VARCHAR(64) NOT NULL DEFAULT '',
	center VARCHAR(64) NOT NULL DEFAULT '',
	quantity FLOAT NOT NULL DEFAULT 0.0,
	box_count FLOAT NOT NULL DEFAULT 0.0,
	box_spec FLOAT NOT NULL DEFAULT 0.0,
	unit_price FLOAT NOT NULL DEFAULT 0.0,
	deduction_percent FLOAT NOT NULL DEFAULT 0.0,
	freight FLOAT NOT NULL DEFAULT 0.0,
	stock_product_id INTEGER,
	bag_weight FLOAT NOT NULL DEFAULT 0.0,
	unit_cost FLOAT NOT NULL DEFAULT 0.0,
	cogs FLOAT NOT NULL DEFAULT 0.0,
	amount FLOAT NOT NULL DEFAULT 0.0,
	freight_total FLOAT NOT NULL DEFAULT 0.0,
	profit FLOAT NOT NULL DEFAULT 0.0,
	date VARCHAR(10) NOT NULL,
	operator VARCHAR(32) NOT NULL DEFAULT '',
	remark VARCHAR(255) NOT NULL DEFAULT '',
	import_group VARCHAR(32) NOT NULL DEFAULT '',
	created_at DATETIME NOT NULL,
	pay_status VARCHAR(8) DEFAULT 'paid',
	paid_at VARCHAR(10) DEFAULT '',
	pack_items JSON,
	pack_cost FLOAT DEFAULT 0,
	bag_cost FLOAT DEFAULT 0,
	PRIMARY KEY (id),
	FOREIGN KEY(product_id) REFERENCES warehouse_products (id)
);
CREATE INDEX IF NOT EXISTS ix_warehouse_ins_code ON warehouse_ins (code);
CREATE INDEX IF NOT EXISTS ix_warehouse_ins_date ON warehouse_ins (date);
CREATE INDEX IF NOT EXISTS ix_warehouse_ins_product_id ON warehouse_ins (product_id);

CREATE TABLE IF NOT EXISTS dropship_bills (
	id INTEGER NOT NULL,
	outbound_id INTEGER NOT NULL,
	outbound_code VARCHAR(32) NOT NULL DEFAULT '',
	date VARCHAR(10) NOT NULL,
	product_id INTEGER NOT NULL,
	product_name VARCHAR(128) NOT NULL DEFAULT '',
	spec VARCHAR(64) NOT NULL DEFAULT '',
	unit VARCHAR(32) NOT NULL DEFAULT '',
	base_unit VARCHAR(32) NOT NULL DEFAULT '',
	quantity FLOAT NOT NULL DEFAULT 0.0,
	quantity_base FLOAT NOT NULL DEFAULT 0.0,
	unit_cost FLOAT NOT NULL DEFAULT 0.0,
	amount FLOAT NOT NULL DEFAULT 0.0,
	sale_price FLOAT NOT NULL DEFAULT 0.0,
	sale_amount FLOAT NOT NULL DEFAULT 0.0,
	operator VARCHAR(32) NOT NULL DEFAULT '',
	pay_status VARCHAR(8) NOT NULL DEFAULT 'unpaid',
	paid_at VARCHAR(10) NOT NULL DEFAULT '',
	created_at DATETIME NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(outbound_id) REFERENCES outbounds (id),
	FOREIGN KEY(product_id) REFERENCES products (id)
);
CREATE INDEX IF NOT EXISTS ix_dropship_bills_date ON dropship_bills (date);
CREATE INDEX IF NOT EXISTS ix_dropship_bills_outbound_id ON dropship_bills (outbound_id);
`

// extraColumns 记录「Python 侧后续新增、但老分仓库里可能还没有」的列。
// 建表后逐表补齐（ALTER TABLE ADD COLUMN），让 Go 与 Python 谁先升级都不会把对方跑挂。
var extraColumns = map[string][]string{
	"products": {
		"workload FLOAT DEFAULT 0", "weight_kg FLOAT DEFAULT 0", "stock_links JSON", "free_shipping BOOLEAN DEFAULT 0",
		"stock_schemes JSON",
	},
	"inbounds": {
		"pay_status VARCHAR(8) DEFAULT 'paid'", "paid_at VARCHAR(10) DEFAULT ''",
		"adjust_amount FLOAT DEFAULT 0", "freight FLOAT DEFAULT 0", "handling FLOAT DEFAULT 0",
	},
	"outbounds": {
		"import_group VARCHAR(32) DEFAULT ''", "pack_rule_id INTEGER", "pack_rule_name VARCHAR(255) DEFAULT ''",
		"pay_status VARCHAR(8) DEFAULT 'paid'", "paid_at VARCHAR(10) DEFAULT ''", "adjust_amount FLOAT DEFAULT 0",
		"brush_cost FLOAT DEFAULT 0", "brush_fee FLOAT DEFAULT 0", "brush_auto_fee FLOAT DEFAULT 0",
		"settle_income FLOAT DEFAULT 0", "settle_cats VARCHAR(64) DEFAULT ''",
	},
	"outbound_lines": {
		"sale_product_id INTEGER", "spec VARCHAR(64) DEFAULT ''", "gross_sales FLOAT DEFAULT 0", "is_dropship BOOLEAN DEFAULT 0",
	},
	"stock_movements": {"line_id INTEGER"},
	"finance_records": {"pay_status VARCHAR(8) DEFAULT 'paid'", "paid_at VARCHAR(10) DEFAULT ''"},
	"other_expenses": {"pay_status VARCHAR(8) DEFAULT 'paid'", "paid_at VARCHAR(10) DEFAULT ''", "ref_type VARCHAR(16) DEFAULT ''", "ref_id INTEGER"},
	"users":          {"password_hash VARCHAR(255) NOT NULL DEFAULT ''", "public_key VARCHAR(512)", "fingerprint VARCHAR(64)", "key_created_at DATETIME"},
	"pack_rules":     {"box_items JSON"},
	"warehouse_ins":  {"pay_status VARCHAR(8) DEFAULT 'paid'", "paid_at VARCHAR(10) DEFAULT ''", "pack_items JSON", "pack_cost FLOAT DEFAULT 0", "bag_cost FLOAT DEFAULT 0"},
	"warehouse_products": {"pack_items JSON", "dropship_cost FLOAT DEFAULT 0", "bag_net_weight FLOAT DEFAULT 0", "bag_net_unit VARCHAR(8) DEFAULT '克'"},
}
