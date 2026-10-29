package com.hs.jxc.pur.service.impl;

import com.hs.jxc.common.api.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class PurchaseImportReviewBatchTest {
    final JsonCodec json=new JsonCodec();
    Map<String,Object> row(int id,String spec){return new LinkedHashMap<>(Map.of("runId","run-"+id,"rowId",id,"inputRevision",1,"evidenceHash","evidence-"+id,"sourceInput",Map.of("productSpec",spec),"candidates",List.of(Map.of("productId",501)),"pairs",List.of(Map.of("productId",501,"sourceKey","same","candidateKey","same")),"errors",List.of(),"images",List.of(Map.of("key","same","sha256","a".repeat(64),"dataUrl","data:image/png;base64,YQ=="))));}
    List<Map<String,Object>> pack(List<Map<String,Object>> input,JsonCodec json,int maximum){
        var result=new ArrayList<Map<String,Object>>();var packer=new PurchaseImportReviewBatch.Packer(json,maximum);
        for(var row:input){if(!packer.add(row)){result.add(packer.request());packer=new PurchaseImportReviewBatch.Packer(json,maximum);packer.add(row);}}
        if(!packer.empty())result.add(packer.request());return result;
    }
    List<Map<String,Object>> rows(int n){return IntStream.rangeClosed(1,n).mapToObj(i->row(i,"规格"+i)).toList();}
    @Test void partitionsTwentyTwentyOneAndSixtyWithoutLosingRows(){
        for(var entry:Map.of(20,List.of(20),21,List.of(20,1),60,List.of(20,20,20)).entrySet()){
            var batches=pack(rows(entry.getKey()),json,40*1024*1024);
            assertThat(batches.stream().map(b->((List<?>)b.get("rows")).size())).containsExactlyElementsOf(entry.getValue());
        }
    }
    @Test void sharesOnlyIdenticalPicturesAndKeepsDifferentSpecifications(){
        var batch=pack(List.of(row(1,"S"),row(2,"M")),json,4096).getFirst();
        assertThat((List<?>)batch.get("images")).hasSize(1);
        assertThat(json.write(batch.get("rows"))).contains("\"productSpec\":\"S\"","\"productSpec\":\"M\"").doesNotContain("dataUrl");
    }
    @Test void splitsByActualUtf8BodySizeAndRejectsAnOversizedSingleRow(){
        int one=json.write(pack(List.of(row(1,"中文")),json,4096).getFirst()).getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        var batches=pack(List.of(row(1,"中文"),row(2,"中文")),json,one+8);
        assertThat(batches).hasSize(2);
        assertThat(batches).allSatisfy(b->assertThat(json.write(b).getBytes(java.nio.charset.StandardCharsets.UTF_8).length).isLessThanOrEqualTo(one+8));
        assertThatThrownBy(()->pack(List.of(row(1,"中文")),json,one-1)).isInstanceOf(ApiException.class).extracting("code").isEqualTo("IMAGE_REVIEW_LIMIT");
    }
    Map<String,Object> reply(int id){return Map.of("runId","run-"+id,"rowId",id,"inputRevision",1,"evidenceHash","evidence-"+id,"explanation",Map.of("status","READY","message","核对完成","candidateIds",List.of()));}
    @Test void mapsOutOfOrderRepliesAndIsolatesMissingDuplicateOrChangedIdentities(){
        var request=pack(rows(3),json,4096).getFirst();
        var result=PurchaseImportReviewBatch.responses(request,Map.of("format","MatchReviewBatchResultV1","items",List.of(reply(3),reply(1))));
        assertThat(result.get(0).get("rowId")).isEqualTo(1);
        assertThat(json.write(result.get(1))).contains("FAILED","缺少");
        assertThat(result.get(2).get("rowId")).isEqualTo(3);
        var changed=new LinkedHashMap<>(reply(2));changed.put("evidenceHash","old");
        result=PurchaseImportReviewBatch.responses(request,Map.of("format","MatchReviewBatchResultV1","items",List.of(reply(1),reply(1),changed,reply(3))));
        assertThat(json.write(result.get(0))).contains("FAILED","重复");
        assertThat(json.write(result.get(1))).contains("FAILED","依据");
        assertThat(json.write(result.get(2))).contains("READY");
        assertThatThrownBy(()->PurchaseImportReviewBatch.responses(request,Map.of("format","MatchReviewBatchResultV1","items",List.of(reply(99))))).isInstanceOf(ApiException.class);
    }
    @Test void permitsOnlyThreeActiveBatchesAndContinuesQueuedWork()throws Exception{
        try(var executor=new PurchaseImportBatchExecutor()){
            var active=new AtomicInteger();var highest=new AtomicInteger();var done=new AtomicInteger();
            var entered=new CountDownLatch(3);var release=new CountDownLatch(1);
            try(var caller=Executors.newSingleThreadExecutor()){
                var work=caller.submit(()->executor.run(IntStream.range(0,7).mapToObj(i->(Runnable)()->{int n=active.incrementAndGet();highest.accumulateAndGet(n,Math::max);entered.countDown();try{if(!release.await(5,TimeUnit.SECONDS))throw new AssertionError("未释放批次");done.incrementAndGet();}catch(InterruptedException e){Thread.currentThread().interrupt();throw new IllegalStateException(e);}finally{active.decrementAndGet();}}).toList()));
                try{assertThat(entered.await(5,TimeUnit.SECONDS)).isTrue();assertThat(active.get()).isEqualTo(3);assertThat(done.get()).isZero();}finally{release.countDown();}
                work.get(10,TimeUnit.SECONDS);assertThat(done.get()).isEqualTo(7);assertThat(highest.get()).isEqualTo(3);
            }
        }
    }
}
