package com.hs.jxc.org;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.api.*;
import com.hs.jxc.common.audit.AuditWriter;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.common.idempotency.IdempotencyExecutor;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.service.*;
import java.sql.Date;
import java.time.ZoneId;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import static com.hs.jxc.common.api.Inputs.*;

/** One implementation for the existing three organization CRUD contracts. */
@Service
public class OrgService {
    private record Model(String table,String own,String perm,List<String> fields){}
    private static final Map<String,Model> MODELS=Map.of(
        "entities",new Model("org_entity","entityId","org:entity:edit",List.of("code","name","legalName","taxId")),
        "stores",new Model("org_store","storeId","org:store:edit",List.of("entityId","code","name","timezone","address","openedAt","defaultWarehouseId")),
        "warehouses",new Model("org_warehouse","warehouseId","org:warehouse:edit",List.of("entityId","storeId","code","name","type","timezone","address")));
    private final JdbcTemplate jdbc;private final AuthorizationService auth;private final FieldPolicyService fields;
    private final org.springframework.beans.factory.ObjectProvider<com.hs.jxc.sys.api.StoreFundAccountPort> fundAccounts;private final SystemManagementService system;private final IdempotencyExecutor idem;private final AuditWriter audit;private final TransactionTemplate tx;
    public OrgService(JdbcTemplate jdbc,AuthorizationService auth,FieldPolicyService fields,SystemManagementService system,IdempotencyExecutor idem,AuditWriter audit,PlatformTransactionManager tm,org.springframework.beans.factory.ObjectProvider<com.hs.jxc.sys.api.StoreFundAccountPort> fundAccounts){this.fundAccounts=fundAccounts;this.jdbc=jdbc;this.auth=auth;this.fields=fields;this.system=system;this.idem=idem;this.audit=audit;this.tx=new TransactionTemplate(tm);}
    private Model model(String kind){var m=MODELS.get(kind);if(m==null)throw ApiException.notFound();return m;}
    public Map<String,Object> list(RequestContext c,String kind,Map<String,String> q){var m=model(kind);return tx.execute(s->{
        Access a=auth.authorize(c);long country=a.requireCountry();List<Object> args=new ArrayList<>();args.add(country);
        String where="o.country_id=? AND "+scope(a,m,args);
        for(String key:List.of("status","type","entityId","storeId"))if(q.containsKey(key)&&!q.get(key).isBlank()&&(key.equals("status")||m.fields().contains(key))){where+=" AND o."+column(key)+"=?";args.add(key.endsWith("Id")?parseId(q.get(key)):q.get(key));}
        if(q.containsKey("keyword")&&!q.get("keyword").isBlank()){where+=" AND (o.code ILIKE ? OR o.name ILIKE ?)";String term="%"+q.get("keyword")+"%";args.add(term);args.add(term);}
        int page=positive(q.get("page"),1,1000000),size=positive(q.get("size"),20,200);
        int total=jdbc.queryForObject("SELECT count(*) FROM "+m.table()+" o WHERE "+where,Integer.class,args.toArray());
        args.add(size);args.add((page-1)*size);
        var records=jdbc.queryForList(select(m)+" WHERE "+where+" ORDER BY o.id DESC LIMIT ? OFFSET ?",args.toArray()).stream().map(DbRows::camel).map(r->fields.mask(a,r,"ORDER_TOTAL")).toList();
        return Map.of("records",records,"total",total,"page",page,"size",size);
    });}
    public Map<String,Object> get(RequestContext c,String kind,long id){var m=model(kind);return tx.execute(s->{var a=auth.authorize(c);return fields.mask(a,find(a,m,id,false),"ORDER_TOTAL");});}
    public Map<String,Object> create(RequestContext c,String kind,Map<String,Object> b,String key){var m=model(kind);return tx.execute(s->{
        boolean grants=kind.equals("stores")&&b.get("userIds") instanceof Collection<?> users&&!users.isEmpty();
        var a=grants?auth.authorizePolicyWrite(c,false):auth.authorize(c);a.requireCountry();a.require(m.perm());fields.requireWrite(a,b,"ORDER_TOTAL");ownership(c,b,null);
        java.util.function.Supplier<Map<String,Object>> work=()->{
            if(kind.equals("entities")&&!a.scope().all())throw ApiException.forbidden();
            validateParents(a,m,b,null);
            Map<String,Object> values=new LinkedHashMap<>();for(String field:m.fields())if(b.containsKey(field))values.put(field,b.get(field));
            values.put("code",required(b,"code"));values.put("name",required(b,"name"));
            if(kind.equals("stores"))values.put("defaultWarehouseId",null);
            long id=insert(c,m,values);Map<String,Object> created=find(a,m,id,false);
            if(kind.equals("stores")){
                if(!Boolean.FALSE.equals(b.get("createWarehouse"))){
                    Map<String,Object> wh=new LinkedHashMap<>();wh.put("entityId",b.get("entityId"));wh.put("storeId",id);wh.put("code",text(b,"warehouseCode",values.get("code")+"-WH"));wh.put("name",text(b,"warehouseName",values.get("name")+"门店仓"));wh.put("type","STORE");wh.put("address",text(b,"address",""));
                    long warehouse=insert(c,MODELS.get("warehouses"),wh);jdbc.update("UPDATE org_store SET default_warehouse_id=? WHERE country_id=? AND id=?",warehouse,a.requireCountry(),id);
                }else if(b.get("defaultWarehouseId")!=null){long wh=id(b.get("defaultWarehouseId"));var row=jdbc.queryForList("SELECT * FROM org_warehouse WHERE country_id=? AND id=? AND entity_id=?",a.requireCountry(),wh,id(b.get("entityId")));if(row.isEmpty())throw bad("默认仓库不属于该经营主体");var trusted=DbRows.camel(row.getFirst());trusted.put("warehouseId",wh);a.requireRow(trusted);jdbc.update("UPDATE org_store SET default_warehouse_id=? WHERE id=?",wh,id);}
                if(b.get("fundAccount") instanceof Map<?,?> fund&&fund.get("name")!=null&&!fund.get("name").toString().isBlank()){
                    Map<String,Object> configuration=new LinkedHashMap<>();fund.forEach((k,v)->configuration.put(String.valueOf(k),v));
                    var extension=fundAccounts.getIfAvailable();if(extension==null)throw new ApiException(409,"SYS_CONFIG_MISSING","资金账户模块尚未配置");
                    extension.createForStore(c,id(b.get("entityId")),id,configuration);
                }
                if(grants){List<Long> users=new ArrayList<>();for(Object user:(Collection<?>)b.get("userIds"))users.add(id(user));system.grantNewStoreUsers(c,id,users);}
                created=find(a,m,id,false);
            }
            audit.append(c,"新增",kind,id,null,created);return created;
        };
        Map<String,Object> result=key==null?work.get():idem.execute(c,"POST","/api/v1/org/"+kind,key,b,null,work,r->{
            a.requireRow(withOwn(m,r));find(a,m,id(r.get("id")),false);
        });
        return fields.mask(a,result,"ORDER_TOTAL");
    });}
    public Map<String,Object> update(RequestContext c,String kind,long id,Map<String,Object> b){var m=model(kind);return tx.execute(s->{
        // Parent changes alter the effective STORE/ENTITY scope graph. Serialize with authority readers from entry.
        var a=auth.authorizePolicyWrite(c,false);a.require(m.perm());var before=find(a,m,id,true);long version=version(b);ownership(c,b,before);fields.requireWrite(a,b,"ORDER_TOTAL");
        var merged=new LinkedHashMap<>(before);merged.putAll(b);validateParents(a,m,merged,before);
        List<Object> args=new ArrayList<>();List<String> sets=new ArrayList<>();for(String field:m.fields())if(b.containsKey(field)){sets.add(column(field)+"=?");args.add(dbValue(field,b.get(field)));}
        sets.add("updated_by=?");args.add(c.userId());sets.add("updated_at=clock_timestamp()");sets.add("version=version+1");args.add(a.requireCountry());args.add(id);args.add(version);
        if(jdbc.update("UPDATE "+m.table()+" SET "+String.join(",",sets)+" WHERE country_id=? AND id=? AND version=?",args.toArray())!=1)throw conflict();
        var after=find(a,m,id,false);auth.bump(a.requireCountry());audit.append(c,"修改",kind,id,before,after);return fields.mask(a,after,"ORDER_TOTAL");
    });}
    public Map<String,Object> toggle(RequestContext c,String kind,long id,boolean enabled){var m=model(kind);return tx.execute(s->{var a=auth.authorize(c);a.require(m.perm());var before=find(a,m,id,true);jdbc.update("UPDATE "+m.table()+" SET status=?,version=version+1,updated_by=?,updated_at=clock_timestamp() WHERE country_id=? AND id=?",enabled?"ENABLED":"DISABLED",c.userId(),a.requireCountry(),id);var after=find(a,m,id,false);audit.append(c,enabled?"启用":"停用",kind,id,before,after);return fields.mask(a,after,"ORDER_TOTAL");});}
    private long insert(RequestContext c,Model m,Map<String,Object> values){List<String> columns=new ArrayList<>(List.of("country_id","created_by"));List<Object> args=new ArrayList<>(List.of(c.countryId(),c.userId()));for(var entry:values.entrySet()){columns.add(column(entry.getKey()));args.add(dbValue(entry.getKey(),entry.getValue()));}return jdbc.queryForObject("INSERT INTO "+m.table()+"("+String.join(",",columns)+") VALUES("+String.join(",",Collections.nCopies(args.size(),"?"))+") RETURNING id",Long.class,args.toArray());}
    private Map<String,Object> find(Access a,Model m,long id,boolean lock){
        var rows=jdbc.queryForList(select(m)+" WHERE o.country_id=? AND o.id=?"+(lock?" FOR UPDATE OF o":""),a.requireCountry(),id);if(rows.isEmpty())throw ApiException.notFound();var row=DbRows.camel(rows.getFirst());a.requireRow(withOwn(m,row));return row;
    }
    private void validateParents(Access a,Model m,Map<String,Object> b,Map<String,Object> before){
        for(String key:List.of("timezone"))if(b.get(key)!=null&&!b.get(key).toString().isBlank())ZoneId.of(text(b,key,""));
        if(m.own().equals("entityId"))return;
        long entity=id(b.get("entityId"));if(jdbc.queryForObject("SELECT count(*) FROM org_entity WHERE country_id=? AND id=? AND status='ENABLED'",Integer.class,a.requireCountry(),entity)!=1)throw bad("请选择本国有效经营主体");
        boolean same=before!=null&&Objects.equals(before.get("entityId"),entity);
        if(!same&&!a.scope().all()&&!a.scope().entities().contains(entity)){
            Long store=b.get("storeId")==null?null:id(b.get("storeId"));if(store==null||!a.scope().stores().contains(store))throw ApiException.forbidden();
        }
        if(b.get("storeId")!=null){long store=id(b.get("storeId"));
            boolean changed=before==null||!Objects.equals(before.get("storeId"),store);
            if(changed&&!a.scope().all()&&!a.scope().entities().contains(entity)&&!a.scope().stores().contains(store))throw ApiException.notFound();
            if(jdbc.queryForObject("SELECT count(*) FROM org_store WHERE country_id=? AND id=? AND entity_id=?",Integer.class,a.requireCountry(),store,entity)!=1)throw bad("门店与经营主体不一致");}
        if(b.get("defaultWarehouseId")!=null){long wh=id(b.get("defaultWarehouseId"));var rows=jdbc.queryForList("SELECT *,id AS warehouse_id FROM org_warehouse WHERE country_id=? AND id=? AND entity_id=?",a.requireCountry(),wh,entity);if(rows.isEmpty())throw bad("默认仓库与经营主体不一致");a.requireRow(DbRows.camel(rows.getFirst()));}
    }
    private static Map<String,Object> withOwn(Model m,Map<String,Object> row){var out=new LinkedHashMap<>(row);out.put(m.own(),row.get("id"));return out;}
    private static String select(Model m){return "SELECT o.*"+(m.table().equals("org_entity")?"":" ,e.name AS entity_name")+(m.table().equals("org_store")?",w.name AS default_warehouse_name":m.table().equals("org_warehouse")?",st.name AS store_name":"")+" FROM "+m.table()+" o"+(m.table().equals("org_entity")?"":" LEFT JOIN org_entity e ON e.country_id=o.country_id AND e.id=o.entity_id")+(m.table().equals("org_store")?" LEFT JOIN org_warehouse w ON w.country_id=o.country_id AND w.id=o.default_warehouse_id":m.table().equals("org_warehouse")?" LEFT JOIN org_store st ON st.country_id=o.country_id AND st.id=o.store_id":"");}
    private static String scope(Access a,Model m,List<Object> args){if(a.scope().all())return "TRUE";Set<Long> ids=switch(m.own()){case "entityId"->a.scope().entities();case "storeId"->a.scope().stores();default->a.scope().warehouses();};if(ids.isEmpty())return "FALSE";args.addAll(ids);return "o.id IN ("+String.join(",",Collections.nCopies(ids.size(),"?"))+")";}
    private static Object dbValue(String key,Object value){if(value==null)return null;if(key.endsWith("Id"))return id(value);if(key.equals("openedAt"))return value.toString().isBlank()?null:Date.valueOf(value.toString());if(!(value instanceof String))throw bad(key+"必须是文本");return value;}
    private static String column(String key){return key.replaceAll("([a-z])([A-Z])","$1_$2").toLowerCase(Locale.ROOT);}
    private static void ownership(RequestContext c,Map<String,Object> b,Map<String,Object> old){if(b.get("countryId")!=null&&id(b.get("countryId"))!=c.countryId())throw bad("不能修改国家归属");if(old!=null&&b.get("id")!=null&&id(b.get("id"))!=id(old.get("id")))throw bad("不能修改ID");if(b.get("status")!=null&&(old==null||!Objects.equals(b.get("status"),old.get("status"))))throw bad("请通过启用或停用操作修改状态");}
    private static int positive(String s,int fallback,int max){if(s==null)return fallback;try{int n=Integer.parseInt(s);if(n<1||n>max)throw bad("分页参数不合法");return n;}catch(NumberFormatException e){throw bad("分页参数不合法");}}
    private static long parseId(String value){try{return id(new java.math.BigDecimal(value));}catch(NumberFormatException e){throw bad("ID不合法");}}
}
