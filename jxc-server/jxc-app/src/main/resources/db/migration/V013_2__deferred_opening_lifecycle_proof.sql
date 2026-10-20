-- Deferred ledger projection checks run after the server import scope is closed.
-- Their DRAFT exception is tied to completed immutable native GL import results.
CREATE FUNCTION jxc_assert_opening_projection_period(selected_country bigint,selected_book bigint,cutoff date) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE country_status text;
BEGIN
 SELECT status INTO country_status FROM sys_country WHERE id=selected_country FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SYS_COUNTRY_REQUIRED';END IF;
 IF country_status='DISABLED' THEN RAISE EXCEPTION 'SYS_COUNTRY_DISABLED';END IF;
 IF country_status<>'ACTIVE' THEN
  IF NOT EXISTS(SELECT 1 FROM fin_opening_balance WHERE country_id=selected_country AND book_id=selected_book AND status='CONFIRMED')
   OR EXISTS(SELECT 1 FROM fin_opening_balance o WHERE o.country_id=selected_country AND o.book_id=selected_book AND o.status='CONFIRMED' AND NOT EXISTS(
    SELECT 1 FROM sys_import_batch b
    JOIN sys_import_row r ON r.country_id=b.country_id AND r.batch_id=b.id
    JOIN sys_import_source s ON s.country_id=r.country_id AND s.row_id=r.id AND s.import_type=b.import_type AND s.source_key=r.source_key
    JOIN fin_account a ON a.country_id=o.country_id AND a.book_id=o.book_id AND a.id=o.account_id
    JOIN fin_book k ON k.country_id=o.country_id AND k.id=o.book_id
    WHERE b.country_id=o.country_id AND b.import_type='OPENING_GL' AND b.status='COMPLETED' AND b.cutoff_date=cutoff AND o.cutoff_date=cutoff
     AND b.confirmed_by=o.confirmed_by AND b.requested_by=o.created_by
     AND r.target_type='FIN_OPENING_BALANCE' AND r.target_id=o.id AND o.import_source_ref='IMPORT:'||b.id||':'||r.row_no
     AND r.normalized->>'refNo'=o.import_ref_no AND (r.normalized->>'bookId')::bigint=o.book_id AND (r.normalized->>'accountId')::bigint=o.account_id
     AND COALESCE(r.normalized->>'currency',k.base_currency)=o.currency AND COALESCE(r.normalized->>'direction',a.direction)=o.direction
     AND COALESCE(r.normalized->'aux','{}'::jsonb)=o.aux
     AND COALESCE((r.normalized->>'amount')::numeric,(r.normalized->>'baseAmount')::numeric)=o.base_amount
     AND COALESCE((r.normalized->>'origAmount')::numeric,(r.normalized->>'amount')::numeric,(r.normalized->>'baseAmount')::numeric)=o.orig_amount
     AND COALESCE((r.normalized->>'rate')::numeric,1)=o.rate
   )) THEN RAISE EXCEPTION 'SYS_IMPORT_OPENING_SOURCE_MISMATCH' USING ERRCODE='23514';END IF;
 END IF;
 PERFORM jxc_assert_period_state(selected_country,selected_book,cutoff+1);
END $$;
REVOKE ALL ON FUNCTION jxc_assert_opening_projection_period(bigint,bigint,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jxc_assert_opening_projection_period(bigint,bigint,date) TO "${runtimeRole}";

CREATE OR REPLACE FUNCTION jxc_fin_opening_projection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o fin_opening_balance;cutoffs int;cutoff date;net numeric;r record;balance_id bigint;
BEGIN
 SELECT * INTO o FROM fin_opening_balance WHERE country_id=NEW.country_id AND id=NEW.id;
 IF NOT FOUND OR o.status<>'CONFIRMED' THEN RETURN NULL;END IF;
 IF EXISTS(SELECT 1 FROM fin_opening_balance WHERE country_id=o.country_id AND book_id=o.book_id AND status='CONFIRMED' AND (confirmed_by IS NULL OR confirmed_at IS NULL)) THEN RAISE EXCEPTION 'FIN_OPENING_CONFIRMATION_REQUIRED';END IF;
 SELECT count(DISTINCT cutoff_date),min(cutoff_date),COALESCE(sum(CASE WHEN direction='DEBIT' THEN base_amount ELSE -base_amount END),0) INTO cutoffs,cutoff,net FROM fin_opening_balance WHERE country_id=o.country_id AND book_id=o.book_id AND status='CONFIRMED';
 IF net<>0 THEN RAISE EXCEPTION 'FIN_UNBALANCED';END IF;
 IF cutoffs<>1 THEN RAISE EXCEPTION 'FIN_OPENING_CUTOFF_MISMATCH';END IF;
 IF NOT EXISTS(SELECT 1 FROM fin_period WHERE country_id=o.country_id AND book_id=o.book_id AND start_date=cutoff+1 AND status='OPEN') THEN RAISE EXCEPTION 'FIN_OPENING_PERIOD';END IF;
 PERFORM jxc_assert_opening_projection_period(o.country_id,o.book_id,cutoff);
 IF EXISTS(SELECT 1 FROM fin_voucher WHERE country_id=o.country_id AND book_id=o.book_id AND status IN ('POSTED','REVERSED') AND voucher_date<=cutoff) THEN RAISE EXCEPTION 'FIN_OPENING_CUTOFF';END IF;
 IF EXISTS(SELECT 1 FROM fin_voucher WHERE country_id=o.country_id AND book_id=o.book_id AND status IN ('POSTED','REVERSED')) THEN RAISE EXCEPTION 'FIN_OPENING_LOCKED';END IF;
 FOR r IN SELECT DISTINCT p.id period_id,b.account_id,b.aux_key,b.currency FROM fin_opening_balance b JOIN fin_period p ON p.country_id=b.country_id AND p.book_id=b.book_id AND p.start_date>cutoff WHERE b.country_id=o.country_id AND b.book_id=o.book_id AND b.status='CONFIRMED' LOOP
  SELECT id INTO balance_id FROM fin_account_balance WHERE country_id=o.country_id AND book_id=o.book_id AND period_id=r.period_id AND account_id=r.account_id AND aux_key=r.aux_key AND currency=r.currency;
  IF NOT FOUND THEN RAISE EXCEPTION 'FIN_BALANCE_PROJECTION_MISSING';END IF;PERFORM jxc_fin_assert_balance(balance_id);
 END LOOP;RETURN NULL;
END $$;
