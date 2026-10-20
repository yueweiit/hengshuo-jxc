package com.hs.jxc.sys.jobs;
/** Business owner background work; invoked by the single durable SYS worker. */
public interface CountryWorkProvider {
 String kind();
 int recover(long country,int limit);
 void daily(long country);
}
