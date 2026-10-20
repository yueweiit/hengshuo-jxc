package com.hs.jxc.attachment;

import com.hs.jxc.common.api.ApiException;
import io.minio.*;
import io.minio.errors.ErrorResponseException;
import java.io.ByteArrayInputStream;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/** Private storage only. Object I/O is deliberately forbidden inside DB transactions. */
@Component
public class AttachmentObjectStore {
    public static final int MAX_BYTES=1024*1024;
    private final String endpoint,accessKey,secretKey,bucket;
    private volatile MinioClient client;
    public AttachmentObjectStore(@Value("${jxc.storage.endpoint:}")String endpoint,
            @Value("${jxc.storage.access-key:}")String accessKey,
            @Value("${jxc.storage.secret-key:}")String secretKey,
            @Value("${jxc.storage.bucket:jxc-evidence}")String bucket) {
        this.endpoint=endpoint;this.accessKey=accessKey;this.secretKey=secretKey;this.bucket=bucket;
    }
    public boolean ready(){outsideTransaction();try{return client().bucketExists(BucketExistsArgs.builder().bucket(bucket).build());}catch(Exception e){return false;}}
    public void put(String key,byte[] bytes,String contentType) {
        outsideTransaction();
        try {
            client().putObject(PutObjectArgs.builder().bucket(bucket).object(key)
                .stream(new ByteArrayInputStream(bytes),(long)bytes.length,-1L).contentType(contentType).build());
        } catch(ApiException e) {throw e;}
        catch(Exception e) {throw unavailable();}
    }
    public byte[] read(String key) {
        outsideTransaction();
        try {
            var storage=client();
            long size=storage.statObject(StatObjectArgs.builder().bucket(bucket).object(key).build()).size();
            if(size<=0||size>MAX_BYTES)throw invalid();
            try(var stream=storage.getObject(GetObjectArgs.builder().bucket(bucket).object(key).build())) {
                byte[] bytes=stream.readNBytes(MAX_BYTES+1);
                if(bytes.length!=size||bytes.length>MAX_BYTES)throw invalid();
                return bytes;
            }
        } catch(ApiException e) {throw e;}
        catch(ErrorResponseException e) {
            if(java.util.Set.of("NoSuchKey","NoSuchObject","NoSuchBucket").contains(e.errorResponse().code()))
                throw new ApiException(404,"ATTACHMENT_MISSING","附件对象不存在");
            throw unavailable();
        } catch(Exception e) {throw unavailable();}
    }
    public static String sha256(byte[] bytes) {
        try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));}
        catch(java.security.NoSuchAlgorithmException e){throw new IllegalStateException(e);}
    }
    private MinioClient client() {
        if(endpoint.isBlank()||accessKey.isBlank()||secretKey.isBlank())throw unavailable();
        if(client==null)synchronized(this) {
            if(client==null) {
                client=MinioClient.builder().endpoint(endpoint).credentials(accessKey,secretKey).build();
                client.setTimeout(5000,5000,5000);
            }
        }
        return client;
    }
    private static void outsideTransaction() {
        if(TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Attachment object I/O must run outside the database transaction");
    }
    static ApiException invalid(){return new ApiException(409,"ATTACHMENT_INVALID","附件内容或关联版本已变化，请重新选择");}
    private static ApiException unavailable(){return new ApiException(503,"STORAGE_UNAVAILABLE","附件存储暂时不可用");}
}
