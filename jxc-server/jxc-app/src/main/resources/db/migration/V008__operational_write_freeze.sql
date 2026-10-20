-- Offline operator control, not an HTTP permission or a replacement for book/period gates.
-- Every application write holds a shared row lock until commit; changing mode drains them.
CREATE TABLE sys_write_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 mode varchar(16) NOT NULL CHECK(mode IN ('OPEN','FROZEN')),
 epoch bigint NOT NULL CHECK(epoch>=0), batch_id uuid,
 operator varchar(200) NOT NULL, reason varchar(1000) NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO sys_write_control(singleton,mode,epoch,operator,reason)
 VALUES(true,'OPEN',0,'schema migration','Initial operational gate; no business data imported');
CREATE TABLE sys_write_control_log (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 mode varchar(16) NOT NULL CHECK(mode IN ('OPEN','FROZEN')), epoch bigint NOT NULL UNIQUE,
 batch_id uuid NOT NULL, operator varchar(200) NOT NULL, reason varchar(1000) NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER sys_write_control_log_append_only BEFORE UPDATE OR DELETE ON sys_write_control_log
 FOR EACH ROW EXECUTE FUNCTION jxc_append_only();
REVOKE ALL ON sys_write_control,sys_write_control_log FROM PUBLIC,"${runtimeRole}";
REVOKE ALL ON SEQUENCE sys_write_control_log_id_seq FROM PUBLIC,"${runtimeRole}";

CREATE FUNCTION jxc_assert_writes_open() RETURNS trigger
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_mode text;
BEGIN
 -- FOR SHARE is deliberate: a stale REPEATABLE READ writer fails serialization after
 -- a mode change, rather than observing the OPEN value in its old MVCC snapshot.
 SELECT mode INTO current_mode FROM public.sys_write_control WHERE singleton FOR SHARE;
 IF NOT FOUND OR current_mode<>'OPEN' THEN
  RAISE EXCEPTION 'SYS_WRITES_FROZEN' USING ERRCODE='P0001';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION jxc_assert_writes_open() FROM PUBLIC;

CREATE FUNCTION jxc_set_write_mode(p_mode text,p_expected_epoch bigint,p_batch_id uuid,p_operator text,p_reason text)
 RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_state public.sys_write_control%ROWTYPE;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('OPEN','FROZEN') OR p_expected_epoch IS NULL OR p_batch_id IS NULL
  OR p_operator IS NULL OR length(btrim(p_operator)) NOT BETWEEN 1 AND 200
  OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'SYS_WRITE_CONTROL_INVALID' USING ERRCODE='22023';
 END IF;
 SELECT * INTO current_state FROM public.sys_write_control WHERE singleton FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SYS_WRITE_CONTROL_MISSING' USING ERRCODE='P0001'; END IF;
 -- A lost response may retry the exact transition using its original expected epoch.
 IF current_state.mode=p_mode AND current_state.batch_id=p_batch_id
   AND current_state.operator=p_operator AND current_state.reason=p_reason
   AND current_state.epoch=p_expected_epoch+1 THEN RETURN to_jsonb(current_state); END IF;
 IF current_state.epoch<>p_expected_epoch THEN
  RAISE EXCEPTION 'SYS_WRITE_EPOCH_CONFLICT' USING ERRCODE='40001';
 END IF;
 IF current_state.mode=p_mode THEN RETURN to_jsonb(current_state); END IF;
 UPDATE public.sys_write_control SET mode=p_mode,epoch=epoch+1,batch_id=p_batch_id,
  operator=p_operator,reason=p_reason,changed_at=clock_timestamp() WHERE singleton
  RETURNING * INTO current_state;
 INSERT INTO public.sys_write_control_log(mode,epoch,batch_id,operator,reason,changed_at)
  VALUES(current_state.mode,current_state.epoch,p_batch_id,p_operator,p_reason,current_state.changed_at);
 RETURN to_jsonb(current_state);
END $$;
REVOKE ALL ON FUNCTION jxc_set_write_mode(text,bigint,uuid,text,text) FROM PUBLIC,"${runtimeRole}";

DO $$ DECLARE target record; BEGIN
 FOR target IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p')
   AND c.relname NOT IN ('flyway_schema_history','sys_write_control','sys_write_control_log')
 LOOP
  EXECUTE format('CREATE TRIGGER jxc_write_gate BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.jxc_assert_writes_open()',target.relname);
 END LOOP;
END $$;
-- Future migrations adding writable tables must install this statement trigger too.

-- pg_restore deliberately clears search_path. These recursive CHECK helpers must
-- resolve their existing implementation even while COPY restores nested JSON.
-- Keep the old migration checksum and the original ID validation semantics.
ALTER FUNCTION public.jxc_json_ids_safe(jsonb) SET search_path=pg_catalog,public;
ALTER FUNCTION public.jxc_json_id_value_safe(jsonb) SET search_path=pg_catalog,public;
