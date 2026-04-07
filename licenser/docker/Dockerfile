FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /licenser ./cmd/licenser

FROM alpine:3.20
RUN addgroup -S licenser && adduser -S -G licenser licenser
COPY --from=builder /licenser /usr/local/bin/licenser
VOLUME ["/data", "/keys"]
EXPOSE 8181
USER licenser
ENTRYPOINT ["licenser", "serve"]
CMD ["--data-dir", "/data", "--private-key", "/keys/private.pem", "--public-key", "/keys/public.pem"]
