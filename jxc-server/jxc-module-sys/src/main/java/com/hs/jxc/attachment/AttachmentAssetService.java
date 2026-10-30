package com.hs.jxc.attachment;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbContext;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** 仅供已经授权的业务服务使用。复用sys_attachment，不创建第二套对象或商品关系。 */
@Service
public class AttachmentAssetService {
    public enum Policy {
        PURCHASE_SOURCE(100*1024*1024,"PURCHASE_IMPORT_SOURCE"), PURCHASE_IMAGE(10*1024*1024,"PURCHASE_IMPORT_IMAGE"), PRODUCT_INDEX(256*1024*1024,"PRODUCT_IMAGE_INDEX");
        public final int maxBytes; final String category;
        Policy(int maxBytes,String category){this.maxBytes=maxBytes;this.category=category;}
    }
    public record Prepared(String key,String sha256,String fileName,String mimeType,long bytes,Policy policy) {}
    private final AttachmentObjectStore store;private final JdbcTemplate jdbc;private final TransactionTemplate tx;private final DbContext db;
    public AttachmentAssetService(AttachmentObjectStore store,JdbcTemplate jdbc,PlatformTransactionManager tm,DbContext db){this.store=store;this.jdbc=jdbc;this.tx=new TransactionTemplate(tm);this.db=db;}
    public Prepared prepare(RequestContext ctx,Policy policy,String name,String mime,byte[] bytes) {
        if(ctx.countryId()==null)throw Inputs.bad("请先选择国家");
        if(bytes==null||bytes.length==0||bytes.length>policy.maxBytes)throw new ApiException(413,"PUR_IMPORT_ASSET_LIMIT","采购来源或图片超过允许大小");
        if(name==null||name.isBlank()||name.length()>255||name.chars().anyMatch(c->c<32)||name.contains("/")||name.contains("\\"))throw Inputs.bad("文件名称无效");
        String key="country/"+ctx.countryId()+"/purchase-import/"+UUID.randomUUID();
        String sha=AttachmentObjectStore.sha256(bytes);store.put(key,bytes,mime);
        byte[] check=store.read(key,policy.maxBytes);
        if(check.length!=bytes.length||!sha.equals(AttachmentObjectStore.sha256(check)))throw new ApiException(409,"PUR_IMPORT_ASSET_CHANGED","资产内容校验失败");
        return new Prepared(key,sha,name,mime,bytes.length,policy);
    }
    /** 调用方必须在同一短事务内重新核实授权、批次和版本。 */
    public long register(RequestContext ctx,Prepared asset) {
        return jdbc.queryForObject("INSERT INTO sys_attachment(country_id,category,file_name,content_type,size,storage_key,sha256,uploaded_by) VALUES(?,?,?,?,?,?,?,?) RETURNING id",Long.class,ctx.countryId(),asset.policy.category,asset.fileName,asset.mimeType,asset.bytes,asset.key,asset.sha256,ctx.userId());
    }
    public byte[] read(Map<String,Object> snapshot,Policy policy) {
        byte[] bytes=store.read(snapshot.get("storage_key").toString(),policy.maxBytes);
        if(bytes.length!=((Number)snapshot.get("size")).longValue()||!AttachmentObjectStore.sha256(bytes).equals(snapshot.get("sha256")))throw new ApiException(409,"PUR_IMPORT_ASSET_CHANGED","原文件或原图内容已变化");
        return bytes;
    }
    /** 调用方须先锁批次并在同一事务移除引用；新增引用入口也必须校验AVAILABLE并参与批次串行化。附件身份和审计行永久保留。 */
    public List<Long> retireUnreferenced(long country,Collection<Long> ids) {
        if(!TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Retirement requires the business transaction");
        var refs=referenceColumns();var retired=new ArrayList<Long>();
        for(long id:new TreeSet<>(ids)) {
            var asset=locked(country,id);validateImportAsset(country,asset);
            if(referenced(id,refs))continue;
            if(!Set.of("AVAILABLE","MISSING","DELETED").contains(asset.get("object_status")))throw new ApiException(409,"PUR_IMPORT_ASSET_HELD","当前批次的文件已被隔离，请先核实隔离原因后再清空");
            if("AVAILABLE".equals(asset.get("object_status"))) {
                jdbc.update("UPDATE sys_attachment SET object_status='QUARANTINED',version=version+1 WHERE country_id=? AND id=?",country,id);
                retired.add(id);
            }
        }
        return retired;
    }
    /** 只接受业务回执明确列出的资产，不扫描其他隔离文件；所有对象I/O均在事务外。 */
    public void purgeRetired(long country,Collection<Long> ids) {
        if(TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Purge must run after commit");
        for(long id:new TreeSet<>(ids)) {
            String key=tx.execute(s->{db.apply(country);var asset=locked(country,id);validateImportAsset(country,asset);
                if(!"QUARANTINED".equals(asset.get("object_status")))return null; // 已清理或仍由其他业务引用。
                if(referenced(id,referenceColumns())) {jdbc.update("UPDATE sys_attachment SET object_status='AVAILABLE',version=version+1 WHERE country_id=? AND id=?",country,id);return null;}
                // 删除对象前触发既有写入门禁；冻结国家时不能先删除文件再报错。
                jdbc.update("UPDATE sys_attachment SET version=version+1 WHERE country_id=? AND id=?",country,id);
                return asset.get("storage_key").toString();
            });
            if(key==null)continue;
            store.delete(key);
            tx.executeWithoutResult(s->{db.apply(country);jdbc.update("UPDATE sys_attachment SET object_status='DELETED',version=version+1 WHERE country_id=? AND id=? AND object_status='QUARANTINED'",country,id);});
        }
    }
    public int pendingRetired(long country,Collection<Long> ids) {
        return tx.execute(s->{db.apply(country);int count=0;for(long id:ids)if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT object_status='QUARANTINED' FROM sys_attachment WHERE country_id=? AND id=?",Boolean.class,country,id)))count++;return count;});
    }
    private Map<String,Object> locked(long country,long id) {
        var rows=jdbc.queryForList("SELECT id,category,storage_key,object_status FROM sys_attachment WHERE country_id=? AND id=? FOR UPDATE",country,id);
        if(rows.size()!=1)throw ApiException.notFound();return rows.getFirst();
    }
    private void validateImportAsset(long country,Map<String,Object> asset) {
        if(!Set.of(Policy.PURCHASE_SOURCE.category,Policy.PURCHASE_IMAGE.category).contains(asset.get("category"))||!asset.get("storage_key").toString().startsWith("country/"+country+"/purchase-import/"))throw new ApiException(409,"PUR_IMPORT_ASSET_SCOPE","文件不属于可清理的采购导入资产");
    }
    /** 从数据库真实外键取引用表，新增业务引用也自动受到保护；标识符由PostgreSQL安全引用。 */
    private List<Map<String,Object>> referenceColumns() {
        return jdbc.queryForList("SELECT DISTINCT format('%I.%I',ns.nspname,t.relname) AS relation,format('%I',src.attname) AS column_name FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=t.relnamespace CROSS JOIN LATERAL unnest(c.conkey,c.confkey) AS k(srcnum,dstnum) JOIN pg_attribute src ON src.attrelid=c.conrelid AND src.attnum=k.srcnum JOIN pg_attribute dst ON dst.attrelid=c.confrelid AND dst.attnum=k.dstnum WHERE c.contype='f' AND c.confrelid='public.sys_attachment'::regclass AND dst.attname='id'");
    }
    private boolean referenced(long id,List<Map<String,Object>> refs) {
        for(var ref:refs)if(Boolean.TRUE.equals(jdbc.queryForObject("SELECT EXISTS(SELECT 1 FROM "+ref.get("relation")+" WHERE "+ref.get("column_name")+"=?)",Boolean.class,id)))return true;
        return false;
    }
}
