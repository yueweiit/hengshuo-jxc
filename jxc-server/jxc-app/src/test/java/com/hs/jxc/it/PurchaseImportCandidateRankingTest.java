package com.hs.jxc.it;

import com.hs.jxc.pur.service.impl.PurchaseImportCandidateRanking;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;

class PurchaseImportCandidateRankingTest {
    Map<String,Object> candidate(long id, Double photo, String code, String spec, String name) {
        var c=new LinkedHashMap<String,Object>();
        c.put("productId",id);c.put("visualScore",photo);
        c.put("product",Map.of("productCode",code,"spec",spec,"name",name));
        return c;
    }
    Map<String,Object> rank(Map<String,Object> source, Map<String,Object>... candidates) {
        return PurchaseImportCandidateRanking.rank(source,List.of(candidates));
    }
    @SuppressWarnings("unchecked") Map<String,Object> score(Map<String,Object> ranking,long id) {
        return ((List<Map<String,Object>>)ranking.get("scores")).stream().filter(c->((Number)c.get("productId")).longValue()==id).findFirst().orElseThrow();
    }
    @Test void samePhotoGroupUsesTextToChooseTheActualSizeAndKeepsAllEvidence() {
        var s=candidate(1L,1.0,"SKU-S","S","衣服");
        var m=candidate(2L,1.0,"SKU-M","M","衣服");
        var result=rank(Map.of("productSpec","S"),s,m);
        assertThat(result.get("recommendedIds")).isEqualTo(List.of(1L));
        assertThat(result.get("highestPhotoIds")).isEqualTo(List.of(1L,2L));
        assertThat(score(result,2L)).containsEntry("textScore",0.0);
        assertThat(m).doesNotContainKey("textScore");
    }
    @Test void lowerPhotoCannotWinWithBetterTextAndHighestGroupFailureDoesNotFallBack() {
        var result=rank(Map.of("productSpec","S"),candidate(1L,1.0,"A","M","衣服"),candidate(2L,0.95,"B","S","衣服"));
        assertThat(result.get("recommendedIds")).isEqualTo(List.of());
        assertThat(result.get("status")).isEqualTo("NEEDS_REVIEW");
        assertThat(result.get("highestPhotoIds")).isEqualTo(List.of(1L));
        assertThat(score(result,2L).get("reason")).asString().contains("最高");
    }
    @Test void photoThresholdIncludesEightyButRejectsJustBelowIt() {
        var input=Map.<String,Object>of("productSpec","S");
        assertThat(rank(input,candidate(1L,0.8,"A","S","衣服")).get("recommendedIds")).isEqualTo(List.of(1L));
        assertThat(rank(input,candidate(1L,0.79999,"A","S","衣服")).get("recommendedIds")).isEqualTo(List.of());
    }
    @Test void rawPhotoScoresAreComparedBeforeDisplayRounding() {
        var result=rank(Map.of("productSpec","S"),candidate(1L,0.90001,"A","S","衣服"),candidate(2L,0.90002,"B","M","衣服"));
        assertThat(result.get("highestPhotoIds")).isEqualTo(List.of(2L));
        assertThat(result.get("recommendedIds")).isEqualTo(List.of());
    }
    @Test void codeFortySpecFortyNameTwentyAllowsPartialCodeAtTheTextBoundary() {
        var source=Map.<String,Object>of("suppliedProductCode","ABCD","productSpec","S","suppliedProductName","coat");
        var result=rank(source,candidate(1L,1.0,"ABXY","S","coat"));
        assertThat(score(result,1L)).containsEntry("textScore",0.8);
        assertThat(result.get("recommendedIds")).isEqualTo(List.of(1L));
        assertThat(rank(source,candidate(2L,1.0,"AXYZ","S","coat")).get("recommendedIds")).isEqualTo(List.of());
    }
    @Test void missingFieldsAreExcludedAndRemainingWeightsAreRenormalized() {
        var result=rank(Map.of("productSpec","S","suppliedProductName","coat"),candidate(1L,1.0,"ANY","S","boat"));
        assertThat(((Number)score(result,1L).get("textScore")).doubleValue()).isCloseTo(11.0/12.0,within(1e-12));
        assertThat(result.get("recommendedIds")).isEqualTo(List.of(1L));
    }
    @Test void noComparableTextAndUnmappedSupplierCodesRemainUnknown() {
        var result=rank(Map.of("supplierProductCode","SKU"),candidate(1L,1.0,"SKU","S","衣服"));
        assertThat(score(result,1L)).containsEntry("textScore",null);
        assertThat(result.get("recommendedIds")).isEqualTo(List.of());
        assertThat(result.get("reason")).asString().contains("文字");
    }
    @Test void bothHighestTextScoresTiedRequireHumanChoice() {
        var result=rank(Map.of("productSpec","S"),candidate(1L,1.0,"A","S","衣服"),candidate(2L,1.0,"B","S","衣服"));
        assertThat(result.get("recommendedIds")).isEqualTo(List.of());
        assertThat(result.get("reason")).asString().contains("并列");
    }
    @Test void incompleteHighestPhotoGroupCannotPretendTheBestReturnedTextIsTheOverallWinner() {
        var result=PurchaseImportCandidateRanking.rank(Map.of("productSpec","S"),List.of(candidate(1L,1.0,"A","S","衣服")),false);
        assertThat(result.get("recommendedIds")).isEqualTo(List.of());
        assertThat(result.get("reason")).asString().contains("完整");
        assertThat(result.get("scores")).asList().hasSize(1);
    }
    @Test void normalizedUnicodeTextCanMatchButTextOnlyCandidatesCannotBecomePhotoRecommendations() {
        var source=Map.<String,Object>of("suppliedProductCode"," ＡＢＣ ","productSpec"," s ","suppliedProductName","COAT");
        assertThat(rank(source,candidate(1L,1.0,"abc","S","coat")).get("recommendedIds")).isEqualTo(List.of(1L));
        assertThat(rank(source,candidate(1L,null,"abc","S","coat")).get("recommendedIds")).isEqualTo(List.of());
    }
}
