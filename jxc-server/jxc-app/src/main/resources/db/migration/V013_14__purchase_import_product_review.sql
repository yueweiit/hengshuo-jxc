ALTER TABLE pur_order_import
 ADD COLUMN matched_product_id jxc_safe_id,
 ADD COLUMN purchase_unit text,
 ADD COLUMN supplied_product_code text,
 ADD COLUMN supplied_product_name text,
 ADD COLUMN supplier_product_code text,
 ADD COLUMN decision text NOT NULL DEFAULT 'UNRESOLVED' CHECK(decision IN ('UNRESOLVED','EXISTING','NEW_REQUESTED','DEFERRED')),
 ADD COLUMN readiness text NOT NULL DEFAULT 'UNRESOLVED' CHECK(readiness IN ('UNRESOLVED','NEEDS_SETUP','READY')),
 ADD COLUMN product_snapshot jsonb,
 ADD COLUMN setup_reasons jsonb NOT NULL DEFAULT '[]',
 ADD COLUMN confirmed_by jxc_safe_id REFERENCES sys_user(id),
 ADD COLUMN confirmed_at timestamptz,
 ADD COLUMN product_operation jsonb;
COMMENT ON COLUMN pur_order_import.product_operation IS '原新品命令与分步结果；阶段成功及真实商品ID同事务保存，恢复不重复建档';
