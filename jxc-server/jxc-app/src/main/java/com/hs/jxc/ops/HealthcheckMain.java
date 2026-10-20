package com.hs.jxc.ops;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
/** Container probe without shell credentials or a second application context. */
public final class HealthcheckMain {
 public static void main(String[] args){try{var result=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build().send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:8080/actuator/health/readiness")).timeout(Duration.ofSeconds(8)).GET().build(),HttpResponse.BodyHandlers.discarding());if(result.statusCode()!=200)System.exit(1);}catch(Exception e){System.exit(1);}}
}
