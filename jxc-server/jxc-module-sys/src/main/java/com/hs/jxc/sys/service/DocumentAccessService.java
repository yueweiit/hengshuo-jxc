package com.hs.jxc.sys.service;

import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.sys.api.Access;
import org.springframework.stereotype.Service;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Trusted resolver registry, shared by source links, attachments, exports and future commands. */
@Service
public class DocumentAccessService {
    @FunctionalInterface public interface Resolver { Map<String,Object> resolve(Access access,long id); }
    @FunctionalInterface public interface SourceLocker { void lock(Access access,long id); }
    private record Rule(List<String> read,List<String> write,Resolver resolver,SourceLocker locker) {}
    private final Map<String,Rule> rules=new ConcurrentHashMap<>();
    /** Only server module configuration can register a type and its authoritative DB resolver. */
    public void register(String type,List<String> read,List<String> write,Resolver resolver) {
        register(type,read,write,resolver,null);
    }
    public void register(String type,List<String> read,List<String> write,Resolver resolver,SourceLocker locker) {
        if(read.isEmpty() || rules.putIfAbsent(type,new Rule(List.copyOf(read),List.copyOf(write),resolver,locker))!=null)
            throw new IllegalStateException("Duplicate or invalid document policy: "+type);
    }
    /** Distinguishes unregistered resources from a registered source denied by its owner. */
    public boolean supports(String type) { return rules.containsKey(type); }
    public Map<String,Object> requireDocumentAccess(Access access,String type,long id,boolean write) {
        Rule rule=rules.get(type);
        if(rule==null) throw missing();
        Map<String,Object> row=rule.resolver().resolve(access,id);
        if(row==null) throw missing();
        access.requireRow(row);
        List<String> permissions=write?rule.write():rule.read();
        if(permissions.isEmpty())throw new ApiException(403,"SYS_FORBIDDEN","此来源不允许修改");
        access.require(permissions.toArray(String[]::new));
        return row;
    }
    public Map<String,Object> requireLockedDocumentAccess(Access access,String type,long id,boolean write) {
        if(!org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive())throw new IllegalStateException("Source locks require an existing transaction");
        Rule rule=rules.get(type);if(rule==null||rule.locker()==null)throw missing();
        rule.locker().lock(access,id);
        return requireDocumentAccess(access,type,id,write);
    }
    private static ApiException missing() {return new ApiException(404,"NOT_FOUND","记录不存在或不在你的数据范围内");}
}
