package com.hs.jxc.attachment;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.db.BookGate;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.*;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.function.Function;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.*;

@Service
public class AttachmentService {
    public record EvidenceSpec(long attachmentId,String bizType,long bizId,String category,int linkVersion,String sha256) {}
    public record Download(String fileName,String contentType,byte[] bytes) {}
    /** Opaque, server-created probe; no public constructor or HTTP DTO binding. */
    public static final class PreparedEvidence {
        private final RequestContext context;
        private final Snapshot snapshot;
        private final byte[] bytes;
        private final boolean write;
        private final boolean opaque;
        private PreparedEvidence(RequestContext context,Snapshot snapshot,byte[] bytes,boolean write,boolean opaque) {
            this.context=context;this.snapshot=snapshot;this.bytes=bytes;this.write=write;this.opaque=opaque;
        }
    }
    private record Snapshot(long id,long countryId,long linkId,String bizType,long bizId,String category,int linkVersion,
            String sha256,String storageKey,long size,String fileName,String contentType,long metadataVersion,long relationVersion) {
        EvidenceSpec spec(){return new EvidenceSpec(id,bizType,bizId,category,linkVersion,sha256);}
    }
    private final JdbcTemplate jdbc;
    private final AuthorizationService authorization;
    private final DocumentAccessService sources;
    private final FieldPolicyService fields;
    private final AttachmentObjectStore store;
    private final AuditWriter audit;
    private final BookGate books;
    private final TransactionTemplate tx;
    private final Map<String,Object> opaqueFields;
    @FunctionalInterface public interface EvidenceMutationGuard { void check(Access access,Map<String,Object> source,String category,String operation); }
    private final Map<String,EvidenceMutationGuard> mutationGuards=new java.util.concurrent.ConcurrentHashMap<>();
    public void registerMutationGuard(String type,EvidenceMutationGuard guard){if(mutationGuards.putIfAbsent(type,guard)!=null)throw new IllegalStateException("Duplicate attachment mutation guard");}
    private void mutation(Access a,String type,Map<String,Object> source,String category,String operation){var guard=mutationGuards.get(type);if(guard!=null)guard.check(a,source,category,operation);}
    private final Map<String,Map<String,Set<String>>> categoryPolicies=new java.util.concurrent.ConcurrentHashMap<>();
    public AttachmentService(JdbcTemplate jdbc,AuthorizationService authorization,DocumentAccessService sources,
            FieldPolicyService fields,AttachmentObjectStore store,AuditWriter audit,BookGate books,PlatformTransactionManager manager) {
        this.jdbc=jdbc;this.authorization=authorization;this.sources=sources;this.fields=fields;this.store=store;this.audit=audit;this.books=books;
        tx=new TransactionTemplate(manager);
        Map<String,Object> registry=new LinkedHashMap<>();
        for(String group:FieldPolicyService.GROUPS) {
            String key="attachmentOpaque"+group;fields.register(group,key);registry.put(key,true);
        }
        opaqueFields=Map.copyOf(registry);
    }
    public List<Map<String,Object>> list(RequestContext ctx,String bizType,long bizId,String category) {
        return tx.execute(status->{
            Access access=authorization.authorize(ctx);sources.requireDocumentAccess(access,bizType,bizId,false);category(access,bizType,category,false);
            return jdbc.queryForList("SELECT a.id,a.category,a.file_name,a.size,a.content_type,a.uploaded_at,u.display_name,l.version_no FROM sys_attachment a JOIN sys_attachment_link l ON l.country_id=a.country_id AND l.attachment_id=a.id JOIN sys_user u ON u.id=a.uploaded_by WHERE a.country_id=? AND l.biz_type=? AND l.biz_id=? AND a.category=? AND a.status='VALID' AND a.object_status='AVAILABLE' AND l.unlinked_at IS NULL ORDER BY a.id",access.requireCountry(),bizType,bizId,category).stream().map(this::dto).toList();
        });
    }
    public Map<String,Object> upload(RequestContext ctx,String bizType,long bizId,String category,String fileName,String contentType,byte[] bytes) {
        outsideTransaction();
        if(bytes==null||bytes.length==0||bytes.length>AttachmentObjectStore.MAX_BYTES)throw bad("附件大小须为1字节至1MB");
        String name=fileName(fileName),mime=contentType(contentType);
        long sourceVersion=tx.execute(status->{Access a=authorization.authorize(ctx);var source=sources.requireDocumentAccess(a,bizType,bizId,true);category(a,bizType,category,true);return version(source);});
        String key="country/"+ctx.countryId()+"/attachments/"+UUID.randomUUID();
        String sha=AttachmentObjectStore.sha256(bytes);
        store.put(key,bytes,mime);
        byte[] verified=store.read(key);
        if(verified.length!=bytes.length||!sha.equals(AttachmentObjectStore.sha256(verified)))throw AttachmentObjectStore.invalid();
        // A failed/ambiguous DB commit intentionally retains this private orphan.
        // A later cleanup must prove that no committed metadata references it.
        return tx.execute(status->{
            Access access=authorization.authorize(ctx);
            var source=lockSource(access,bizType,bizId,true);category(access,bizType,category,true);mutation(access,bizType,source,category,"UPLOAD");
            if(version(source)!=sourceVersion)throw new ApiException(409,"SYS_VERSION_CONFLICT","来源已更新，请刷新后重新上传");
            long country=access.requireCountry();
            Long id=jdbc.queryForObject("INSERT INTO sys_attachment(country_id,category,file_name,content_type,size,storage_key,sha256,uploaded_by) VALUES(?,?,?,?,?,?,?,?) RETURNING id",Long.class,country,category,name,mime,bytes.length,key,sha,ctx.userId());
            Integer next=jdbc.queryForObject("SELECT coalesce(max(l.version_no),0)+1 FROM sys_attachment_link l JOIN sys_attachment a ON a.country_id=l.country_id AND a.id=l.attachment_id WHERE l.country_id=? AND l.biz_type=? AND l.biz_id=? AND a.category=?",Integer.class,country,bizType,bizId,category);
            jdbc.update("INSERT INTO sys_attachment_link(country_id,attachment_id,biz_type,biz_id,version_no,linked_by) VALUES(?,?,?,?,?,?)",country,id,bizType,bizId,next,ctx.userId());
            audit(ctx,"ATTACHMENT_UPLOAD",bizType,bizId,Map.of("attachmentId",id,"fileName",name,"category",category,"versionNo",next,"sha256",sha),null);
            return dto(jdbc.queryForMap("SELECT a.id,a.category,a.file_name,a.size,a.content_type,a.uploaded_at,u.display_name,l.version_no FROM sys_attachment a JOIN sys_attachment_link l ON l.country_id=a.country_id AND l.attachment_id=a.id JOIN sys_user u ON u.id=a.uploaded_by WHERE a.id=?",id));
        });
    }
    /** Prepare outside the command transaction; this is the only phase that reads object storage. */
    public PreparedEvidence prepareEvidence(RequestContext ctx,EvidenceSpec spec) {
        Objects.requireNonNull(spec,"Evidence specification is required");
        return prepare(ctx,spec.attachmentId(),spec,true);
    }
    /** Existing commands may select their current linked proof without a new public DTO. */
    public PreparedEvidence prepareEvidence(RequestContext ctx,String type,long id,String category,Map<String,Object> proof) {return prepareLinked(ctx,type,id,category,proof,true);}
    /** Validation only: returns no file content and preserves the source's current read scope. */
    public PreparedEvidence prepareCommandEvidence(RequestContext ctx,String type,long id,String category,Map<String,Object> proof) {return prepareLinked(ctx,type,id,category,proof,false);}
    private PreparedEvidence prepareLinked(RequestContext ctx,String type,long id,String category,Map<String,Object> proof,boolean write) {
        outsideTransaction();
        if(proof!=null&&!proof.isEmpty())return prepare(ctx,Inputs.id(proof.get("attachmentId")),new EvidenceSpec(Inputs.id(proof.get("attachmentId")),type,id,category,Math.toIntExact(Inputs.id(proof.get("linkVersion"))),Inputs.required(proof,"sha256")),write,true);
        EvidenceSpec selected=tx.execute(status->{
            var a=authorization.authorize(ctx);sources.requireDocumentAccess(a,type,id,write);categoryAllowed(type,category);
            var rows=jdbc.queryForList("SELECT a.id,l.version_no,a.sha256 FROM sys_attachment a JOIN sys_attachment_link l ON l.country_id=a.country_id AND l.attachment_id=a.id WHERE a.country_id=? AND l.biz_type=? AND l.biz_id=? AND a.category=? AND a.status='VALID' AND a.object_status='AVAILABLE' AND l.unlinked_at IS NULL ORDER BY l.version_no DESC,a.id DESC LIMIT 1",a.requireCountry(),type,id,category);
            if(rows.isEmpty())throw new ApiException(400,"SYS_ATTACHMENT_REQUIRED","请上传"+category+"附件");
            var row=rows.getFirst();return new EvidenceSpec(number(row,"id"),type,id,category,((Number)row.get("version_no")).intValue(),text(row,"sha256"));
        });
        return prepare(ctx,selected.attachmentId(),selected,write,true);
    }
    /**
     * Join the caller's existing transaction after its auth and sorted book gates.
     * This phase performs no object I/O and keeps source/link locks until caller commit.
     * A FIN_BOOK source is configuration: it requires an exclusive book gate from the start.
     */
    public EvidenceSpec requirePreparedEvidence(RequestContext ctx,Access access,PreparedEvidence prepared) {
        if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Prepared evidence requires the caller's transaction");
        if(prepared==null||ctx.userId()!=prepared.context.userId()||!Objects.equals(ctx.countryId(),prepared.context.countryId())
                ||!Objects.equals(ctx.tokenHash(),prepared.context.tokenHash())||ctx.userId()!=access.userId()||!Objects.equals(ctx.countryId(),access.countryId()))
            throw new ApiException(403,"SYS_FORBIDDEN","附件校验上下文已变化");
        Snapshot before=prepared.snapshot;
        if(before.countryId()!=access.requireCountry())throw ApiException.notFound();
        lockSource(access,before.bizType(),before.bizId(),prepared.write);
        Snapshot current=snapshot(access,before.id(),true);if(prepared.opaque)categoryAllowed(current.bizType(),current.category());else category(access,current.bizType(),current.category(),false);
        if(!current.equals(before))throw AttachmentObjectStore.invalid();
        return current.spec();
    }
    private PreparedEvidence prepare(RequestContext ctx,long id,EvidenceSpec expected,boolean write) {return prepare(ctx,id,expected,write,write);}
    private PreparedEvidence prepare(RequestContext ctx,long id,EvidenceSpec expected,boolean write,boolean opaque) {
        outsideTransaction();
        Snapshot before=tx.execute(status->{Access a=authorization.authorize(ctx);Snapshot row=snapshot(a,id,false);sources.requireDocumentAccess(a,row.bizType(),row.bizId(),write);if(opaque)categoryAllowed(row.bizType(),row.category());else category(a,row.bizType(),row.category(),false);matches(row,expected);return row;});
        byte[] bytes=store.read(before.storageKey());
        if(bytes.length!=before.size()||!AttachmentObjectStore.sha256(bytes).equals(before.sha256()))throw AttachmentObjectStore.invalid();
        return new PreparedEvidence(ctx,before,bytes,write,opaque);
    }
    public Map<String,String> url(RequestContext ctx,long id) {
        return verified(ctx,id,null,false,(snapshot,bytes)->Map.of("url",proxy(snapshot)));
    }
    public Download download(RequestContext ctx,EvidenceSpec spec) {
        return verified(ctx,spec.attachmentId(),spec,false,(snapshot,bytes)->new Download(snapshot.fileName(),snapshot.contentType(),bytes));
    }
    /** M1 convenience wrapper. Later commands prepare first, then join their own ordered transaction. */
    public <T>T withLockedEvidence(RequestContext ctx,EvidenceSpec spec,Function<EvidenceSpec,T> command) {
        return verified(ctx,spec.attachmentId(),spec,true,(snapshot,bytes)->command.apply(snapshot.spec()));
    }
    private <T>T verified(RequestContext ctx,long id,EvidenceSpec expected,boolean write,
            java.util.function.BiFunction<Snapshot,byte[],T> action) {
        PreparedEvidence prepared=prepare(ctx,id,expected,write);
        return tx.execute(status->{
            Access access=authorization.authorize(ctx);
            requirePreparedEvidence(ctx,access,prepared);
            return action.apply(prepared.snapshot,prepared.bytes);
        });
    }
    public void unlink(RequestContext ctx,long id,String reason) {
        if(reason!=null&&reason.length()>1000)throw bad("原因不能超过1000字");
        tx.executeWithoutResult(status->{
            Access a=authorization.authorize(ctx);
            Snapshot initial=snapshot(a,id,false);
            sources.requireDocumentAccess(a,initial.bizType(),initial.bizId(),true);category(a,initial.bizType(),initial.category(),true);
            var source=lockSource(a,initial.bizType(),initial.bizId(),true);category(a,initial.bizType(),initial.category(),true);mutation(a,initial.bizType(),source,initial.category(),"UNLINK");
            Snapshot locked=snapshot(a,id,true);
            if(!initial.equals(locked))throw AttachmentObjectStore.invalid();
            jdbc.update("UPDATE sys_attachment_link SET unlinked_at=clock_timestamp(),version=version+1 WHERE country_id=? AND id=? AND unlinked_at IS NULL",a.requireCountry(),locked.linkId());
            audit(ctx,"ATTACHMENT_UNLINK",locked.bizType(),locked.bizId(),Map.of("attachmentId",id,"fileName",locked.fileName(),"category",locked.category(),"versionNo",locked.linkVersion(),"sha256",locked.sha256()),reason);
        });
    }
    private Map<String,Object> lockSource(Access access,String type,long id,boolean write) {
        if(Set.of("FIN_BOOK","BOOK").contains(type))books.lock(access.requireCountry(),id,true);
        return sources.requireLockedDocumentAccess(access,type,id,write);
    }
    private Snapshot snapshot(Access access,long id,boolean lock) {
        var rows=jdbc.queryForList("SELECT a.id,a.country_id,a.category,a.file_name,a.content_type,a.size,a.storage_key,a.sha256,a.version AS metadata_version,l.id AS link_id,l.biz_type,l.biz_id,l.version_no,l.version AS relation_version FROM sys_attachment a JOIN sys_attachment_link l ON l.country_id=a.country_id AND l.attachment_id=a.id WHERE a.country_id=? AND a.id=? AND a.status='VALID' AND a.object_status='AVAILABLE' AND l.unlinked_at IS NULL"+(lock?" FOR UPDATE OF l,a":""),access.requireCountry(),id);
        if(rows.size()!=1)throw ApiException.notFound();
        var r=rows.getFirst();
        return new Snapshot(number(r,"id"),number(r,"country_id"),number(r,"link_id"),text(r,"biz_type"),number(r,"biz_id"),text(r,"category"),((Number)r.get("version_no")).intValue(),text(r,"sha256"),text(r,"storage_key"),number(r,"size"),text(r,"file_name"),text(r,"content_type"),number(r,"metadata_version"),number(r,"relation_version"));
    }
    /** Source-specific allowlist registered only by trusted server modules. */
    public void registerCategories(String bizType,Map<String,Set<String>> categories) {
        Map<String,Set<String>> copy=new LinkedHashMap<>();
        categories.forEach((category,groups)->{
            if(category==null||category.isBlank()||!FieldPolicyService.GROUPS.containsAll(groups))throw new IllegalArgumentException("Invalid attachment policy");
            copy.put(category,Set.copyOf(groups));
        });
        if(copy.isEmpty()||categoryPolicies.putIfAbsent(bizType,Map.copyOf(copy))!=null)throw new IllegalStateException("Duplicate attachment policy: "+bizType);
    }
    private Set<String> categoryAllowed(String bizType,String category) {
        var policy=categoryPolicies.get(bizType);
        Set<String> groups=policy==null?("IMPORT_FILE".equals(category)?FieldPolicyService.GROUPS:null):policy.get(category);
        if(groups==null)throw bad("此来源不支持该附件类别");
        return groups;
    }
    private void category(Access access,String bizType,String category,boolean write) {
        for(String group:categoryAllowed(bizType,category))if(FieldPolicyService.rank(access.fieldGroups().get(group))<(write?2:1))
            throw new ApiException(403,"SYS_FORBIDDEN","没有此附件所含"+group+"字段的"+(write?"修改":"查看")+"权限");
    }
    private static void matches(Snapshot current,EvidenceSpec wanted) {
        if(wanted!=null&&!current.spec().equals(wanted))throw AttachmentObjectStore.invalid();
    }
    private String proxy(Snapshot s) {return "/api/v1/sys/attachments/"+s.id()+"/content?bizType="+encode(s.bizType())+"&bizId="+s.bizId()+"&category="+encode(s.category())+"&linkVersion="+s.linkVersion()+"&sha256="+s.sha256();}
    private static String encode(String s){return URLEncoder.encode(s,StandardCharsets.UTF_8);}
    private Map<String,Object> dto(Map<String,Object> row) {
        Map<String,Object> result=new LinkedHashMap<>();result.put("id",row.get("id"));result.put("category",row.get("category"));result.put("fileName",row.get("file_name"));result.put("contentType",row.get("content_type"));result.put("size",row.get("size"));result.put("uploadedByName",row.get("display_name"));result.put("uploadedAt",String.valueOf(row.get("uploaded_at")));result.put("versionNo",row.get("version_no"));result.put("status","ACTIVE");return result;
    }
    private void audit(RequestContext ctx,String action,String type,long source,Map<String,Object> details,String reason) {
        audit.append(ctx.countryId(),ctx.userId(),action,type,source,null,details,reason);
    }
    private static long number(Map<String,Object> row,String key){return ((Number)row.get(key)).longValue();}
    private static String text(Map<String,Object> row,String key){return String.valueOf(row.get(key));}
    private static long version(Map<String,Object> row){return number(row,"version");}
    private static String fileName(String name) {
        if(name==null)throw bad("请选择附件文件");
        String clean=name.replace('\\','/');clean=clean.substring(clean.lastIndexOf('/')+1).replaceAll("[\\p{Cntrl}]","").trim();
        if(clean.isEmpty()||clean.length()>255)throw bad("附件文件名不合法");return clean;
    }
    private static String contentType(String type) {
        if(type==null||type.isBlank())return "application/octet-stream";
        try{String parsed=org.springframework.http.MediaType.parseMediaType(type).toString();if(parsed.length()>128)throw bad("附件类型不合法");return parsed;}
        catch(org.springframework.http.InvalidMediaTypeException e){throw bad("附件类型不合法");}
    }
    private static ApiException bad(String message){return new ApiException(400,"SYS_BAD_REQUEST",message);}
    private static void outsideTransaction(){if(TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Start attachment I/O before entering the business transaction");}
}
