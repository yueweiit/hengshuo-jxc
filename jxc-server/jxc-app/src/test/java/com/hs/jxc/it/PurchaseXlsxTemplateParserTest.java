package com.hs.jxc.it;

import com.hs.jxc.pur.service.impl.PurchaseXlsxTemplateParser;
import com.hs.jxc.common.api.ApiException;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import java.nio.file.*;
import java.util.*;

class PurchaseXlsxTemplateParserTest {
    @Test void nativeTemplateReportsActualRowsAndImagesWithoutExternalServices()throws Exception {
        var events=new ArrayList<Map<String,Object>>();
        byte[] bytes=Files.readAllBytes(Path.of(System.getProperty("jxc.test.purchase-source","D:/downlaoad/NY-051-采购导入.xlsx")));
        new PurchaseXlsxTemplateParser().parse(bytes,"source.xlsx",null,events::add).orElseThrow();
        var parsing=events.stream().filter(e->"PARSING".equals(e.get("phase"))).toList();
        assertThat(parsing).extracting(e->e.get("processedRows")).containsExactly(0,1,25,50,60);
        assertThat(parsing).allSatisfy(e->assertThat(e.get("totalRows")).isEqualTo(60));
        assertThat(events.getLast()).containsEntry("phase","EXTRACTING_IMAGES").containsEntry("processedImages",20).containsEntry("totalImages",20);
    }
    @Test void progressDependencyFailureIsNotMisreportedAsWorkbookCorruption()throws Exception {
        byte[] bytes=Files.readAllBytes(Path.of(System.getProperty("jxc.test.purchase-source","D:/downlaoad/NY-051-采购导入.xlsx")));var failure=new IllegalStateException("fixture progress unavailable");
        assertThatThrownBy(()->new PurchaseXlsxTemplateParser().parse(bytes,"source.xlsx",null,event->{throw failure;})).isSameAs(failure);
    }
    @Test void realTemplateReadsWithoutExternalServicesAndPreservesImages() throws Exception {
        byte[] bytes=Files.readAllBytes(Path.of(System.getProperty("jxc.test.purchase-source","D:/downlaoad/NY-051-采购导入.xlsx")));
        var result=new PurchaseXlsxTemplateParser().parse(bytes,"renamed.xlsx",null,event->{}).orElseThrow();
        assertThat((List<?>)result.get("rows")).hasSize(60);
        assertThat((List<?>)result.get("images")).hasSize(20);
        assertThat((List<?>)result.get("associations")).hasSize(60);
        assertThat(result.get("errors")).isEqualTo(List.of());
    }
    @Test void originalSupplierIsNotTemplateEvenWithTemplateName() throws Exception {
        byte[] bytes=Files.readAllBytes(Path.of(System.getProperty("jxc.test.partial-source","C:/Users/JT/Pictures/Screenshots/NY-051.xlsx")));
        assertThat(new PurchaseXlsxTemplateParser().parse(bytes,"采购导入模板.xlsx",null,event->{})).isEmpty();
    }
    @Test void corruptArchiveIsAnErrorRatherThanSupplierFallback() {
        assertThatThrownBy(()->new PurchaseXlsxTemplateParser().parse("PK-invalid".getBytes(),"source.xlsx",null,event->{})).isInstanceOf(ApiException.class);
    }
    @Test void truncatedCentralDirectoryCannotBeAcceptedAsCompleteTemplate() throws Exception {
        byte[] original=Files.readAllBytes(Path.of(System.getProperty("jxc.test.purchase-source","D:/downlaoad/NY-051-采购导入.xlsx")));
        byte[] truncated=Arrays.copyOf(original,original.length-22);
        assertThatThrownBy(()->new PurchaseXlsxTemplateParser().parse(truncated,"source.xlsx",null,event->{})).isInstanceOf(ApiException.class);
    }
}
