package com.hs.jxc.pur.service.impl;
import com.hs.jxc.pur.service.*;

import com.hs.jxc.pur.mapper.*;
import com.hs.jxc.common.db.DbRows;
import com.hs.jxc.sys.api.Access;
import com.hs.jxc.sys.jobs.WorkItemProvider;
import java.util.*;

import org.springframework.stereotype.Component;
@Component
public class PurchaseWorkItems implements WorkItemProvider {
 private final PurchaseWorkItemMapper mapper;public PurchaseWorkItems(PurchaseWorkItemMapper mapper){this.mapper=mapper;}
 public List<Map<String,Object>> items(Access a){if(!a.has("pur:receipt:create"))return List.of();var out=new ArrayList<Map<String,Object>>();for(var raw:mapper.selectPendingReceipts(a.requireCountry())){var r=DbRows.camel(raw);if(a.canRow(r))out.add(Map.of("id",r.get("id"),"todoType","PUR_RECEIPT","typeLabel","采购待收货","title","采购待收货 "+r.get("docNo"),"link","/purchase/orders/"+r.get("id"),"createdAt",r.get("createdAt").toString()));}return out;}
}
