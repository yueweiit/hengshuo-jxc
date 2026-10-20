package com.hs.jxc.sys.service;
import com.hs.jxc.sys.api.*;
import com.hs.jxc.common.api.*;
import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
@Service
public class OrganizationReferenceService implements OrganizationReferenceApi {
    private final JdbcTemplate jdbc;
    public OrganizationReferenceService(JdbcTemplate jdbc){this.jdbc=jdbc;}
    public Map<String,Object> reference(Access a,String type,long id,long entity){
        List<Map<String,Object>> rows;
        if(type.equals("employeeId"))rows=jdbc.queryForList("SELECT u.id,u.display_name name FROM sys_user u WHERE u.id=? AND EXISTS(SELECT 1 FROM sys_user_role r WHERE r.user_id=u.id AND r.country_id=?)",id,a.requireCountry());
        else if(type.equals("entityId")){
            if(id!=entity)throw ApiException.notFound();
            rows=jdbc.queryForList("SELECT id,name FROM org_entity WHERE country_id=? AND id=?",a.requireCountry(),id);
        }else{
            String table=switch(type){case "warehouseId"->"org_warehouse";case "storeId"->"org_store";default->throw ApiException.notFound();};
            rows=jdbc.queryForList("SELECT id,name FROM "+table+" WHERE country_id=? AND entity_id=? AND id=?",a.requireCountry(),entity,id);
        }
        if(rows.isEmpty())throw ApiException.notFound();return Map.of("id",id,"name",rows.getFirst().get("name"),"countryId",a.requireCountry(),"entityId",entity);
    }
}
