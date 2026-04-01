.PHONY: all agent k8s-agent licenser cli clean build-all

# Build targets for agent
AGENT_OUT := binaries/agent
K8S_AGENT_OUT := binaries/k8s-agent
LICENSER_OUT := binaries/licenser

all: build-all

build-all: agent-all k8s-agent licenser

# ── Agent (Linux / Windows / macOS, amd64 + arm64) ──────────────────────────
agent-all: agent-linux-amd64 agent-linux-arm64 agent-windows-amd64 agent-darwin-amd64 agent-darwin-arm64

agent-linux-amd64:
	cd agent && GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ../binaries/agent-linux-amd64 ./cmd/agent

agent-linux-arm64:
	cd agent && GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o ../binaries/agent-linux-arm64 ./cmd/agent

agent-windows-amd64:
	cd agent && GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o ../binaries/agent-windows-amd64.exe ./cmd/agent

agent-darwin-amd64:
	cd agent && GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w" -o ../binaries/agent-darwin-amd64 ./cmd/agent

agent-darwin-arm64:
	cd agent && GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o ../binaries/agent-darwin-arm64 ./cmd/agent

# ── Kubernetes Agent ─────────────────────────────────────────────────────────
k8s-agent:
	cd k8s-agent && GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ../binaries/k8s-agent-linux-amd64 ./cmd/k8s-agent
	cd k8s-agent && GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o ../binaries/k8s-agent-linux-arm64 ./cmd/k8s-agent

# ── Licenser tool (vendor only) ──────────────────────────────────────────────
licenser:
	cd licenser && go build -o ../binaries/licenser ./cmd/licenser

# ── Cleanup ──────────────────────────────────────────────────────────────────
clean:
	rm -rf binaries/

# ── Docker ───────────────────────────────────────────────────────────────────
docker-build:
	docker build -f docker/Dockerfile.server -t backuptool-server:latest .

docker-up:
	docker compose -f docker/docker-compose.yml up -d

docker-down:
	docker compose -f docker/docker-compose.yml down

# ── Dev server ───────────────────────────────────────────────────────────────
dev:
	pnpm dev

# ── Drizzle migrations ───────────────────────────────────────────────────────
db-generate:
	cd server && pnpm drizzle-kit generate

db-migrate:
	cd server && pnpm drizzle-kit migrate
