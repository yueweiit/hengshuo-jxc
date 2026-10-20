-- Opening subledger balances keep their own origin and do not assert a cash payment.
ALTER TABLE ap_bill ADD origin_kind varchar(16) NOT NULL DEFAULT 'NORMAL' CHECK(origin_kind IN ('NORMAL','OPENING')), ADD opening_source_ref varchar(160), ADD opening_ref_no varchar(128), ADD opening_cutoff date;
ALTER TABLE ap_prepayment ADD origin_kind varchar(16) NOT NULL DEFAULT 'NORMAL' CHECK(origin_kind IN ('NORMAL','OPENING')), ADD opening_source_ref varchar(160), ADD opening_ref_no varchar(128), ADD opening_cutoff date;
ALTER TABLE ap_prepayment ALTER COLUMN fund_account_id DROP NOT NULL;
DO $$ DECLARE r record; BEGIN FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='ap_prepayment'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%proof_attachment_id%' LOOP EXECUTE format('ALTER TABLE ap_prepayment DROP CONSTRAINT %I',r.conname); END LOOP;END $$;
ALTER TABLE ap_prepayment ADD CONSTRAINT ap_prepayment_origin_evidence CHECK((origin_kind='OPENING' AND opening_source_ref IS NOT NULL AND opening_ref_no IS NOT NULL AND opening_cutoff=pay_date AND fund_account_id IS NULL AND proof_attachment_id IS NULL AND confirmed_by IS NOT NULL) OR (origin_kind='NORMAL' AND fund_account_id IS NOT NULL AND opening_source_ref IS NULL AND opening_ref_no IS NULL AND opening_cutoff IS NULL AND (status IN ('PENDING_CONFIRM','VOIDED') OR (proof_attachment_id IS NOT NULL AND confirmed_by IS NOT NULL))));
ALTER TABLE ap_bill ADD CONSTRAINT ap_bill_origin CHECK((origin_kind='OPENING' AND opening_source_ref IS NOT NULL AND opening_ref_no IS NOT NULL AND opening_cutoff=bill_date AND bill_type='OTHER') OR (origin_kind='NORMAL' AND opening_source_ref IS NULL AND opening_ref_no IS NULL AND opening_cutoff IS NULL));
CREATE UNIQUE INDEX ap_bill_opening_import_source ON ap_bill(country_id,opening_source_ref) WHERE origin_kind='OPENING';
CREATE UNIQUE INDEX ap_bill_opening_business_ref ON ap_bill(country_id,book_id,partner_type,partner_id,opening_ref_no) WHERE origin_kind='OPENING';
CREATE UNIQUE INDEX ap_prepayment_opening_import_source ON ap_prepayment(country_id,opening_source_ref) WHERE origin_kind='OPENING';
CREATE UNIQUE INDEX ap_prepayment_opening_business_ref ON ap_prepayment(country_id,book_id,partner_type,partner_id,opening_ref_no) WHERE origin_kind='OPENING';
ALTER TABLE fin_opening_balance ADD import_source_ref varchar(160),ADD import_ref_no varchar(128);
CREATE UNIQUE INDEX fin_opening_import_source ON fin_opening_balance(country_id,import_source_ref) WHERE import_source_ref IS NOT NULL;
CREATE OR REPLACE FUNCTION jxc_aprtn_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account record;
BEGIN
 IF TG_TABLE_NAME='ap_prepayment' AND to_jsonb(NEW)->>'origin_kind'='OPENING' AND NEW.fund_account_id IS NULL THEN RETURN NEW;END IF;
 SELECT entity_id,book_id,currency INTO account FROM md_fund_account WHERE country_id=NEW.country_id AND id=NEW.fund_account_id;
 IF account IS NULL OR account.entity_id<>NEW.entity_id OR (account.book_id IS NOT NULL AND account.book_id<>NEW.book_id) OR account.currency<>NEW.currency THEN RAISE EXCEPTION 'PAYMENT_ACCOUNT_SOURCE_MISMATCH' USING ERRCODE='23503';END IF;RETURN NEW;
END $$;
