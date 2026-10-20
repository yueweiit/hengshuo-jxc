package com.hs.jxc.it;
import static org.assertj.core.api.Assertions.*;
import com.hs.jxc.sys.api.*;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
class TemplateStructureIT extends BasePgIT {
 @Autowired List<TemplateStructureContributor> contributors;
 @BeforeEach void fixture(){InventoryIT.seedBase();seed("INSERT INTO sys_country(id,code,name,default_currency,timezone,status) VALUES(102,'CN','Test','MXN','Asia/Shanghai','DRAFT')");seed("INSERT INTO fin_account(id,country_id,book_id,code,name,category,direction) VALUES(1101,101,601,'1001','Cash','ASSET','DEBIT'),(1102,101,601,'2001','AP','LIABILITY','CREDIT')");seed("INSERT INTO fin_cashflow_item(country_id,book_id,code,name,category,direction) VALUES(101,601,'OP','Operations','OPERATING','BOTH')");seed("INSERT INTO fin_voucher_word(country_id,book_id,code,name,number_rule) VALUES(101,601,'JV','Journal','MONTHLY')");seed("INSERT INTO org_entity(id,country_id,code,name) VALUES(311,102,'E2','Test entity')");seed("INSERT INTO fin_book(id,country_id,entity_id,code,name,base_currency,status) VALUES(611,102,311,'B2','Test book','MXN','ACTIVE')");}
 Access access(long country){return new Access(201,country,true,Set.of("*"),Map.of(),new DataScope(true,Set.of(),Set.of(),Set.of(),Set.of()),null);}
 TemplateStructureContributor owner(String key){return contributors.stream().filter(c->c.key().equals(key)).findFirst().orElseThrow(()->new AssertionError("Missing structure "+key));}
 @Test void financeStructureCopiesCodesIntoNewIdsAndPreservesLocalReviewWithoutBalances(){
  seed("INSERT INTO sys_country_template(id,country_id,version_no,change_note,source_params,created_by) VALUES(9000,101,1,'Test','{}',201)");
  seed("INSERT INTO sys_country_template_item(id,country_id,template_id,item_type,item_key,label,payload,requires_review) VALUES(9001,101,9000,'FINANCE','finance-structure','Finance','{}',true)");
  seed("INSERT INTO fin_mapping_template(id,country_id,book_id,event_type,version_no,created_by) VALUES(9100,101,601,'IMPORT_TEST',1,201)");
  seed("INSERT INTO fin_mapping_line(country_id,book_id,template_id,seq,direction,account_rule,amount_expr) VALUES(101,601,9100,1,'DEBIT','{\"type\":\"FIXED\",\"accountId\":1101}','amount'),(101,601,9100,2,'CREDIT','{\"type\":\"FIXED\",\"accountId\":1102}','amount')");
  seed("UPDATE fin_mapping_template SET status='ACTIVE',reviewed_by=201,reviewed_at=clock_timestamp() WHERE id=9100");
  seed("INSERT INTO fin_report_template(country_id,book_id,report_type,name,rule_code,version_no,status,reviewed_by,reviewed_at,created_by) VALUES(101,601,'BALANCE_SHEET','Balance','CATEGORY_V1',1,'ACTIVE',201,clock_timestamp(),201)");
  var owner=owner("finance-structure");var source=inCountry(101,()->owner.snapshot(access(101)));
  inCountry(102,()->{owner.apply(access(102),source,9001);return null;});
  assertThat(this.owner.queryForObject("SELECT count(*) FROM fin_account WHERE country_id=102",Integer.class)).isEqualTo(2);
  assertThat(this.owner.queryForObject("SELECT min(id) FROM fin_account WHERE country_id=102",Long.class)).isNotEqualTo(1101);
  assertThat(this.owner.queryForObject("SELECT count(*) FROM fin_opening_balance WHERE country_id=102",Integer.class)).isZero();
  assertThat(this.owner.queryForList("SELECT status FROM fin_mapping_template WHERE country_id=102",String.class)).containsExactly("NEED_REVIEW");
  assertThat(this.owner.queryForList("SELECT status FROM fin_report_template WHERE country_id=102",String.class)).containsExactly("NEED_REVIEW");
  assertThat(this.owner.queryForObject("SELECT account_rule::text FROM fin_mapping_line WHERE country_id=102 AND seq=1",String.class)).contains("1001").doesNotContain("1101");
  assertThat(inCountry(102,()->owner.ready(access(102),9001))).isFalse();
  seed("UPDATE fin_account SET name='Changed source' WHERE id=1101");
  assertThat(this.owner.queryForObject("SELECT name FROM fin_account WHERE country_id=102 AND code='1001'",String.class)).isEqualTo("Cash");
  assertThat(this.owner.queryForObject("SELECT count(*) FROM md_fund_account WHERE country_id=102",Integer.class)).isZero();
 }
 @Test void masterStructureCopiesCountrySkuAndDictionaryButExcludesBusinessMastersAndSecrets(){
  seed("INSERT INTO md_dict(country_id,dict_type,code,label_i18n) VALUES(101,'HOLD_REASON','CUSTOMS','{\"zh-CN\":\"海关\"}')");
  var owner=owner("master-structure");var source=inCountry(101,()->owner.snapshot(access(101)));
  inCountry(102,()->{owner.apply(access(102),source,9002);return null;});
  assertThat(this.owner.queryForObject("SELECT count(*) FROM md_country_sku WHERE country_id=102",Integer.class)).isEqualTo(1);
  assertThat(this.owner.queryForObject("SELECT count(*) FROM md_dict WHERE country_id=102",Integer.class)).isEqualTo(1);
  assertThat(this.owner.queryForObject("SELECT count(*) FROM md_customer WHERE country_id=102",Integer.class)).isZero();
  assertThat(this.owner.queryForObject("SELECT count(*) FROM md_supplier WHERE country_id=102",Integer.class)).isZero();
 }
}
