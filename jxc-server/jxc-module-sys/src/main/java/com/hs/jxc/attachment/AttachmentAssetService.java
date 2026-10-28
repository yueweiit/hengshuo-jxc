package com.hs.jxc.attachment;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/** 仅供已经授权的业务服务使用。复用sys_attachment，不创建第二套对象或商品关系。 */
@Service
public class AttachmentAssetService {
    public enum Policy {
        PURCHASE_SOURCE(100*1024*1024,"PURCHASE_IMPORT_SOURCE"), PURCHASE_IMAGE(10*1024*1024,"PURCHASE_IMPORT_IMAGE");
        public final int maxBytes; final String category;
        Policy(int maxBytes,String category){this.maxBytes=maxBytes;this.category=category;}
    }
    public record Prepared(String key,String sha256,String fileName,String mimeType,long bytes,Policy policy) {}
    private final AttachmentObjectStore store;private final JdbcTemplate jdbc;
    public AttachmentAssetService(AttachmentObjectStore store,JdbcTemplate jdbc){this.store=store;this.jdbc=jdbc;}
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
}
