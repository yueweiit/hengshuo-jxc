ALTER TABLE sys_import_batch ADD COLUMN attempt_no integer NOT NULL DEFAULT 1 CHECK(attempt_no>0),ADD COLUMN previous_batch_id jxc_safe_id;
ALTER TABLE sys_import_batch ADD FOREIGN KEY(country_id,previous_batch_id) REFERENCES sys_import_batch(country_id,id);
ALTER TABLE sys_import_batch DROP CONSTRAINT sys_import_batch_country_id_import_type_file_sha256_key;
ALTER TABLE sys_import_batch ADD UNIQUE(country_id,import_type,file_sha256,attempt_no);
CREATE UNIQUE INDEX sys_import_completed_file ON sys_import_batch(country_id,import_type,file_sha256) WHERE status='COMPLETED';

CREATE OR REPLACE FUNCTION jxc_import_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='sys_import_batch' AND TG_OP='UPDATE' THEN
  IF OLD.status IN ('COMPLETED','CANCELLED') OR ROW(NEW.id,NEW.country_id,NEW.import_type,NEW.template_version,NEW.file_sha256,NEW.cutoff_date,NEW.requested_by,NEW.total_rows,NEW.valid_rows,NEW.error_rows,NEW.created_at,NEW.source_file_text,NEW.content_sha256,NEW.hash_basis,NEW.attempt_no,NEW.previous_batch_id)
   IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.import_type,OLD.template_version,OLD.file_sha256,OLD.cutoff_date,OLD.requested_by,OLD.total_rows,OLD.valid_rows,OLD.error_rows,OLD.created_at,OLD.source_file_text,OLD.content_sha256,OLD.hash_basis,OLD.attempt_no,OLD.previous_batch_id)
  THEN RAISE EXCEPTION 'SYS_IMPORT_IMMUTABLE'; END IF;
  RETURN NEW;
 ELSIF TG_TABLE_NAME='sys_import_row' AND TG_OP='UPDATE' THEN
  IF OLD.target_id IS NOT NULL OR ROW(NEW.id,NEW.country_id,NEW.batch_id,NEW.row_no,NEW.raw,NEW.normalized,NEW.source_key,NEW.errors)
   IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.batch_id,OLD.row_no,OLD.raw,OLD.normalized,OLD.source_key,OLD.errors)
  THEN RAISE EXCEPTION 'SYS_IMPORT_IMMUTABLE'; END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'SYS_IMPORT_IMMUTABLE';
END $$;
