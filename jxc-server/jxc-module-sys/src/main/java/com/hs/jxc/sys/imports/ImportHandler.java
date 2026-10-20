package com.hs.jxc.sys.imports;

import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.sys.api.Access;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/** Owner module command port. Validate is read-only; apply joins the import confirmation transaction. */
public interface ImportHandler {
    record Batch(long id, String type, LocalDate cutoffDate) {}
    record Row(int rowNo, Map<String,Object> values, String sourceKey) {}
    record Target(String type, long id) {}
    static String commandKey(Batch batch,Row row,String operation){return java.util.UUID.nameUUIDFromBytes((batch.id()+":"+row.rowNo()+":"+operation).getBytes(java.nio.charset.StandardCharsets.UTF_8)).toString();}
    List<String> types();
    List<String> columns(String type);
    /** Return canonical owner-validated values. Reject unknown references, future opening dates and existing business references. */
    Row validate(Access access, String type, LocalDate cutoffDate, int rowNo, Map<String,Object> raw);
    /** Revalidate under owner locks; this must never commit independently or infer opening balances. */
    Target apply(RequestContext context, Access access, Batch batch, Row row);
    /** Owner batch invariant, e.g. balanced GL opening confirmation; joins the same transaction. */
    default void finish(RequestContext context, Access access, Batch batch, List<Target> targets) {}
}
