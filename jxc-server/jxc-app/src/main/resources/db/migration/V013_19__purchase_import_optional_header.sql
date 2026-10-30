-- 文件来源先暂存，业务表头在保存/创建采购草稿时核验；正式采购约束保持原样。
ALTER TABLE pur_order_import
    ALTER COLUMN book_id DROP NOT NULL,
    ALTER COLUMN supplier_id DROP NOT NULL,
    ALTER COLUMN currency DROP NOT NULL,
    ALTER COLUMN order_date DROP NOT NULL;

COMMENT ON TABLE pur_order_import IS '采购来源暂存明细；业务基础信息可未知，保存基础信息或建单时严格核验';
COMMENT ON COLUMN pur_order_import.book_id IS '已保存业务表头的账套快照；未配置时为NULL，不猜测默认账套';
COMMENT ON COLUMN pur_order_import.supplier_id IS '供应商快照；文件暂存阶段允许NULL';
