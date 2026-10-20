-- Server established opening imports are the only DRAFT exception to ordinary trade.
CREATE FUNCTION jxc_opening_import_allowed(selected_country bigint,document_date date) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE batch_setting text;allowed boolean;
BEGIN
 batch_setting:=current_setting('app.opening_import_batch',true);
 IF document_date IS NULL OR batch_setting IS NULL OR batch_setting !~ '^[1-9][0-9]{0,15}$' OR to_regclass('public.sys_import_batch') IS NULL THEN RETURN false;END IF;
 EXECUTE 'SELECT EXISTS(SELECT 1 FROM public.sys_import_batch WHERE country_id=$1 AND id=$2 AND status=''VALIDATED'' AND left(import_type,8)=''OPENING_'' AND cutoff_date IS NOT NULL AND $3<=cutoff_date)' INTO allowed USING selected_country,batch_setting::bigint,document_date;
 RETURN allowed;
END $$;
CREATE FUNCTION jxc_assert_country_trade(selected_country bigint,document_date date) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE country_status text;
BEGIN
 SELECT status INTO country_status FROM sys_country WHERE id=selected_country FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SYS_COUNTRY_REQUIRED';END IF;
 IF country_status='DISABLED' THEN RAISE EXCEPTION 'SYS_COUNTRY_DISABLED';END IF;
 IF country_status<>'ACTIVE' AND NOT jxc_opening_import_allowed(selected_country,document_date) THEN RAISE EXCEPTION 'SYS_COUNTRY_NOT_ACTIVE';END IF;
END $$;
-- Reused state validator; the trade entry point still enforces country lifecycle first.
CREATE FUNCTION jxc_assert_period_state(p_country_id bigint,p_book_id bigint,p_biz_date date)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE book_status text;period_status text;
BEGIN
 SELECT status INTO book_status FROM fin_book WHERE country_id=p_country_id AND id=p_book_id FOR SHARE;
 IF NOT FOUND OR book_status<>'ACTIVE' THEN RAISE EXCEPTION 'FIN_BOOK_NOT_ACTIVE' USING ERRCODE='P0001';END IF;
 SELECT status INTO period_status FROM fin_period WHERE country_id=p_country_id AND book_id=p_book_id AND p_biz_date BETWEEN start_date AND end_date;
 IF NOT FOUND THEN RAISE EXCEPTION 'FIN_PERIOD_NOT_FOUND' USING ERRCODE='P0001';END IF;
 IF period_status<>'OPEN' THEN RAISE EXCEPTION 'FIN_PERIOD_CLOSED' USING ERRCODE='P0001';END IF;
END $$;
CREATE OR REPLACE FUNCTION jxc_assert_period_open(p_country_id bigint,p_book_id bigint,p_biz_date date)
RETURNS void LANGUAGE plpgsql VOLATILE AS $$
BEGIN
 PERFORM jxc_assert_country_trade(p_country_id,p_biz_date);
 PERFORM jxc_assert_period_state(p_country_id,p_book_id,p_biz_date);
END $$;
REVOKE ALL ON FUNCTION jxc_assert_period_state(bigint,bigint,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jxc_assert_period_state(bigint,bigint,date) TO "${runtimeRole}";
REVOKE ALL ON FUNCTION jxc_opening_import_allowed(bigint,date),jxc_assert_country_trade(bigint,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jxc_opening_import_allowed(bigint,date),jxc_assert_country_trade(bigint,date) TO "${runtimeRole}";
