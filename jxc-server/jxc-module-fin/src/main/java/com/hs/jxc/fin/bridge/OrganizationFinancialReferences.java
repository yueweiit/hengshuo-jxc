package com.hs.jxc.fin.bridge;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.fin.api.FinancialReferenceProvider;
import com.hs.jxc.fin.service.BookResolver;
import com.hs.jxc.sys.api.*;
import java.util.*;
import org.springframework.stereotype.Component;
@Component
public class OrganizationFinancialReferences implements FinancialReferenceProvider {
    private final OrganizationReferenceApi references;private final BookResolver books;
    public OrganizationFinancialReferences(OrganizationReferenceApi references,BookResolver books){this.references=references;this.books=books;}
    public boolean supports(String type){return Set.of("warehouseId","storeId","employeeId").contains(type);}
    public Map<String,Object> validate(Access a,long book,String type,long id){
        long entity=books.entityId(a,book);
        try{return references.reference(a,type,id,entity);}catch(ApiException e){if(e.getStatus()!=404)throw e;throw new ApiException(400,"FIN_AUX_INVALID","辅助项不存在或不属于该账套");}
    }
}
