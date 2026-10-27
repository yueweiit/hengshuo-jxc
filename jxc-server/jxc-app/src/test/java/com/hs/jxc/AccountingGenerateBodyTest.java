package com.hs.jxc;

import com.hs.jxc.common.api.ApiExceptionAdvice;
import com.hs.jxc.common.context.RequestContext;
import com.hs.jxc.common.context.RequestContextHolder;
import com.hs.jxc.fin.accounting.AccountingController;
import com.hs.jxc.fin.accounting.AccountingService;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

class AccountingGenerateBodyTest {
    @Test void legacyEmptyBodyAndPageBookAreForwardedAsTheSameFixedEventCommand() throws Exception {
        var service=mock(AccountingService.class);
        var mvc=MockMvcBuilders.standaloneSetup(new AccountingController(service)).setControllerAdvice(new ApiExceptionAdvice()).build();
        var context=new RequestContext(201,101L,"AI06-generate-compatible","synthetic");
        String intent="79f81731-42ae-47e5-8b36-b319c22e3859";
        when(service.generate(context,42L,null,intent)).thenReturn(java.util.Map.of("voucherId",7));
        when(service.generate(context,42L,601L,intent)).thenReturn(java.util.Map.of("voucherId",7));
        RequestContextHolder.set(context);
        try {
            for(String body:new String[]{"","{}","{\"bookId\":601}"}) {
                var response=mvc.perform(post("/api/v1/fin/events/42/generate").header("Idempotency-Key",intent).contentType("application/json").content(body)).andReturn().getResponse();
                assertThat(response.getStatus()).isEqualTo(200);
                assertThat(response.getContentAsString()).contains("\"voucherId\":7");
            }
            verify(service,times(2)).generate(context,42L,null,intent);
            verify(service).generate(context,42L,601L,intent);
            verifyNoMoreInteractions(service);
        } finally { RequestContextHolder.clear(); }
    }

    @Test void unknownFieldsAndMalformedBodiesNeverReachVoucherGeneration() throws Exception {
        var service = mock(AccountingService.class);
        var mvc = MockMvcBuilders.standaloneSetup(new AccountingController(service))
            .setControllerAdvice(new ApiExceptionAdvice()).build();
        RequestContextHolder.set(new RequestContext(201,101L,"AI06-generate-body","synthetic"));
        try {
            for(String body:new String[]{"{\"amount\":0}","{\"bookId\":601,\"amount\":99}","[]","{\"bookId\":"}) {
                var response = mvc.perform(post("/api/v1/fin/events/42/generate")
                    .header("Idempotency-Key","79f81731-42ae-47e5-8b36-b319c22e3859")
                    .contentType("application/json").content(body)).andReturn().getResponse();
                assertThat(response.getStatus()).as("body %s",body).isEqualTo(400);
                assertThat(response.getContentAsString()).contains("SYS_BAD_REQUEST");
                verifyNoInteractions(service);
            }
        } finally { RequestContextHolder.clear(); }
    }
}
