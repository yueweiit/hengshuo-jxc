# Build inputs pinned to locally inspected manifests; release preflight separately requires an audited output digest.
FROM node:22-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS web
WORKDIR /build/web
COPY jxc-web/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --fetch-retries=1 --fetch-timeout=30000
COPY jxc-web/ ./
RUN npm run build && test ! -e dist/mockServiceWorker.js

FROM maven:3.9-eclipse-temurin-21@sha256:1bb51c5ed28b95aef2bc7b46bff6940da43747cdaf838ce4afc2081ce9403750 AS server
WORKDIR /build/server
COPY jxc-server/ ./
ARG JXC_MAVEN_OPTS="-Xmx512m"
RUN --mount=type=cache,target=/root/.m2 MAVEN_OPTS="$JXC_MAVEN_OPTS" mvn -B package -Dmaven.test.skip=true

FROM eclipse-temurin:21-jdk@sha256:23cc5734ff46e776f51ce66eb9ee08444fd47caabec0a95b7eb6e94be2d3696d AS application-base
# The inherited Ubuntu helper is unused by the explicit Java entrypoints.
# Remove its vulnerable Go binary rather than suppressing its scan findings.
RUN rm -f /usr/bin/pebble \
    && groupadd --gid 10001 jxc && useradd --uid 10001 --gid jxc --no-create-home jxc
WORKDIR /app
COPY --chmod=755 deploy/production/entrypoint.sh /app/entrypoint.sh
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["runtime"]

FROM application-base AS application
COPY --from=server --chown=jxc:jxc /build/server/jxc-app/target/jxc-app-0.1.0-SNAPSHOT.jar /app/app.jar

# Package the exact externally verified jar/dist rather than recompiling accepted bytes.
# Supply --build-context release-artifacts=/absolute/private/verified-artifacts.
FROM application-base AS application-verified
COPY --from=release-artifacts --chown=jxc:jxc /app.jar /app/app.jar

FROM nginx:alpine@sha256:892bb2152464f0c5d8972593a5f5afaf8054552580b699d95f8ff4af08c2d33d AS gateway-base
# Fixed vendor security patches; fail closed if these reviewed package versions disappear.
RUN apk add --no-cache --upgrade libexpat=2.9.0-r0 zlib=1.3.2-r1 libx11=1.8.14-r0 \
    && rm -f /usr/share/nginx/html/index.html /usr/share/nginx/html/50x.html
COPY deploy/production/nginx.conf /etc/nginx/conf.d/default.conf

FROM gateway-base AS gateway
COPY --from=web /build/web/dist /usr/share/nginx/html

# Keep PostgreSQL 16 and Alpine 3.23; only reviewed vendor security packages change.
FROM postgres:16.15-alpine3.23@sha256:621a761097839bdb50207afd6b87a72f38e2d718dd46c3d744828d8917c4f1e0 AS postgres-hardened
RUN apk add --no-cache --upgrade libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 zlib=1.3.2-r1

FROM gateway-base AS gateway-verified
COPY --from=release-artifacts /dist /usr/share/nginx/html
