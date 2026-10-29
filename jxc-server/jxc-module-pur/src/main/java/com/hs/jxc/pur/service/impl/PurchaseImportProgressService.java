package com.hs.jxc.pur.service.impl;

import com.hs.jxc.common.api.*;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.pur.mapper.PurchaseImportProgressMapper;
import java.util.*;
import java.math.BigDecimal;
import org.springframework.stereotype.Service;
import org.springframework.transaction.*;
import org.springframework.transaction.support.TransactionTemplate;

/** 附属元数据短事务，不锁原任务/批次行，也不决定业务是否成功。 */
@Service
public class PurchaseImportProgressService {
    static final List<String> PHASES=List.of("READING","CONVERTING","PARSING","EXTRACTING_IMAGES","VALIDATING","PREPARING_IMAGES","SAVING","LINKING");
    private final PurchaseImportServiceImpl imports;private final PurchaseImportProgressMapper mapper;private final TransactionTemplate independent;
    public PurchaseImportProgressService(PurchaseImportServiceImpl imports,PurchaseImportProgressMapper mapper,PlatformTransactionManager manager){this.imports=imports;this.mapper=mapper;independent=new TransactionTemplate(manager);independent.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);independent.setTimeout(10);}
    void start(long country,UUID task,UUID lease,int attempt){mapper.start(country,task,lease,attempt);}
    void clear(long country,UUID task){mapper.clear(country,task);}
    static Map<String,Object> event(String phase,int processed,Integer total,int images,Integer totalImages,String sheet,Integer row){var data=new LinkedHashMap<String,Object>();data.put("phase",phase);data.put("processedRows",processed);data.put("totalRows",total);data.put("processedImages",images);data.put("totalImages",totalImages);data.put("sourceSheet",sheet);data.put("sourceRow",row);return data;}
    void publish(RequestContext actor,UUID task,UUID lease,Map<String,Object> input){
        String phase=Inputs.required(input,"phase");int order=PHASES.indexOf(phase);if(order<0)throw Inputs.bad("进度步骤无效");
        if(!Set.of("phase","processedRows","totalRows","processedImages","totalImages","sourceSheet","sourceRow","sourceTotalRows").containsAll(input.keySet()))throw Inputs.bad("进度字段包含不可写内容");
        int rows=count(input.get("processedRows")),images=count(input.getOrDefault("processedImages",0));Integer total=optionalCount(input.get("totalRows")),totalImages=optionalCount(input.get("totalImages"));
        if(total!=null&&rows>total||totalImages!=null&&images>totalImages)throw Inputs.bad("已处理数量不能超过总数");
        Object sheet=input.get("sourceSheet");if(sheet!=null&&(!(sheet instanceof String)||sheet.toString().length()>31))throw Inputs.bad("进度来源工作表无效");Integer sourceRow=optionalCount(input.get("sourceRow"));if(sourceRow!=null&&sourceRow==0)throw Inputs.bad("源行号须大于0");
        var normalized=event(phase,rows,total,images,totalImages,(String)sheet,sourceRow);normalized.put("sourceTotalRows",optionalCount(input.get("sourceTotalRows")));String snapshot=imports.json.write(normalized);
        independent.execute(s->{var a=imports.access(actor,false);var active=mapper.active(a.requireCountry(),task,lease);if(active.size()!=1)throw new ApiException(409,"PROGRESS_STALE","任务尝试已变化，旧进度未写入");imports.batch(a,(UUID)active.getFirst().get("batch_id"),false);
            if(mapper.publish(a.requireCountry(),task,lease,order,snapshot)!=1)throw new ApiException(409,"PROGRESS_STALE","进度已变化，旧步骤或计数未写入");return null;});
    }
    private static Integer optionalCount(Object value){return value==null?null:count(value);}
    private static int count(Object value){if(!(value instanceof Number))throw Inputs.bad("进度数量须为非负整数");try{int number=new BigDecimal(value.toString()).intValueExact();if(number<0)throw new ArithmeticException();return number;}catch(ArithmeticException error){throw Inputs.bad("进度数量须为非负整数");}}
}
