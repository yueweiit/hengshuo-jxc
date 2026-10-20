ALTER TABLE ar_receivable ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE ar_receivable ADD COLUMN opening_ref varchar(100),ADD COLUMN cutoff_date date,ADD COLUMN import_row_id jxc_safe_id;
ALTER TABLE ar_receivable ADD CONSTRAINT ar_opening_origin CHECK((source_type='OPENING_AR' AND order_id IS NULL AND opening_ref IS NOT NULL AND cutoff_date IS NOT NULL AND import_row_id IS NOT NULL AND biz_date=cutoff_date) OR (source_type<>'OPENING_AR' AND order_id IS NOT NULL AND opening_ref IS NULL AND cutoff_date IS NULL AND import_row_id IS NULL));
ALTER TABLE ar_receivable ADD FOREIGN KEY(country_id,import_row_id) REFERENCES sys_import_row(country_id,id);
CREATE UNIQUE INDEX ar_opening_ref ON ar_receivable(country_id,book_id,customer_id,opening_ref) WHERE opening_ref IS NOT NULL;
ALTER TABLE ar_credit_note ADD COLUMN opening_ref varchar(100),ADD COLUMN cutoff_date date,ADD COLUMN import_row_id jxc_safe_id;
ALTER TABLE ar_credit_note ADD CONSTRAINT ar_advance_origin CHECK((source_type='OPENING_ADVANCE' AND order_id IS NULL AND opening_ref IS NOT NULL AND cutoff_date IS NOT NULL AND import_row_id IS NOT NULL AND biz_date=cutoff_date AND purpose='OFFSET' AND NOT refundable_flag) OR (source_type<>'OPENING_ADVANCE' AND opening_ref IS NULL AND cutoff_date IS NULL AND import_row_id IS NULL));
ALTER TABLE ar_credit_note ADD FOREIGN KEY(country_id,import_row_id) REFERENCES sys_import_row(country_id,id);
CREATE UNIQUE INDEX ar_advance_ref ON ar_credit_note(country_id,book_id,customer_id,opening_ref) WHERE opening_ref IS NOT NULL;
