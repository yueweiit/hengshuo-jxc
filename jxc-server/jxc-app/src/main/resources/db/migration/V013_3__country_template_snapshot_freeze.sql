-- Published configuration snapshots and completed local decisions retain their reviewed basis.
CREATE FUNCTION jxc_country_template_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
 IF TG_TABLE_NAME='sys_country_template_item' THEN
  IF TG_OP<>'INSERT' THEN
   SELECT status INTO parent_status FROM sys_country_template WHERE country_id=OLD.country_id AND id=OLD.template_id FOR SHARE;
   IF parent_status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
   SELECT status INTO parent_status FROM sys_country_template WHERE country_id=NEW.country_id AND id=NEW.template_id FOR SHARE;
   IF parent_status IS DISTINCT FROM 'DRAFT' THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='sys_country_template' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'DRAFT' OR NEW.published_by IS NOT NULL OR NEW.published_at IS NOT NULL THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  ELSIF TG_OP='DELETE' THEN
   IF OLD.status<>'DRAFT' THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  ELSIF OLD.status<>'DRAFT' THEN
   IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR NOT(NEW.status=OLD.status OR OLD.status='PUBLISHED' AND NEW.status='RETIRED') THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  ELSE
   IF ROW(NEW.id,NEW.country_id,NEW.version_no,NEW.created_by,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.country_id,OLD.version_no,OLD.created_by,OLD.created_at)
    OR NEW.status NOT IN('DRAFT','PUBLISHED')
    OR NEW.status='PUBLISHED' AND (NEW.published_by IS NULL OR NEW.published_at IS NULL)
    OR NEW.status='DRAFT' AND (NEW.published_by IS NOT NULL OR NEW.published_at IS NOT NULL) THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF TG_TABLE_NAME='sys_country_clone_job' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.status<>'DRAFT' OR NEW.applied_at IS NOT NULL THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  ELSIF TG_OP='DELETE' THEN
   IF OLD.status<>'DRAFT' THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  ELSIF OLD.status<>'DRAFT' THEN
   IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR NOT(NEW.status=OLD.status OR OLD.status='APPLIED' AND NEW.status='DONE') THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['selected_item_ids','copy_result','status','applied_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['selected_item_ids','copy_result','status','applied_at'])
   OR NEW.status NOT IN('DRAFT','APPLIED','CANCELLED') OR NEW.status='APPLIED' AND NEW.applied_at IS NULL OR NEW.status<>'APPLIED' AND NEW.applied_at IS NOT NULL THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='sys_country_config_review' THEN
  IF TG_OP='INSERT' THEN
   IF NEW.review_status<>'NEED_REVIEW' OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.comment<>'' THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  ELSIF TG_OP='DELETE' THEN
   IF OLD.review_status='REVIEWED' THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  ELSIF OLD.review_status='REVIEWED' THEN
   IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['review_status','reviewed_by','reviewed_at','comment']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['review_status','reviewed_by','reviewed_at','comment'])
   OR NEW.review_status<>'REVIEWED' OR NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL OR btrim(NEW.comment)='' THEN RAISE EXCEPTION 'SYS_TEMPLATE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION jxc_country_template_freeze() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jxc_country_template_freeze() TO "${runtimeRole}";
CREATE TRIGGER sys_country_template_freeze BEFORE INSERT OR UPDATE OR DELETE ON sys_country_template FOR EACH ROW EXECUTE FUNCTION jxc_country_template_freeze();
CREATE TRIGGER sys_country_template_item_freeze BEFORE INSERT OR UPDATE OR DELETE ON sys_country_template_item FOR EACH ROW EXECUTE FUNCTION jxc_country_template_freeze();
CREATE TRIGGER sys_country_clone_job_freeze BEFORE INSERT OR UPDATE OR DELETE ON sys_country_clone_job FOR EACH ROW EXECUTE FUNCTION jxc_country_template_freeze();
CREATE TRIGGER sys_country_config_review_freeze BEFORE INSERT OR UPDATE OR DELETE ON sys_country_config_review FOR EACH ROW EXECUTE FUNCTION jxc_country_template_freeze();
