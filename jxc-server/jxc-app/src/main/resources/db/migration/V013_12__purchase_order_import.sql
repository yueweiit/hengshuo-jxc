-- 独立采购导入明细；不生成正式采购、库存或财务记录，也不建立业务外键。
CREATE TABLE pur_order_import (
    id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
    country_id jxc_safe_id NOT NULL,
    batch_id uuid NOT NULL,
    row_no integer NOT NULL CHECK (row_no > 0),
    book_id jxc_safe_id NOT NULL,
    supplier_id jxc_safe_id NOT NULL,
    currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    order_date date NOT NULL,
    expected_date date,
    payment_terms varchar(200) NOT NULL DEFAULT '',
    prepay_ratio numeric(9,6) CHECK (prepay_ratio BETWEEN 0 AND 1),
    term_days integer CHECK (term_days >= 0),
    source_order_no varchar(100) NOT NULL CHECK (btrim(source_order_no) <> ''),
    photo text,
    product_spec text,
    purchase_qty numeric(20,4) NOT NULL CHECK (purchase_qty > 0 AND purchase_qty <> 'NaN'::numeric),
    sale_unit_price numeric(30,10) CHECK (sale_unit_price >= 0 AND sale_unit_price <> 'NaN'::numeric),
    sale_total numeric(30,10) CHECK (sale_total >= 0 AND sale_total <> 'NaN'::numeric),
    purchase_unit_price numeric(30,10) CHECK (purchase_unit_price >= 0 AND purchase_unit_price <> 'NaN'::numeric),
    freight numeric(30,10) CHECK (freight >= 0 AND freight <> 'NaN'::numeric),
    landed_unit_cost numeric(30,10) CHECK (landed_unit_cost >= 0 AND landed_unit_cost <> 'NaN'::numeric),
    usd_unit_cost numeric(30,10) CHECK (usd_unit_cost >= 0 AND usd_unit_cost <> 'NaN'::numeric),
    usd_total numeric(30,10) CHECK (usd_total >= 0 AND usd_total <> 'NaN'::numeric),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by jxc_safe_id NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (country_id, id),
    UNIQUE (country_id, batch_id, row_no)
);

COMMENT ON TABLE pur_order_import IS '采购导入独立明细；每行一个规格，同批次基础信息由后端事务统一保存';
COMMENT ON COLUMN pur_order_import.row_no IS '批次内稳定行序号，追加文件时分配后续编号；与文件校验错误的原始Excel行号区分';
COMMENT ON COLUMN pur_order_import.book_id IS '基础信息快照，不建立财务账套外键';
COMMENT ON COLUMN pur_order_import.supplier_id IS '供应商标识快照，不建立业务外键';
COMMENT ON COLUMN pur_order_import.source_order_no IS '模板采购单号，允许同单号的不同规格分行';
COMMENT ON COLUMN pur_order_import.photo IS '商品照片引用，由接入的XLSX解析代码提供，空值表示待核实';
COMMENT ON COLUMN pur_order_import.product_spec IS '模板商品规格，一行一个规格，不固定尺码列';
COMMENT ON COLUMN pur_order_import.freight IS '模板原始运费，不自动按明细重复分摊整单费用';
COMMENT ON COLUMN pur_order_import.updated_at IS '后端每次成功保存时更新，同时递增version';

-- 复用系统国家隔离、停用与维护冻结保护，不接入正式业务事件或成本计算。
ALTER TABLE pur_order_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE pur_order_import FORCE ROW LEVEL SECURITY;
CREATE POLICY country_isolation ON pur_order_import
    USING (country_id = jxc_current_country_id())
    WITH CHECK (country_id = jxc_current_country_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON pur_order_import TO "${runtimeRole}";
CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
    ON pur_order_import FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open();
CREATE TRIGGER jxc_country_gate BEFORE INSERT OR UPDATE OR DELETE
    ON pur_order_import FOR EACH ROW EXECUTE FUNCTION jxc_country_mutation_gate('CONFIG');
