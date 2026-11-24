FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY web ./web
COPY docs/images/desktop.png ./docs/images/desktop.png
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o /quickfile .

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && addgroup -g 10001 quickfile && adduser -D -u 10001 -G quickfile quickfile && mkdir /data && chown quickfile:quickfile /data
COPY --from=build /quickfile /usr/local/bin/quickfile
USER 10001:10001
ENV QUICKFILE_DATA=/data
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/quickfile"]
