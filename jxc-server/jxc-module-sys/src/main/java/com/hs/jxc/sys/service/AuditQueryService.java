package com.hs.jxc.sys.service;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Audit facts belong to SYS; every source decision belongs to its registered business owner. */
@Service
public class AuditQueryService {
    private final JdbcTemplate jdbc;
    private final AuthorizationService auth;
    private final DocumentAccessService documents;
    private final FieldPolicyService fields;
    private final JsonCodec json;
    private final TransactionTemplate tx;
    public AuditQueryService(JdbcTemplate jdbc,AuthorizationService auth,DocumentAccessService documents,
                             FieldPolicyService fields,JsonCodec json,PlatformTransactionManager manager) {
        this.jdbc=jdbc;this.auth=auth;this.documents=documents;this.fields=fields;this.json=json;
        this.tx=new TransactionTemplate(manager);
    }
    public Map<String,Object> list(RequestContext context,Map<String,String> query) {
        return tx.execute(status->{
            var access=auth.authorize(context);long country=access.requireCountry();
            ZoneId zone=ZoneId.of(jdbc.queryForObject("SELECT timezone FROM sys_country WHERE id=?",String.class,country));
            String requested=text(query,"resourceType"),requestedType=requested==null?null:canonical(requested);
            Long resourceId=optionalId(query,"resourceId"),userId=optionalId(query,"userId");
            if(resourceId!=null&&requested==null)throw Inputs.bad("指定来源编号时必须指定来源类型");
            Map<String,Object> requestedSource=null;
            if(resourceId!=null) {
                if(!documents.supports(requestedType))throw ApiException.notFound();
                requestedSource=documents.requireDocumentAccess(access,requestedType,resourceId,false);
            } else access.require("sys:audit:view");
            int page=positive(query.get("page"),1,1000000),size=positive(query.get("size"),20,200);
            LocalDate from=date(query.get("from")),to=date(query.get("to"));
            if(from!=null&&to!=null&&to.isBefore(from))throw Inputs.bad("审计查询结束日期不能早于开始日期");
            String action=text(query,"action"),keyword=query.getOrDefault("keyword","").toLowerCase(Locale.ROOT);
            List<Map<String,Object>> visible=new ArrayList<>();
            for(var raw:jdbc.queryForList("SELECT l.*,u.display_name AS user_name FROM sys_audit_log l JOIN sys_user u ON u.id=l.user_id WHERE l.country_id=? ORDER BY l.occurred_at DESC,l.id DESC",country)) {
                var row=DbRows.camel(raw);String type=canonical(String.valueOf(row.get("resourceType")));
                if(requestedType!=null&&!requestedType.equals(type)||resourceId!=null&&!same(row.get("resourceId"),resourceId)||userId!=null&&!same(row.get("userId"),userId)||action!=null&&!action.equals(row.get("action")))continue;
                LocalDate occurred=Instant.parse(row.get("occurredAt").toString()).atZone(zone).toLocalDate();
                if(from!=null&&occurred.isBefore(from)||to!=null&&occurred.isAfter(to))continue;
                Map<String,Object> source=requestedSource;
                if(source==null) {
                    if(documents.supports(type)) {
                        if(!(row.get("resourceId") instanceof Number id))continue;
                        try { source=documents.requireDocumentAccess(access,type,id.longValue(),false); }
                        catch(ApiException denied) { if(denied.getStatus()==403||denied.getStatus()==404)continue;throw denied; }
                    } else if(!access.scope().all())continue;
                }
                // A warehouse grant on a mixed sales order does not authorize its whole historic snapshot.
                boolean partial=type.equals("SALES_ORDER")&&!wholeSource(access,source);
                row.put("beforeValue",partial?null:snapshot(access,row.get("beforeValue"),type));
                row.put("afterValue",partial?null:snapshot(access,row.get("afterValue"),type));
                if(partial)row.put("reason",null);
                if(!keyword.isEmpty()&&List.of("action","resourceType","userName","reason").stream().noneMatch(k->Objects.toString(row.get(k),"").toLowerCase(Locale.ROOT).contains(keyword)))continue;
                visible.add(row);
            }
            int start=(int)Math.min(visible.size(),(long)(page-1)*size),end=Math.min(visible.size(),start+size);
            return Map.of("records",visible.subList(start,end),"total",visible.size(),"page",page,"size",size);
        });
    }
    private Object snapshot(Access access,Object value,String type) {
        Object cleaned=clean(value);
        if(cleaned instanceof Map<?,?> map) {
            var out=stringMap(map);String group=amountGroup(type);
            if(group!=null)return fields.mask(access,out,group);
            // Unknown resources can be inspected only by COUNTRY_ALL; use the intersection of current fields.
            for(String candidate:FieldPolicyService.GROUPS)out=fields.mask(access,out,candidate);
            return out;
        }
        if(cleaned instanceof Collection<?> values)return values.stream().map(v->snapshot(access,v,type)).toList();
        return cleaned;
    }
    private Object clean(Object value) {
        if(value instanceof String text) {
            String trimmed=text.trim();
            if(trimmed.startsWith("{")||trimmed.startsWith("["))try { return clean(json.read(trimmed,Object.class)); }catch(RuntimeException ignored) { return text; }
            return text;
        }
        if(value instanceof Map<?,?> map) {
            var out=new LinkedHashMap<String,Object>();
            map.forEach((key,item)->{String name=DbRows.camelKey(String.valueOf(key));if(!credential(name))out.put(name,clean(item));});
            return out;
        }
        if(value instanceof Collection<?> values)return values.stream().map(this::clean).toList();
        return value;
    }
    private static boolean credential(String key) {
        String normalized=key.replaceAll("[^A-Za-z0-9]","").toLowerCase(Locale.ROOT);
        return normalized.contains("password")||normalized.contains("secret")||normalized.contains("encrypted")||normalized.contains("credential")||normalized.contains("token")||Set.of("authorization","cookie","sessionhash","sessiondigest","privatekey","encryptionkey","apikey","accesskey","accesskeyid").contains(normalized);
    }
    private static boolean wholeSource(Access access,Map<String,Object> source) {
        if(access.scope().all())return true;if(source==null)return false;
        return contains(access.scope().books(),source.get("bookId"))||contains(access.scope().entities(),source.get("entityId"))||contains(access.scope().stores(),source.get("storeId"));
    }
    private static boolean contains(Set<Long> ids,Object value) {return value instanceof Number n&&ids.contains(n.longValue());}
    private static String amountGroup(String type) {
        if(type.startsWith("SAL_")||type.equals("SALES_ORDER")||type.equals("SALES_RETURN")||type.equals("REFUND")||type.startsWith("AR_"))return "ORDER_TOTAL";
        if(type.equals("PRICE"))return "CUSTOMER_PRICE";
        if(type.equals("PURCHASE_ORDER")||type.equals("DOMESTIC_RECEIPT")||type.equals("EXPORT_NODE")||Set.of("SHIPMENT","HOLD","DELIVERY","LGS_RECEIPT","LGS_FEE","DISCREPANCY","TRANSSHIP","DISCREPANCY_WRITE_OFF","PURCHASE_RETURN","CLAIM").contains(type)||type.startsWith("AP_")||type.startsWith("CST_")||type.startsWith("COST_")||type.startsWith("FIN_")||type.equals("VOUCHER"))return "COST";
        return null;
    }
    private static String canonical(String type) {
        return switch(type.toLowerCase(Locale.ROOT)) {
            case "orders","purchase-order","purchase_doc","purchase_order" -> "PURCHASE_ORDER";
            case "domestic-receipts","domestic-receipt" -> "DOMESTIC_RECEIPT";
            case "export-nodes","export-node","export_doc" -> "EXPORT_NODE";
            case "shipments","shipment" -> "SHIPMENT";
            case "holds" -> "HOLD";case "deliveries" -> "DELIVERY";case "receipts","lgs-receipt" -> "LGS_RECEIPT";
            case "fees" -> "LGS_FEE";case "discrepancies" -> "DISCREPANCY";case "transships" -> "TRANSSHIP";
            case "sales-order","sal-order","sal_order","sales_order" -> "SALES_ORDER";
            case "sales-outbound","outbound","sales_outbound" -> "SAL_OUTBOUND";
            case "transfer","inv_transfer" -> "TRANSFER";case "stocktake","inv_stocktake" -> "STOCKTAKE";
            default -> type.toUpperCase(Locale.ROOT).replace('-','_');
        };
    }
    private static Map<String,Object> stringMap(Map<?,?> map) {var out=new LinkedHashMap<String,Object>();map.forEach((k,v)->out.put(String.valueOf(k),v));return out;}
    private static String text(Map<String,String> query,String key) {String value=query.get(key);return value==null||value.isBlank()?null:value.trim();}
    private static Long optionalId(Map<String,String> query,String key) {String value=text(query,key);if(value==null)return null;try{return Inputs.id(Long.parseLong(value));}catch(RuntimeException e){throw Inputs.bad("审计查询编号不合法");}}
    private static int positive(String value,int fallback,int max) {if(value==null)return fallback;try{int number=Integer.parseInt(value);if(number>0&&number<=max)return number;}catch(NumberFormatException ignored){}throw Inputs.bad("分页参数不合法");}
    private static LocalDate date(String value) {if(value==null||value.isBlank())return null;try{return LocalDate.parse(value);}catch(RuntimeException e){throw Inputs.bad("审计日期不合法");}}
    private static boolean same(Object value,long id) {return value instanceof Number n&&n.longValue()==id;}
}
