-- Complete existing MD reference fields; do not infer or seed financial configuration.
ALTER TABLE md_fund_account ADD COLUMN account_no_masked varchar(100);
CREATE FUNCTION jxc_fund_has_sources(c bigint,f bigint) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT EXISTS(SELECT 1 FROM ar_receipt WHERE country_id=c AND fund_account_id=f UNION ALL SELECT 1 FROM ap_payment WHERE country_id=c AND fund_account_id=f UNION ALL SELECT 1 FROM ap_prepayment WHERE country_id=c AND fund_account_id=f UNION ALL SELECT 1 FROM rtn_refund WHERE country_id=c AND fund_account_id=f UNION ALL SELECT 1 FROM fin_voucher_line WHERE country_id=c AND aux->>'fundAccountId'=f::text UNION ALL SELECT 1 FROM fin_opening_balance WHERE country_id=c AND aux->>'fundAccountId'=f::text)
$$;
CREATE FUNCTION jxc_fund_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.book_id IS NOT NULL AND NEW.book_id IS DISTINCT FROM OLD.book_id THEN RAISE EXCEPTION 'MD_FUND_BOOK_IMMUTABLE' USING ERRCODE='23514';END IF;
 IF (NEW.book_id IS DISTINCT FROM OLD.book_id OR NEW.entity_id<>OLD.entity_id OR NEW.currency<>OLD.currency OR NEW.account_type<>OLD.account_type OR NEW.store_id IS DISTINCT FROM OLD.store_id) AND jxc_fund_has_sources(OLD.country_id,OLD.id) THEN RAISE EXCEPTION 'MD_FUND_REFERENCED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER md_fund_binding_guard BEFORE UPDATE ON md_fund_account FOR EACH ROW EXECUTE FUNCTION jxc_fund_binding_guard();
CREATE OR REPLACE FUNCTION jxc_aprtn_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE account record;BEGIN
 SELECT entity_id,book_id,currency INTO account FROM md_fund_account WHERE country_id=NEW.country_id AND id=NEW.fund_account_id FOR SHARE;
 IF account IS NULL OR account.entity_id<>NEW.entity_id OR (account.book_id IS NOT NULL AND account.book_id<>NEW.book_id) OR account.currency<>NEW.currency THEN RAISE EXCEPTION 'PAYMENT_ACCOUNT_SOURCE_MISMATCH' USING ERRCODE='23503';END IF;RETURN NEW;
END $$;
