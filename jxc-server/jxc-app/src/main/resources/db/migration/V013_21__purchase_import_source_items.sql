-- 同一原行可以按不同数量单元格拆规格；旧来源保留原行身份。
-- 纯DDL避免强制RLS使迁移账号漏回填历史国家；NULL明确代表旧ROW身份，不代表解析失败。
ALTER TABLE pur_order_import ADD COLUMN source_item_key text;
DROP INDEX pur_import_source_row_uq;
CREATE UNIQUE INDEX pur_import_source_item_uq ON pur_order_import(country_id,source_id,source_sheet,COALESCE(source_item_key,'ROW:'||source_row));
ALTER TABLE pur_order_import ADD CONSTRAINT pur_import_source_item_position CHECK(
    source_item_key IS NULL OR source_item_key='ROW:'||source_row OR source_item_key ~ ('^[A-Z]{1,3}'||source_row||'$')
);
