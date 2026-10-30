-- 商品照片与特征均为可选子记录；不改变商品、采购、费用或成本表的必填规则。
-- 沿用附件的国家隔离，同一文件的商品关系只保存在本表，不重复写通用附件关联。
CREATE TABLE md_product_image (
    id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
    country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
    product_id jxc_safe_id NOT NULL REFERENCES md_product(id),
    attachment_id jxc_safe_id NOT NULL,
    is_primary boolean NOT NULL DEFAULT false,
    sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
    status varchar(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED')),
    created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    UNIQUE (country_id, id),
    FOREIGN KEY (country_id, attachment_id) REFERENCES sys_attachment(country_id, id)
);

CREATE UNIQUE INDEX md_product_image_active_uq
    ON md_product_image(country_id, product_id, attachment_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX md_product_image_primary_uq
    ON md_product_image(country_id, product_id) WHERE status = 'ACTIVE' AND is_primary;
CREATE INDEX md_product_image_display_idx
    ON md_product_image(country_id, product_id, sort_order, id) WHERE status = 'ACTIVE';
CREATE INDEX md_product_image_attachment_idx ON md_product_image(country_id, attachment_id);

CREATE TABLE image_feature (
    id jxc_safe_id PRIMARY KEY DEFAULT nextval('jxc_id_seq'),
    country_id jxc_safe_id NOT NULL REFERENCES sys_country(id),
    attachment_id jxc_safe_id NOT NULL,
    model_name varchar(128) NOT NULL CHECK (btrim(model_name) <> ''),
    model_version varchar(128) NOT NULL CHECK (btrim(model_version) <> ''),
    preprocess_version varchar(128) NOT NULL CHECK (btrim(preprocess_version) <> ''),
    feature_format varchar(16) NOT NULL DEFAULT 'FLOAT32_LE' CHECK (feature_format = 'FLOAT32_LE'),
    dimension integer CHECK (dimension > 0),
    feature_data bytea,
    feature_status varchar(16) NOT NULL DEFAULT 'PENDING'
        CHECK (feature_status IN ('PENDING', 'READY', 'FAILED')),
    index_status varchar(16) NOT NULL DEFAULT 'PENDING'
        CHECK (index_status IN ('PENDING', 'READY', 'FAILED')),
    error_message text CHECK (btrim(error_message) <> ''),
    created_by jxc_safe_id NOT NULL REFERENCES sys_user(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    UNIQUE (country_id, id),
    UNIQUE (country_id, attachment_id, model_name, model_version, preprocess_version),
    FOREIGN KEY (country_id, attachment_id) REFERENCES sys_attachment(country_id, id),
    CONSTRAINT image_feature_payload_state CHECK (
        (feature_status = 'READY' AND feature_data IS NOT NULL AND dimension IS NOT NULL)
        OR (feature_status IN ('PENDING', 'FAILED') AND feature_data IS NULL)
    ),
    CONSTRAINT image_feature_payload_size CHECK (
        feature_data IS NULL
        OR (dimension IS NOT NULL AND octet_length(feature_data)::bigint = dimension::bigint * 4)
    ),
    CONSTRAINT image_feature_index_state CHECK (index_status = 'PENDING' OR feature_status = 'READY'),
    CONSTRAINT image_feature_error_state CHECK (
        (feature_status = 'FAILED' OR index_status = 'FAILED') = (error_message IS NOT NULL)
    )
);

CREATE INDEX image_feature_extraction_idx ON image_feature(country_id, feature_status, id)
    WHERE feature_status IN ('PENDING', 'FAILED');
CREATE INDEX image_feature_indexing_idx ON image_feature(country_id, index_status, id)
    WHERE feature_status = 'READY';

COMMENT ON TABLE md_product_image IS '商品可选照片关联；无照片时不创建记录';
COMMENT ON TABLE image_feature IS '照片可选模型特征备份；无特征需求时不创建记录';
COMMENT ON COLUMN image_feature.id IS '稳定特征编号，可用于FAISS编号映射';
COMMENT ON COLUMN image_feature.model_version IS '具体模型权重版本，调用方应采用权重校验值等稳定标识';
COMMENT ON COLUMN image_feature.preprocess_version IS '图片缩放、裁剪、归一化等处理规则的版本';
COMMENT ON COLUMN image_feature.feature_data IS 'dimension个float32的小端字节序数据；数值有效性由后续模型服务校验';

-- 复用现有安全与维护保护，不因新增表而绕过国家隔离、停用或全局冻结。
DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['md_product_image', 'image_feature'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY country_isolation ON %I USING (country_id = jxc_current_country_id()) WITH CHECK (country_id = jxc_current_country_id())', table_name);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO %I', table_name, '${runtimeRole}');
        EXECUTE format('CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION jxc_assert_writes_open()', table_name);
        EXECUTE format('CREATE TRIGGER jxc_country_gate BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION jxc_country_mutation_gate(''CONFIG'')', table_name);
    END LOOP;
END $$;
