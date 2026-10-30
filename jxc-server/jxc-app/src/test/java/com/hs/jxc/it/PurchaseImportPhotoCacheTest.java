package com.hs.jxc.it;

import com.hs.jxc.pur.service.impl.PurchaseImportPhotoCache;
import com.hs.jxc.md.api.ProductImageApi;
import com.hs.jxc.common.api.ApiException;
import com.hs.jxc.common.context.RequestContext;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;

class PurchaseImportPhotoCacheTest {
    final ProductImageApi images=mock(ProductImageApi.class);
    final RequestContext actor=new RequestContext(201,101L,"cache-test","fixture");
    Map<String,Object> evidence(){return Map.of("image",Map.of("generation","fixed-generation"),"photoBindings",List.of(Map.of("queryAssetId",11,"featureId",21,"imageId",31,"productId",501,"score",1.0)));}
    @Test void newProductLinkedToTheSameIndexedPhotoInvalidatesTheOldCandidateSet(){
        when(images.resolveHits(eq(actor),eq("fixed-generation"),anyList())).thenReturn(List.of(Map.of("featureId",21,"imageId",31,"productId",501),Map.of("featureId",21,"imageId",32,"productId",502)));
        assertThat(PurchaseImportPhotoCache.matches(images,actor,evidence())).isFalse();
    }
    @Test void unchangedPhotoBindingsCanBeReusedAcrossJsonNumericTypes(){
        when(images.resolveHits(eq(actor),eq("fixed-generation"),eq(List.of(Map.of("featureId",21L,"score",1.0))))).thenReturn(List.of(Map.of("featureId",21L,"imageId",31L,"productId",501L)));
        assertThat(PurchaseImportPhotoCache.matches(images,actor,evidence())).isTrue();
    }
    @Test void permissionFailureIsReportedInsteadOfBecomingAnEmptyCacheMiss(){
        when(images.resolveHits(eq(actor),eq("fixed-generation"),anyList())).thenThrow(ApiException.forbidden());
        assertThatThrownBy(()->PurchaseImportPhotoCache.matches(images,actor,evidence())).isInstanceOf(ApiException.class).extracting("status").isEqualTo(403);
    }
}
