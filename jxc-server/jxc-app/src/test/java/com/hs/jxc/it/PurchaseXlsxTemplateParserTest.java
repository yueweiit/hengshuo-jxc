package com.hs.jxc.it;

import com.hs.jxc.pur.service.impl.PurchaseXlsxTemplateParser;
import com.hs.jxc.common.api.ApiException;
import org.junit.jupiter.api.Test;
import static org.assertj.core.api.Assertions.*;
import java.nio.file.*;
import java.util.*;

class PurchaseXlsxTemplateParserTest {
    @Test void realTemplateReadsWithoutExternalServicesAndPreservesImages() throws Exception {
        byte[] bytes=Files.readAllBytes(Path.of("D:/downlaoad/NY-051-采购导入.xlsx"));
        var result=new PurchaseXlsxTemplateParser().parse(bytes,"renamed.xlsx",null).orElseThrow();
        assertThat((List<?>)result.get("rows")).hasSize(60);
        assertThat((List<?>)result.get("images")).hasSize(20);
        assertThat((List<?>)result.get("associations")).hasSize(60);
        assertThat(result.get("errors")).isEqualTo(List.of());
    }
    @Test void originalSupplierIsNotTemplateEvenWithTemplateName() throws Exception {
        byte[] bytes=Files.readAllBytes(Path.of("C:/Users/JT/Pictures/Screenshots/NY-051.xlsx"));
        assertThat(new PurchaseXlsxTemplateParser().parse(bytes,"采购导入模板.xlsx",null)).isEmpty();
    }
    @Test void corruptArchiveIsAnErrorRatherThanSupplierFallback() {
        assertThatThrownBy(()->new PurchaseXlsxTemplateParser().parse("PK-invalid".getBytes(),"source.xlsx",null)).isInstanceOf(ApiException.class);
    }
    @Test void truncatedCentralDirectoryCannotBeAcceptedAsCompleteTemplate() throws Exception {
        byte[] original=Files.readAllBytes(Path.of("D:/downlaoad/NY-051-采购导入.xlsx"));
        byte[] truncated=Arrays.copyOf(original,original.length-22);
        assertThatThrownBy(()->new PurchaseXlsxTemplateParser().parse(truncated,"source.xlsx",null)).isInstanceOf(ApiException.class);
    }
}
