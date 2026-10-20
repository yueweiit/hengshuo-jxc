package com.hs.jxc.common.idempotency;

import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.api.*;
import java.math.BigDecimal;
import java.net.URI;
import java.util.*;
import java.util.function.Consumer;
import java.util.function.Supplier;
import org.springframework.stereotype.Component;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.*;

/** Call after authoritative authorization, inside the same business transaction. */
@Component
public class IdempotencyExecutor {
    private final JdbcTemplate jdbc;
    private final JsonCodec json;
    private final TransactionTemplate tx;
    public IdempotencyExecutor(JdbcTemplate jdbc,JsonCodec json,PlatformTransactionManager tm) {
        this.jdbc=jdbc;this.json=json;this.tx=new TransactionTemplate(tm);
    }
    public Map<String,Object> execute(RequestContext ctx,String method,String endpoint,String key,
            Map<String,Object> body,Long bookId,Supplier<Map<String,Object>> operation,
            Consumer<Map<String,Object>> authorizeResult) {
        if(!TransactionSynchronizationManager.isActualTransactionActive())
            throw new IllegalStateException("Idempotency requires the authorized business transaction");
        if(ctx.countryId()==null)throw new ApiException(400,"SYS_COUNTRY_REQUIRED","请先选择国家");
        if(key==null||!key.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))
            throw new ApiException(400,"SYS_IDEMPOTENCY_REQUIRED","请提供UUID格式的Idempotency-Key");
        String verb=method.toUpperCase(Locale.ROOT),path=normalizedEndpoint(endpoint);
        if(!Set.of("POST","PUT","PATCH","DELETE").contains(verb))throw new IllegalArgumentException("Invalid command method");
        String hash=Digests.sha256(verb+"\n"+path+"\n"+Objects.toString(bookId,"")+"\n"+json.write(canonical(body==null?Map.of():body)));
        // REQUIRED participation also makes a caught operation failure roll back the outer transaction.
        return tx.execute(status->{
            jdbc.queryForObject("SELECT set_config('lock_timeout','5s',true)",String.class);
            var inserted=jdbc.queryForList("INSERT INTO sys_idempotency(country_id,user_id,key,method,endpoint,request_hash,book_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(country_id,user_id,key) DO NOTHING RETURNING id",ctx.countryId(),ctx.userId(),key.toLowerCase(Locale.ROOT),verb,path,hash,bookId);
            if(inserted.isEmpty()) {
                var rows=jdbc.queryForList("SELECT method,endpoint,request_hash,book_id,response FROM sys_idempotency WHERE country_id=? AND user_id=? AND key=?",ctx.countryId(),ctx.userId(),key.toLowerCase(Locale.ROOT));
                if(rows.isEmpty())throw new ApiException(409,"SYS_CONCURRENT_RETRY","操作仍在处理中，请使用原请求重试");
                var row=rows.getFirst();
                if(!hash.equals(row.get("request_hash"))||!verb.equals(row.get("method"))||!path.equals(row.get("endpoint"))||!Objects.equals(bookId,row.get("book_id")))
                    throw new ApiException(409,"SYS_IDEMPOTENCY_CONFLICT","同一幂等键不能用于不同请求");
                if(row.get("response")==null)throw new ApiException(409,"SYS_CONCURRENT_RETRY","操作仍在处理中，请使用原请求重试");
                Map<String,Object> result=json.readMap(row.get("response").toString());
                authorizeResult.accept(result);
                return result;
            }
            Map<String,Object> result=Objects.requireNonNull(operation.get(),"A committed command needs its result");
            authorizeResult.accept(result);
            Map<String,Object> ref=new LinkedHashMap<>();
            for(String field:List.of("id","countryId","entityId","storeId","warehouseId","bookId","sourceType","sourceId"))
                if(result.get(field)!=null)ref.put(field,result.get(field));
            jdbc.update("UPDATE sys_idempotency SET response=?::jsonb,resource_refs=?::jsonb WHERE country_id=? AND id=?",json.write(result),json.write(ref.isEmpty()?List.of():List.of(ref)),ctx.countryId(),inserted.getFirst().get("id"));
            return result;
        });
    }
    public static Object canonical(Object value) {
        if(value instanceof Map<?,?> map) {
            Map<String,Object> sorted=new TreeMap<>();
            map.forEach((k,v)->sorted.put(String.valueOf(k),canonical(v)));
            return sorted;
        }
        if(value instanceof Collection<?> list)return list.stream().map(IdempotencyExecutor::canonical).toList();
        if(value instanceof Number number) {
            try{return new BigDecimal(number.toString()).stripTrailingZeros();}
            catch(NumberFormatException e){throw new IllegalArgumentException("Invalid decimal");}
        }
        return value;
    }
    public static String normalizedEndpoint(String endpoint) {
        URI uri=URI.create(endpoint);
        if(uri.isAbsolute()||uri.getRawAuthority()!=null||uri.getRawFragment()!=null||!uri.getRawPath().startsWith("/api/v1/"))throw new IllegalArgumentException("Invalid command endpoint");
        String query=uri.getRawQuery();
        if(query==null||query.isBlank())return uri.getRawPath();
        var parts=new ArrayList<>(Arrays.asList(query.split("&")));Collections.sort(parts);
        return uri.getRawPath()+"?"+String.join("&",parts);
    }
}
