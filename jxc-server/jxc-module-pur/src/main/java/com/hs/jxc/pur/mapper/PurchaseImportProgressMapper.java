package com.hs.jxc.pur.mapper;
import java.util.*;
import org.apache.ibatis.annotations.Param;
public interface PurchaseImportProgressMapper {
    int start(@Param("country")long country,@Param("task")UUID task,@Param("lease")UUID lease,@Param("attempt")int attempt);
    List<Map<String,Object>> active(@Param("country")long country,@Param("task")UUID task,@Param("lease")UUID lease);
    int publish(@Param("country")long country,@Param("task")UUID task,@Param("lease")UUID lease,@Param("order")int order,@Param("snapshot")String snapshot);
    int clear(@Param("country")long country,@Param("task")UUID task);
}
