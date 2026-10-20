package com.hs.jxc.sys.service;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import java.util.*;

/** M1 only: trusted master-data resolvers. M2 document types stay unregistered and denied. */
@Component
public class BasicDocumentPolicies {
    public BasicDocumentPolicies(DocumentAccessService documents,JdbcTemplate jdbc) {
        register(documents,jdbc,List.of("ORG_ENTITY","ENTITY"),"org_entity","entity_id","org:entity:edit");
        register(documents,jdbc,List.of("ORG_STORE","STORE"),"org_store","store_id","org:store:edit");
        register(documents,jdbc,List.of("ORG_WAREHOUSE","WAREHOUSE"),"org_warehouse","warehouse_id","org:warehouse:edit");
        register(documents,jdbc,List.of("FIN_BOOK","BOOK"),"fin_book","book_id","fin:book:config");
    }
    private void register(DocumentAccessService service,JdbcTemplate jdbc,List<String> types,String table,String own,String permission) {
        for(String type:types)service.register(type,List.of(permission),List.of(permission),(access,id)->{
            var rows=jdbc.queryForList("SELECT *,id AS "+own+" FROM "+table+" WHERE country_id=? AND id=?",access.requireCountry(),id);
            if(rows.isEmpty())return null;
            Map<String,Object> out=new LinkedHashMap<>();rows.getFirst().forEach((key,value)->{StringBuilder b=new StringBuilder();boolean upper=false;for(char c:key.toCharArray()){if(c=='_')upper=true;else{b.append(upper?Character.toUpperCase(c):c);upper=false;}}out.put(b.toString(),value);});return out;
        },(access,id)->jdbc.queryForList("SELECT id FROM "+table+" WHERE country_id=? AND id=? FOR UPDATE",access.requireCountry(),id));
    }
}
