-- 来源暂存允许未知单号/数量；已知值的正数、精度和国家隔离约束继续生效。
ALTER TABLE pur_order_import
    ALTER COLUMN source_order_no DROP NOT NULL,
    ALTER COLUMN purchase_qty DROP NOT NULL;
COMMENT ON COLUMN pur_order_import.source_order_no IS '来源单号；未知为NULL，人工核对后才能参与采购分组';
COMMENT ON COLUMN pur_order_import.purchase_qty IS '来源采购数量；未知为NULL，不补零，建采购草稿前必须核实';
