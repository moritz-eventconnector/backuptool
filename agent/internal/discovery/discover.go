// Package discovery scans the local system for services, databases and
// application data that should be backed up.
//
// Philosophy: back up EVERYTHING that matters.
// The scanner works on two levels:
//
//  1. Service-specific — identifies databases (PostgreSQL, MySQL, MongoDB,
//     Redis, InfluxDB, …), web apps (Passbolt, Nextcloud, Gitea, WordPress, …),
//     mail servers, Docker volumes, etc. For each it provides smart paths and
//     pre/post backup scripts (e.g. pg_dumpall).
//
//  2. System safety-net — unconditionally includes the directories that
//     always contain critical data: /etc, /home, /root, /var/www, /opt,
//     /srv, /var/spool, /var/mail, SSL certs, crontabs. This guarantees
//     nothing falls through the cracks even if a service is not recognised.
package discovery

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// DiscoveredService describes one discoverable backup target.
type DiscoveredService struct {
	// Name is a human-readable label shown in the UI.
	Name string `json:"name"`
	// Type groups services: "database", "docker", "app", "mail", "system", "certs"
	Type string `json:"type"`
	// SourcePaths are the filesystem paths that must be backed up.
	SourcePaths []string `json:"sourcePaths"`
	// PreScript runs on the agent before restic starts (e.g. pg_dumpall).
	PreScript string `json:"preScript,omitempty"`
	// PostScript runs after restic finishes (e.g. cleanup tmp dump files).
	PostScript string `json:"postScript,omitempty"`
	// Note is an optional human-readable hint (shown in the UI).
	Note string `json:"note,omitempty"`
	// Priority: "critical" | "recommended" | "optional"
	Priority string `json:"priority"`
}

// Scan performs a full discovery of all backup-worthy data on the local host.
// It never fails fatally — partial results are better than none.
func Scan() []DiscoveredService {
	if runtime.GOOS == "windows" {
		return scanWindows()
	}
	return scanUnix()
}

// ── Unix scan ────────────────────────────────────────────────────────────────

func scanUnix() []DiscoveredService {
	procs := runningProcesses() // set of process names currently running
	var services []DiscoveredService

	// ── Databases ────────────────────────────────────────────────────────────

	// PostgreSQL
	if hasProc(procs, "postgres") || hasProc(procs, "postmaster") || hasBin("pg_dump") {
		pgData := firstExisting(
			"/var/lib/postgresql",
			"/var/lib/pgsql",
			"/usr/local/pgsql/data",
			"/opt/homebrew/var/postgresql@16",
			"/opt/homebrew/var/postgresql@15",
			"/opt/homebrew/var/postgres",
		)
		paths := []string{}
		if pgData != "" {
			paths = append(paths, pgData)
		}
		paths = append(paths, "/tmp/backuptool-pg-dump.sql")
		services = append(services, DiscoveredService{
			Name:        "PostgreSQL",
			Type:        "database",
			SourcePaths: paths,
			PreScript: `#!/usr/bin/env bash
# Dump all PostgreSQL databases to a single SQL file
pg_dumpall -U postgres > /tmp/backuptool-pg-dump.sql \
  || pg_dumpall > /tmp/backuptool-pg-dump.sql
chmod 600 /tmp/backuptool-pg-dump.sql`,
			PostScript:  `rm -f /tmp/backuptool-pg-dump.sql`,
			Note:        "Full cluster dump via pg_dumpall. Backup includes both the raw data directory and the SQL dump.",
			Priority:    "critical",
		})
	}

	// MySQL / MariaDB
	if hasProc(procs, "mysqld") || hasProc(procs, "mariadbd") || hasBin("mysqldump") {
		myData := firstExisting("/var/lib/mysql", "/var/lib/mariadb", "/usr/local/mysql/data")
		paths := []string{"/tmp/backuptool-mysql-dump.sql"}
		if myData != "" {
			paths = append(paths, myData)
		}
		services = append(services, DiscoveredService{
			Name:        "MySQL / MariaDB",
			Type:        "database",
			SourcePaths: paths,
			PreScript: `#!/usr/bin/env bash
mysqldump --all-databases --single-transaction --quick \
  --lock-tables=false > /tmp/backuptool-mysql-dump.sql
chmod 600 /tmp/backuptool-mysql-dump.sql`,
			PostScript:  `rm -f /tmp/backuptool-mysql-dump.sql`,
			Note:        "All databases dumped with --single-transaction for consistency.",
			Priority:    "critical",
		})
	}

	// MongoDB
	if hasProc(procs, "mongod") || hasBin("mongodump") {
		mongoData := firstExisting("/var/lib/mongodb", "/var/lib/mongo", "/data/db")
		dumpDir := "/tmp/backuptool-mongo-dump"
		paths := []string{dumpDir}
		if mongoData != "" {
			paths = append(paths, mongoData)
		}
		services = append(services, DiscoveredService{
			Name:        "MongoDB",
			Type:        "database",
			SourcePaths: paths,
			PreScript:   fmt.Sprintf("#!/usr/bin/env bash\nmongodump --out %s", dumpDir),
			PostScript:  fmt.Sprintf("rm -rf %s", dumpDir),
			Priority:    "critical",
		})
	}

	// Redis
	if hasProc(procs, "redis-server") || hasBin("redis-cli") {
		redisDir := redisDataDir()
		paths := []string{}
		if redisDir != "" {
			paths = append(paths, redisDir)
		} else {
			paths = append(paths, "/var/lib/redis")
		}
		services = append(services, DiscoveredService{
			Name:        "Redis",
			Type:        "database",
			SourcePaths: paths,
			PreScript: "#!/usr/bin/env bash\nredis-cli BGSAVE\nsleep 2",
			Note:        "Triggers a BGSAVE before backup to ensure the .rdb dump is current.",
			Priority:    "critical",
		})
	}

	// InfluxDB v2
	if hasProc(procs, "influxd") || dirExists("/var/lib/influxdb") || dirExists("/var/lib/influxdb2") {
		iPath := firstExisting("/var/lib/influxdb2", "/var/lib/influxdb")
		services = append(services, DiscoveredService{
			Name:        "InfluxDB",
			Type:        "database",
			SourcePaths: []string{iPath},
			PreScript: `#!/usr/bin/env bash
# Stop InfluxDB for a consistent snapshot (or use influx backup if available)
influx backup /tmp/backuptool-influx-backup 2>/dev/null || true`,
			PostScript:  `rm -rf /tmp/backuptool-influx-backup`,
			Priority:    "critical",
		})
	}

	// ScyllaDB
	if hasProc(procs, "scylla") || dirExists("/var/lib/scylla") {
		services = append(services, DiscoveredService{
			Name:        "ScyllaDB",
			Type:        "database",
			SourcePaths: existingPaths("/var/lib/scylla", "/etc/scylla"),
			Note:        "Data directory and config. For online consistency use nodetool snapshot before backup.",
			Priority:    "critical",
		})
	}

	// Neo4j
	if hasProc(procs, "neo4j") || dirExists("/var/lib/neo4j") {
		services = append(services, DiscoveredService{
			Name:        "Neo4j",
			Type:        "database",
			SourcePaths: existingPaths("/var/lib/neo4j", "/etc/neo4j"),
			Note:        "Graph database files. Use neo4j-admin backup for hot online backups.",
			Priority:    "critical",
		})
	}

	// ClickHouse
	if hasProc(procs, "clickhouse-server") || dirExists("/var/lib/clickhouse") {
		services = append(services, DiscoveredService{
			Name:        "ClickHouse",
			Type:        "database",
			SourcePaths: existingPaths("/var/lib/clickhouse", "/etc/clickhouse-server"),
			Note:        "Column-store data. Consider BACKUP TO Disk for consistent online backups.",
			Priority:    "critical",
		})
	}

	// KeyDB
	if hasProc(procs, "keydb-server") || dirExists("/var/lib/keydb") {
		services = append(services, DiscoveredService{
			Name:        "KeyDB",
			Type:        "database",
			SourcePaths: existingPaths("/var/lib/keydb", "/etc/keydb"),
			PreScript:   "#!/usr/bin/env bash\nkeydb-cli BGSAVE 2>/dev/null || true\nsleep 2",
			Note:        "Triggers BGSAVE before backup so the .rdb dump is current.",
			Priority:    "critical",
		})
	}

	// Valkey (Redis fork)
	if hasProc(procs, "valkey-server") || dirExists("/var/lib/valkey") {
		services = append(services, DiscoveredService{
			Name:        "Valkey",
			Type:        "database",
			SourcePaths: existingPaths("/var/lib/valkey", "/etc/valkey"),
			PreScript:   "#!/usr/bin/env bash\nvalkey-cli BGSAVE 2>/dev/null || redis-cli BGSAVE 2>/dev/null || true\nsleep 2",
			Note:        "Triggers BGSAVE before backup so the .rdb dump is current.",
			Priority:    "critical",
		})
	}

	// DragonflyDB
	if hasProc(procs, "dragonfly") || dirExists("/var/lib/dragonfly") {
		services = append(services, DiscoveredService{
			Name:        "DragonflyDB",
			Type:        "database",
			SourcePaths: existingPaths("/var/lib/dragonfly", "/etc/dragonfly"),
			Priority:    "critical",
		})
	}

	// ── Docker ───────────────────────────────────────────────────────────────

	if hasBin("docker") && dirExists("/var/lib/docker") {
		dockerPaths := existingPaths("/var/lib/docker/volumes")
		// Docker Swarm stores secrets, configs and raft state here — back it up too.
		if dirExists("/var/lib/docker/swarm") {
			dockerPaths = append(dockerPaths, "/var/lib/docker/swarm")
		}
		services = append(services, DiscoveredService{
			Name:        "Docker Volumes",
			Type:        "docker",
			SourcePaths: dockerPaths,
			Note:        "Named Docker volumes are backed up live without stopping containers — image layers and container state are excluded (re-pull from your compose files). For stateful containers (databases etc.), add a per-service quiesce hook (e.g. docker exec … mysqldump/pg_dump) if crash-consistency isn't enough.",
			Priority:    "critical",
		})

		// Compose project data directories
		composePaths := dockerComposePaths()
		if len(composePaths) > 0 {
			services = append(services, DiscoveredService{
				Name:        "Docker Compose Projects",
				Type:        "docker",
				SourcePaths: composePaths,
				Note:        "docker-compose.yml files and adjacent bind-mount directories.",
				Priority:    "recommended",
			})
		}
	}

	// ── Well-known applications ───────────────────────────────────────────────

	// Passbolt
	if dirExists("/etc/passbolt") || dirExists("/var/www/passbolt") {
		paths := existingPaths(
			"/etc/passbolt",
			"/var/www/passbolt/config",
			"/var/www/passbolt/webroot/img",
			"/var/lib/passbolt",
		)
		services = append(services, DiscoveredService{
			Name:        "Passbolt",
			Type:        "app",
			SourcePaths: paths,
			PreScript: `#!/usr/bin/env bash
# Dump Passbolt database (MySQL)
mysqldump --single-transaction passbolt > /tmp/backuptool-passbolt-db.sql 2>/dev/null \
  || mysqldump --single-transaction -u passbolt passbolt > /tmp/backuptool-passbolt-db.sql 2>/dev/null || true`,
			PostScript:  `rm -f /tmp/backuptool-passbolt-db.sql`,
			Note:        "Config, GPG server key, avatars and database dump. Without the server key, passwords cannot be decrypted.",
			Priority:    "critical",
		})
	}

	// Nextcloud
	if dirExists("/var/www/nextcloud") || dirExists("/var/www/html/nextcloud") {
		root := firstExisting("/var/www/nextcloud", "/var/www/html/nextcloud")
		dataDir := readNextcloudDataDir(root)
		paths := []string{filepath.Join(root, "config")}
		if dataDir != "" && dataDir != root+"/data" {
			paths = append(paths, dataDir)
		} else {
			paths = append(paths, filepath.Join(root, "data"))
		}
		services = append(services, DiscoveredService{
			Name:        "Nextcloud",
			Type:        "app",
			SourcePaths: paths,
			PreScript: `#!/usr/bin/env bash
php /var/www/nextcloud/occ maintenance:mode --on 2>/dev/null || true
mysqldump --single-transaction nextcloud > /tmp/backuptool-nextcloud-db.sql 2>/dev/null || true`,
			PostScript: `php /var/www/nextcloud/occ maintenance:mode --off 2>/dev/null || true
rm -f /tmp/backuptool-nextcloud-db.sql`,
			Note:     "Enables maintenance mode for a consistent backup, then disables it after.",
			Priority: "critical",
		})
	}

	// Gitea
	if dirExists("/var/lib/gitea") || dirExists("/opt/gitea") || hasProc(procs, "gitea") {
		giteaPath := firstExisting("/var/lib/gitea", "/opt/gitea", "/home/git/gitea-repositories")
		services = append(services, DiscoveredService{
			Name:        "Gitea",
			Type:        "app",
			SourcePaths: existingPaths(giteaPath, "/etc/gitea"),
			Priority:    "critical",
		})
	}

	// Gitlab
	if dirExists("/var/opt/gitlab") || hasProc(procs, "gitlab") {
		services = append(services, DiscoveredService{
			Name:        "GitLab",
			Type:        "app",
			SourcePaths: []string{"/var/opt/gitlab/backups"},
			PreScript: `#!/usr/bin/env bash
gitlab-backup create SKIP=artifacts,registry 2>/dev/null || true`,
			Note:     "Uses gitlab-backup create to generate a consistent backup archive.",
			Priority: "critical",
		})
	}

	// WordPress (detect by looking for wp-config.php)
	wpPaths := findFiles("/var/www", "wp-config.php", 3)
	for _, wp := range wpPaths {
		wpDir := filepath.Dir(wp)
		services = append(services, DiscoveredService{
			Name:        "WordPress (" + filepath.Base(wpDir) + ")",
			Type:        "app",
			SourcePaths: []string{wpDir},
			PreScript: fmt.Sprintf(`#!/usr/bin/env bash
DB=$(grep "DB_NAME" %s/wp-config.php | head -1 | sed "s/.*'\\([^']*\\)'.*/\\1/")
USER=$(grep "DB_USER" %s/wp-config.php | head -1 | sed "s/.*'\\([^']*\\)'.*/\\1/")
PASS=$(grep "DB_PASSWORD" %s/wp-config.php | head -1 | sed "s/.*'\\([^']*\\)'.*/\\1/")
mysqldump -u"$USER" -p"$PASS" "$DB" > %s/wp-database-dump.sql 2>/dev/null || true`, wpDir, wpDir, wpDir, wpDir),
			PostScript: fmt.Sprintf(`rm -f %s/wp-database-dump.sql`, wpDir),
			Priority:   "critical",
		})
	}

	// Vaultwarden / Bitwarden RS
	if dirExists("/var/lib/vaultwarden") || dirExists("/opt/vaultwarden") || dirExists("/data/vaultwarden") {
		vwPath := firstExisting("/var/lib/vaultwarden", "/opt/vaultwarden/data", "/data/vaultwarden")
		services = append(services, DiscoveredService{
			Name:        "Vaultwarden",
			Type:        "app",
			SourcePaths: []string{vwPath},
			Note:        "Includes db.sqlite3, attachments, config.json and RSA keys.",
			Priority:    "critical",
		})
	}

	// Mattermost
	if dirExists("/var/lib/mattermost") || hasProc(procs, "mattermost") {
		services = append(services, DiscoveredService{
			Name:        "Mattermost",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/mattermost", "/opt/mattermost/data", "/etc/mattermost"),
			Priority:    "critical",
		})
	}

	// Grafana
	if dirExists("/var/lib/grafana") || hasProc(procs, "grafana") {
		services = append(services, DiscoveredService{
			Name:        "Grafana",
			Type:        "app",
			SourcePaths: []string{"/var/lib/grafana"},
			Priority:    "recommended",
		})
	}

	// ── DNS servers ──────────────────────────────────────────────────────────

	// BIND9 / named
	if hasProc(procs, "named") || hasBin("named") || dirExists("/etc/bind") {
		services = append(services, DiscoveredService{
			Name:        "BIND9 (DNS)",
			Type:        "app",
			SourcePaths: existingPaths("/etc/bind", "/var/lib/bind", "/var/cache/bind", "/etc/named.conf", "/var/named"),
			Note:        "Zone files, DNSSEC keys and named.conf. Critical for DNS continuity.",
			Priority:    "critical",
		})
	}

	// PowerDNS
	if hasProc(procs, "pdns_server") || hasBin("pdns_server") || dirExists("/etc/powerdns") {
		services = append(services, DiscoveredService{
			Name:        "PowerDNS",
			Type:        "app",
			SourcePaths: existingPaths("/etc/powerdns", "/var/lib/pdns"),
			Priority:    "critical",
		})
	}

	// Unbound
	if hasProc(procs, "unbound") || dirExists("/etc/unbound") {
		services = append(services, DiscoveredService{
			Name:        "Unbound (DNS resolver)",
			Type:        "app",
			SourcePaths: existingPaths("/etc/unbound"),
			Priority:    "recommended",
		})
	}

	// dnsmasq
	if hasProc(procs, "dnsmasq") || dirExists("/etc/dnsmasq.d") {
		services = append(services, DiscoveredService{
			Name:        "dnsmasq",
			Type:        "app",
			SourcePaths: existingPaths("/etc/dnsmasq.conf", "/etc/dnsmasq.d"),
			Priority:    "recommended",
		})
	}

	// ── Web servers ───────────────────────────────────────────────────────────

	// Nginx
	if hasProc(procs, "nginx") || hasBin("nginx") || dirExists("/etc/nginx") {
		services = append(services, DiscoveredService{
			Name:        "Nginx",
			Type:        "app",
			SourcePaths: existingPaths("/etc/nginx"),
			Priority:    "critical",
		})
	}

	// Apache
	if hasProc(procs, "apache2") || hasProc(procs, "httpd") || dirExists("/etc/apache2") || dirExists("/etc/httpd") {
		services = append(services, DiscoveredService{
			Name:        "Apache",
			Type:        "app",
			SourcePaths: existingPaths("/etc/apache2", "/etc/httpd"),
			Priority:    "critical",
		})
	}

	// Caddy
	if hasProc(procs, "caddy") || hasBin("caddy") || dirExists("/etc/caddy") {
		services = append(services, DiscoveredService{
			Name:        "Caddy",
			Type:        "app",
			SourcePaths: existingPaths("/etc/caddy", "/var/lib/caddy", "/usr/local/etc/caddy"),
			Priority:    "recommended",
		})
	}

	// HAProxy
	if hasProc(procs, "haproxy") || dirExists("/etc/haproxy") {
		services = append(services, DiscoveredService{
			Name:        "HAProxy",
			Type:        "app",
			SourcePaths: existingPaths("/etc/haproxy"),
			Priority:    "critical",
		})
	}

	// Traefik
	if hasProc(procs, "traefik") || dirExists("/etc/traefik") {
		services = append(services, DiscoveredService{
			Name:        "Traefik",
			Type:        "app",
			SourcePaths: existingPaths("/etc/traefik", "/var/lib/traefik"),
			Priority:    "recommended",
		})
	}

	// ── Server management panels ──────────────────────────────────────────────

	// Webmin
	if hasProc(procs, "miniserv.pl") || hasBin("webmin") || dirExists("/etc/webmin") {
		services = append(services, DiscoveredService{
			Name:        "Webmin",
			Type:        "app",
			SourcePaths: existingPaths("/etc/webmin", "/var/webmin"),
			Note:        "Webmin configuration, modules and user data.",
			Priority:    "critical",
		})
	}

	// cPanel / WHM
	if dirExists("/usr/local/cpanel") || dirExists("/var/cpanel") {
		services = append(services, DiscoveredService{
			Name:        "cPanel / WHM",
			Type:        "app",
			SourcePaths: existingPaths("/var/cpanel", "/etc/cpanel", "/usr/local/cpanel/logs"),
			Note:        "Use cPanel's built-in backup for full account backups.",
			Priority:    "critical",
		})
	}

	// Plesk
	if dirExists("/opt/psa") || dirExists("/usr/local/psa") {
		services = append(services, DiscoveredService{
			Name:        "Plesk",
			Type:        "app",
			SourcePaths: existingPaths("/var/www/vhosts", "/opt/psa/var", "/etc/sw/keys"),
			Priority:    "critical",
		})
	}

	// ISPConfig
	if dirExists("/usr/local/ispconfig") {
		services = append(services, DiscoveredService{
			Name:        "ISPConfig",
			Type:        "app",
			SourcePaths: existingPaths("/usr/local/ispconfig", "/etc/ispconfig"),
			Priority:    "critical",
		})
	}

	// HestiaCP / VestaCP
	if dirExists("/usr/local/hestia") || dirExists("/usr/local/vesta") {
		hPath := firstExisting("/usr/local/hestia", "/usr/local/vesta")
		services = append(services, DiscoveredService{
			Name:        "HestiaCP / VestaCP",
			Type:        "app",
			SourcePaths: existingPaths(hPath+"/data", hPath+"/conf", "/home"),
			Priority:    "critical",
		})
	}

	// ── Messaging / Queue ─────────────────────────────────────────────────────

	// RabbitMQ
	if hasProc(procs, "beam.smp") || hasBin("rabbitmqctl") || dirExists("/var/lib/rabbitmq") {
		services = append(services, DiscoveredService{
			Name:        "RabbitMQ",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/rabbitmq", "/etc/rabbitmq"),
			Priority:    "critical",
		})
	}

	// ── Search / Datastore ────────────────────────────────────────────────────

	// Elasticsearch
	if hasProc(procs, "java") && dirExists("/var/lib/elasticsearch") {
		services = append(services, DiscoveredService{
			Name:        "Elasticsearch",
			Type:        "database",
			SourcePaths: existingPaths("/var/lib/elasticsearch", "/etc/elasticsearch"),
			Note:        "Stop Elasticsearch or use snapshot API for consistent backups.",
			Priority:    "critical",
		})
	}

	// OpenSearch
	if dirExists("/var/lib/opensearch") || dirExists("/etc/opensearch") {
		services = append(services, DiscoveredService{
			Name:        "OpenSearch",
			Type:        "database",
			SourcePaths: existingPaths("/var/lib/opensearch", "/etc/opensearch"),
			Priority:    "critical",
		})
	}

	// CouchDB
	if hasProc(procs, "beam") || hasBin("couchdb") || dirExists("/var/lib/couchdb") {
		services = append(services, DiscoveredService{
			Name:        "CouchDB",
			Type:        "database",
			SourcePaths: existingPaths("/var/lib/couchdb", "/etc/couchdb"),
			Priority:    "critical",
		})
	}

	// Cassandra
	if hasProc(procs, "java") && dirExists("/var/lib/cassandra") {
		services = append(services, DiscoveredService{
			Name:        "Apache Cassandra",
			Type:        "database",
			SourcePaths: existingPaths("/var/lib/cassandra", "/etc/cassandra"),
			Priority:    "critical",
		})
	}

	// ── Monitoring & Observability ────────────────────────────────────────────

	// Prometheus
	if hasProc(procs, "prometheus") || dirExists("/var/lib/prometheus") {
		services = append(services, DiscoveredService{
			Name:        "Prometheus",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/prometheus", "/etc/prometheus"),
			Priority:    "recommended",
		})
	}

	// Victoria Metrics
	if hasProc(procs, "victoria-metrics") || dirExists("/var/lib/victoria-metrics-data") {
		services = append(services, DiscoveredService{
			Name:        "VictoriaMetrics",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/victoria-metrics-data", "/etc/victoria-metrics"),
			Priority:    "recommended",
		})
	}

	// Loki
	if hasProc(procs, "loki") || dirExists("/var/lib/loki") {
		services = append(services, DiscoveredService{
			Name:        "Grafana Loki",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/loki", "/etc/loki"),
			Priority:    "recommended",
		})
	}

	// Zabbix
	if hasProc(procs, "zabbix_server") || dirExists("/etc/zabbix") {
		services = append(services, DiscoveredService{
			Name:        "Zabbix",
			Type:        "app",
			SourcePaths: existingPaths("/etc/zabbix", "/var/lib/zabbix", "/usr/share/zabbix"),
			Priority:    "recommended",
		})
	}

	// Nagios / Icinga
	if dirExists("/usr/local/nagios") || dirExists("/etc/nagios") || dirExists("/etc/icinga") {
		services = append(services, DiscoveredService{
			Name:        "Nagios / Icinga",
			Type:        "app",
			SourcePaths: existingPaths("/usr/local/nagios/etc", "/etc/nagios", "/etc/icinga", "/var/lib/nagios", "/var/lib/icinga"),
			Priority:    "recommended",
		})
	}

	// Uptime Kuma
	if dirExists("/app/data") && (hasBin("node") || hasProc(procs, "node")) {
		if _, err := os.Stat("/app/data/kuma.db"); err == nil {
			services = append(services, DiscoveredService{
				Name:        "Uptime Kuma",
				Type:        "app",
				SourcePaths: []string{"/app/data"},
				Priority:    "recommended",
			})
		}
	}
	if d := firstExisting("/opt/uptime-kuma", "/home/node/.uptime-kuma"); d != "" {
		services = append(services, DiscoveredService{
			Name:        "Uptime Kuma",
			Type:        "app",
			SourcePaths: []string{d},
			Priority:    "recommended",
		})
	}

	// ── CI/CD ─────────────────────────────────────────────────────────────────

	// Jenkins
	if hasProc(procs, "java") && dirExists("/var/lib/jenkins") {
		services = append(services, DiscoveredService{
			Name:        "Jenkins",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/jenkins", "/etc/default/jenkins"),
			Note:        "Includes jobs, build history, credentials and plugins.",
			Priority:    "critical",
		})
	}

	// GitLab Runner
	if dirExists("/etc/gitlab-runner") || dirExists("/var/lib/gitlab-runner") {
		services = append(services, DiscoveredService{
			Name:        "GitLab Runner",
			Type:        "app",
			SourcePaths: existingPaths("/etc/gitlab-runner", "/var/lib/gitlab-runner"),
			Priority:    "recommended",
		})
	}

	// ── Communication ─────────────────────────────────────────────────────────

	// Matrix / Synapse
	if hasProc(procs, "synapse") || dirExists("/var/lib/matrix-synapse") || dirExists("/etc/matrix-synapse") {
		services = append(services, DiscoveredService{
			Name:        "Matrix (Synapse)",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/matrix-synapse", "/etc/matrix-synapse"),
			PreScript: `#!/usr/bin/env bash
# Dump Synapse PostgreSQL database
pg_dump -U synapse synapse > /tmp/backuptool-synapse-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-synapse-db.sql`,
			Priority:   "critical",
		})
	}

	// ejabberd
	if hasProc(procs, "ejabberd") || dirExists("/var/lib/ejabberd") {
		services = append(services, DiscoveredService{
			Name:        "ejabberd (XMPP)",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/ejabberd", "/etc/ejabberd"),
			Priority:    "critical",
		})
	}

	// Prosody
	if hasProc(procs, "prosody") || dirExists("/var/lib/prosody") {
		services = append(services, DiscoveredService{
			Name:        "Prosody (XMPP)",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/prosody", "/etc/prosody"),
			Priority:    "critical",
		})
	}

	// Mumble / Murmur
	if hasProc(procs, "murmurd") || dirExists("/var/lib/mumble-server") {
		services = append(services, DiscoveredService{
			Name:        "Mumble (Murmur)",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/mumble-server", "/etc/mumble-server.ini"),
			Priority:    "recommended",
		})
	}

	// Rocket.Chat
	if dirExists("/opt/Rocket.Chat") || dirExists("/var/lib/rocketchat") {
		services = append(services, DiscoveredService{
			Name:        "Rocket.Chat",
			Type:        "app",
			SourcePaths: existingPaths("/opt/Rocket.Chat/uploads", "/var/lib/rocketchat"),
			Priority:    "critical",
		})
	}

	// ── Mail ─────────────────────────────────────────────────────────────────

	if hasProc(procs, "dovecot") || hasProc(procs, "postfix") || dirExists("/var/mail") || dirExists("/var/spool/mail") {
		paths := existingPaths("/var/mail", "/var/spool/mail", "/home", "/etc/postfix", "/etc/dovecot")
		services = append(services, DiscoveredService{
			Name:        "Mail Server (Postfix/Dovecot)",
			Type:        "mail",
			SourcePaths: paths,
			Priority:    "critical",
		})
	}

	// Exim
	if hasProc(procs, "exim") || hasBin("exim") || dirExists("/etc/exim4") {
		services = append(services, DiscoveredService{
			Name:        "Exim",
			Type:        "mail",
			SourcePaths: existingPaths("/etc/exim4", "/var/spool/exim4"),
			Priority:    "critical",
		})
	}

	// Mailcow
	if dirExists("/opt/mailcow-dockerized") {
		services = append(services, DiscoveredService{
			Name:        "Mailcow",
			Type:        "mail",
			SourcePaths: existingPaths("/opt/mailcow-dockerized"),
			PreScript: `#!/usr/bin/env bash
cd /opt/mailcow-dockerized
./helper-scripts/backup_and_restore.sh backup all 2>/dev/null || true`,
			Note:     "Uses official mailcow backup script. Includes docker-compose.yml, .env and all mail data.",
			Priority: "critical",
		})
	}

	// Roundcube
	if dirExists("/var/lib/roundcube") || dirExists("/etc/roundcube") {
		services = append(services, DiscoveredService{
			Name:        "Roundcube Webmail",
			Type:        "mail",
			SourcePaths: existingPaths("/var/lib/roundcube", "/etc/roundcube"),
			Priority:    "recommended",
		})
	}

	// Rspamd
	if hasProc(procs, "rspamd") || dirExists("/etc/rspamd") {
		services = append(services, DiscoveredService{
			Name:        "Rspamd (spam filter)",
			Type:        "app",
			SourcePaths: existingPaths("/etc/rspamd", "/var/lib/rspamd"),
			Priority:    "recommended",
		})
	}

	// SpamAssassin
	if hasBin("spamassassin") || dirExists("/etc/spamassassin") {
		services = append(services, DiscoveredService{
			Name:        "SpamAssassin",
			Type:        "app",
			SourcePaths: existingPaths("/etc/spamassassin", "/var/lib/spamassassin"),
			Priority:    "optional",
		})
	}

	// ── VPN / Networking ──────────────────────────────────────────────────────

	// OpenVPN
	if hasProc(procs, "openvpn") || dirExists("/etc/openvpn") {
		services = append(services, DiscoveredService{
			Name:        "OpenVPN",
			Type:        "app",
			SourcePaths: existingPaths("/etc/openvpn"),
			Note:        "Includes PKI keys, CA and client configs. Keep private.",
			Priority:    "critical",
		})
	}

	// WireGuard
	if hasProc(procs, "wireguard") || dirExists("/etc/wireguard") {
		services = append(services, DiscoveredService{
			Name:        "WireGuard",
			Type:        "app",
			SourcePaths: existingPaths("/etc/wireguard"),
			Note:        "Private keys and peer configs.",
			Priority:    "critical",
		})
	}

	// StrongSwan / IPsec
	if hasProc(procs, "charon") || dirExists("/etc/ipsec.d") || dirExists("/etc/strongswan") {
		services = append(services, DiscoveredService{
			Name:        "StrongSwan / IPsec",
			Type:        "app",
			SourcePaths: existingPaths("/etc/ipsec.d", "/etc/strongswan", "/etc/ipsec.conf", "/etc/ipsec.secrets"),
			Priority:    "critical",
		})
	}

	// ZeroTier
	if hasProc(procs, "zerotier-one") || dirExists("/var/lib/zerotier-one") {
		services = append(services, DiscoveredService{
			Name:        "ZeroTier",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/zerotier-one"),
			Note:        "Node identity and network configs.",
			Priority:    "critical",
		})
	}

	// Squid proxy
	if hasProc(procs, "squid") || dirExists("/etc/squid") {
		services = append(services, DiscoveredService{
			Name:        "Squid Proxy",
			Type:        "app",
			SourcePaths: existingPaths("/etc/squid"),
			Priority:    "optional",
		})
	}

	// ── Security / Identity ───────────────────────────────────────────────────

	// Fail2ban
	if hasProc(procs, "fail2ban-server") || dirExists("/etc/fail2ban") {
		services = append(services, DiscoveredService{
			Name:        "Fail2ban",
			Type:        "app",
			SourcePaths: existingPaths("/etc/fail2ban", "/var/lib/fail2ban"),
			Priority:    "recommended",
		})
	}

	// CrowdSec
	if hasProc(procs, "crowdsec") || dirExists("/etc/crowdsec") {
		services = append(services, DiscoveredService{
			Name:        "CrowdSec",
			Type:        "app",
			SourcePaths: existingPaths("/etc/crowdsec", "/var/lib/crowdsec"),
			Priority:    "recommended",
		})
	}

	// OpenLDAP
	if hasProc(procs, "slapd") || dirExists("/var/lib/ldap") {
		services = append(services, DiscoveredService{
			Name:        "OpenLDAP",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/ldap", "/etc/ldap", "/etc/openldap"),
			PreScript: `#!/usr/bin/env bash
slapcat -n 1 > /tmp/backuptool-ldap.ldif 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-ldap.ldif`,
			Priority:   "critical",
		})
	}

	// HashiCorp Vault
	if hasProc(procs, "vault") || dirExists("/etc/vault.d") {
		services = append(services, DiscoveredService{
			Name:        "HashiCorp Vault",
			Type:        "app",
			SourcePaths: existingPaths("/etc/vault.d", "/var/lib/vault", "/opt/vault"),
			Note:        "Includes unsealed storage and config. Never back up unseal keys insecurely.",
			Priority:    "critical",
		})
	}

	// Authentik
	if dirExists("/etc/authentik") || dirExists("/media/authentik") {
		services = append(services, DiscoveredService{
			Name:        "Authentik (SSO)",
			Type:        "app",
			SourcePaths: existingPaths("/etc/authentik", "/media/authentik"),
			Priority:    "critical",
		})
	}

	// Keycloak
	if dirExists("/opt/keycloak") || hasProc(procs, "keycloak") {
		services = append(services, DiscoveredService{
			Name:        "Keycloak",
			Type:        "app",
			SourcePaths: existingPaths("/opt/keycloak/data", "/var/lib/keycloak"),
			Priority:    "critical",
		})
	}

	// FreeIPA
	if dirExists("/etc/ipa") || dirExists("/var/lib/ipa") {
		services = append(services, DiscoveredService{
			Name:        "FreeIPA",
			Type:        "app",
			SourcePaths: existingPaths("/etc/ipa", "/var/lib/ipa"),
			Priority:    "critical",
		})
	}

	// ── File Sharing / Storage ────────────────────────────────────────────────

	// Samba
	if hasProc(procs, "smbd") || dirExists("/etc/samba") {
		services = append(services, DiscoveredService{
			Name:        "Samba",
			Type:        "app",
			SourcePaths: existingPaths("/etc/samba"),
			Priority:    "recommended",
		})
	}

	// MinIO
	if hasProc(procs, "minio") || dirExists("/var/lib/minio") || dirExists("/data/minio") {
		mPath := firstExisting("/var/lib/minio", "/data/minio", "/mnt/data/minio")
		services = append(services, DiscoveredService{
			Name:        "MinIO",
			Type:        "app",
			SourcePaths: existingPaths(mPath, "/etc/minio"),
			Priority:    "critical",
		})
	}

	// Seafile
	if dirExists("/opt/seafile") || dirExists("/var/seafile") {
		services = append(services, DiscoveredService{
			Name:        "Seafile",
			Type:        "app",
			SourcePaths: existingPaths("/opt/seafile", "/var/seafile"),
			Priority:    "critical",
		})
	}

	// Syncthing
	if hasProc(procs, "syncthing") || dirExists("/var/lib/syncthing") {
		services = append(services, DiscoveredService{
			Name:        "Syncthing",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/syncthing"),
			Priority:    "recommended",
		})
	}

	// Portainer
	if dirExists("/data/portainer") {
		services = append(services, DiscoveredService{
			Name:        "Portainer",
			Type:        "app",
			SourcePaths: []string{"/data/portainer"},
			Note:        "Portainer data volume with stacks, configs and users.",
			Priority:    "recommended",
		})
	}

	// ── Home Automation ────────────────────────────────────────────────────────

	// Home Assistant
	haPaths := existingPaths("/etc/homeassistant", "/home/homeassistant/.homeassistant", "/var/lib/hass", "/config")
	if len(haPaths) == 0 {
		// Docker installs often put config in /config or a bind mount
		haPaths = existingPaths("/opt/homeassistant", "/srv/homeassistant")
	}
	if len(haPaths) > 0 && (hasProc(procs, "hass") || hasProc(procs, "home-assistant") || dirExists("/etc/homeassistant") || dirExists("/home/homeassistant/.homeassistant")) {
		services = append(services, DiscoveredService{
			Name:        "Home Assistant",
			Type:        "app",
			SourcePaths: haPaths,
			Note:        "Configuration, automations, history database and custom components.",
			Priority:    "critical",
		})
	}

	// Frigate NVR
	if dirExists("/config/frigate") || dirExists("/etc/frigate") || dirExists("/opt/frigate") {
		services = append(services, DiscoveredService{
			Name:        "Frigate NVR",
			Type:        "app",
			SourcePaths: existingPaths("/config/frigate", "/etc/frigate", "/opt/frigate"),
			Note:        "Config and clip database. Recordings (media) are typically stored separately.",
			Priority:    "recommended",
		})
	}

	// ── Document / Photo Management ───────────────────────────────────────────

	// Paperless-ngx
	if dirExists("/opt/paperless-ngx") || dirExists("/var/lib/paperless-ngx") || dirExists("/usr/src/paperless") {
		paperlessData := firstExisting("/opt/paperless-ngx/media", "/var/lib/paperless-ngx", "/usr/src/paperless/media")
		services = append(services, DiscoveredService{
			Name:        "Paperless-ngx",
			Type:        "app",
			SourcePaths: existingPaths(paperlessData, "/opt/paperless-ngx/data", "/var/lib/paperless-ngx"),
			PreScript: `#!/usr/bin/env bash
# Export Paperless-ngx database
cd /opt/paperless-ngx 2>/dev/null || cd /usr/src/paperless 2>/dev/null || true
python3 manage.py document_exporter /tmp/backuptool-paperless-export 2>/dev/null || true`,
			PostScript: `rm -rf /tmp/backuptool-paperless-export`,
			Note:       "Documents, thumbnails, archive and database. All scanned documents.",
			Priority:   "critical",
		})
	}

	// Immich
	if dirExists("/var/lib/immich") || dirExists("/opt/immich") || dirExists("/mnt/immich") {
		immichPath := firstExisting("/var/lib/immich", "/opt/immich/upload", "/mnt/immich")
		services = append(services, DiscoveredService{
			Name:        "Immich",
			Type:        "app",
			SourcePaths: existingPaths(immichPath, "/opt/immich/data"),
			PreScript: `#!/usr/bin/env bash
# Dump Immich PostgreSQL database
pg_dump -U immich immich > /tmp/backuptool-immich-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-immich-db.sql`,
			Note:       "Photos, videos and database. The upload library can be very large.",
			Priority:   "critical",
		})
	}

	// Photoprism
	if dirExists("/var/lib/photoprism") || dirExists("/opt/photoprism") || dirExists("/photoprism") {
		ppPath := firstExisting("/var/lib/photoprism", "/opt/photoprism/storage", "/photoprism/storage")
		services = append(services, DiscoveredService{
			Name:        "PhotoPrism",
			Type:        "app",
			SourcePaths: existingPaths(ppPath, "/photoprism/originals"),
			Note:        "Storage (sidecar, cache, config) and originals library.",
			Priority:    "critical",
		})
	}

	// ── Knowledge Bases / Wikis ───────────────────────────────────────────────

	// BookStack
	if dirExists("/var/www/bookstack") || dirExists("/opt/bookstack") {
		bsRoot := firstExisting("/var/www/bookstack", "/opt/bookstack")
		services = append(services, DiscoveredService{
			Name:        "BookStack",
			Type:        "app",
			SourcePaths: existingPaths(bsRoot+"/public/uploads", bsRoot+"/storage"),
			PreScript: fmt.Sprintf(`#!/usr/bin/env bash
DB=$(grep "^DB_DATABASE" %s/.env 2>/dev/null | cut -d= -f2)
USER=$(grep "^DB_USERNAME" %s/.env 2>/dev/null | cut -d= -f2)
PASS=$(grep "^DB_PASSWORD" %s/.env 2>/dev/null | cut -d= -f2)
mysqldump -u"$USER" -p"$PASS" "$DB" > /tmp/backuptool-bookstack-db.sql 2>/dev/null || true`, bsRoot, bsRoot, bsRoot),
			PostScript: `rm -f /tmp/backuptool-bookstack-db.sql`,
			Note:       "Uploads, attachments and database dump.",
			Priority:   "critical",
		})
	}

	// Wiki.js
	if dirExists("/var/lib/wikijs") || dirExists("/opt/wiki") || dirExists("/wiki") {
		wikiPath := firstExisting("/var/lib/wikijs", "/opt/wiki", "/wiki")
		services = append(services, DiscoveredService{
			Name:        "Wiki.js",
			Type:        "app",
			SourcePaths: existingPaths(wikiPath),
			Priority:    "critical",
		})
	}

	// Outline (wiki)
	if dirExists("/var/lib/outline") || dirExists("/opt/outline") {
		services = append(services, DiscoveredService{
			Name:        "Outline",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/outline", "/opt/outline"),
			Priority:    "critical",
		})
	}

	// ── Blogs / CMS ───────────────────────────────────────────────────────────

	// Ghost
	if dirExists("/var/lib/ghost") || dirExists("/opt/ghost") {
		ghostPath := firstExisting("/var/lib/ghost/content", "/opt/ghost/content")
		services = append(services, DiscoveredService{
			Name:        "Ghost",
			Type:        "app",
			SourcePaths: existingPaths(ghostPath, "/var/lib/ghost", "/opt/ghost"),
			Note:        "Content directory including images, themes and SQLite database.",
			Priority:    "critical",
		})
	}

	// Strapi
	if dirExists("/opt/strapi") || (hasProc(procs, "strapi") && dirExists("/srv/strapi")) {
		strapiPath := firstExisting("/opt/strapi", "/srv/strapi")
		services = append(services, DiscoveredService{
			Name:        "Strapi",
			Type:        "app",
			SourcePaths: existingPaths(strapiPath+"/public/uploads", strapiPath),
			Priority:    "critical",
		})
	}

	// Directus
	if dirExists("/opt/directus") || dirExists("/var/lib/directus") {
		services = append(services, DiscoveredService{
			Name:        "Directus",
			Type:        "app",
			SourcePaths: existingPaths("/opt/directus/uploads", "/var/lib/directus"),
			Priority:    "critical",
		})
	}

	// ── Project Management / CRM ──────────────────────────────────────────────

	// Vikunja (task manager)
	if dirExists("/var/lib/vikunja") || dirExists("/opt/vikunja") || hasProc(procs, "vikunja") {
		services = append(services, DiscoveredService{
			Name:        "Vikunja",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/vikunja", "/opt/vikunja"),
			Priority:    "critical",
		})
	}

	// Monica (personal CRM)
	if dirExists("/var/www/monica") || dirExists("/opt/monica") {
		monicaRoot := firstExisting("/var/www/monica", "/opt/monica")
		services = append(services, DiscoveredService{
			Name:        "Monica (CRM)",
			Type:        "app",
			SourcePaths: existingPaths(monicaRoot+"/storage"),
			PreScript: fmt.Sprintf(`#!/usr/bin/env bash
DB=$(grep "^DB_DATABASE" %s/.env 2>/dev/null | cut -d= -f2)
USER=$(grep "^DB_USERNAME" %s/.env 2>/dev/null | cut -d= -f2)
PASS=$(grep "^DB_PASSWORD" %s/.env 2>/dev/null | cut -d= -f2)
mysqldump -u"$USER" -p"$PASS" "$DB" > /tmp/backuptool-monica-db.sql 2>/dev/null || true`, monicaRoot, monicaRoot, monicaRoot),
			PostScript: `rm -f /tmp/backuptool-monica-db.sql`,
			Priority:   "critical",
		})
	}

	// Plane (project management)
	if dirExists("/opt/plane") {
		services = append(services, DiscoveredService{
			Name:        "Plane",
			Type:        "app",
			SourcePaths: existingPaths("/opt/plane"),
			Priority:    "critical",
		})
	}

	// Redmine
	if dirExists("/var/lib/redmine") || dirExists("/opt/redmine") || dirExists("/usr/share/redmine") {
		rmPath := firstExisting("/var/lib/redmine", "/opt/redmine", "/usr/share/redmine")
		services = append(services, DiscoveredService{
			Name:        "Redmine",
			Type:        "app",
			SourcePaths: existingPaths(rmPath+"/files", rmPath),
			PreScript: `#!/usr/bin/env bash
# Dump Redmine database (usually MySQL or PostgreSQL)
mysqldump --single-transaction redmine > /tmp/backuptool-redmine-db.sql 2>/dev/null \
  || pg_dump -U redmine redmine > /tmp/backuptool-redmine-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-redmine-db.sql`,
			Priority:   "critical",
		})
	}

	// GLPI (IT asset management)
	if dirExists("/var/www/glpi") || dirExists("/opt/glpi") {
		glpiRoot := firstExisting("/var/www/glpi", "/opt/glpi")
		services = append(services, DiscoveredService{
			Name:        "GLPI",
			Type:        "app",
			SourcePaths: existingPaths(glpiRoot+"/files", glpiRoot+"/config"),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction glpi > /tmp/backuptool-glpi-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-glpi-db.sql`,
			Priority:   "critical",
		})
	}

	// ── Finance / Business ────────────────────────────────────────────────────

	// Invoice Ninja
	if dirExists("/var/www/invoiceninja") || dirExists("/opt/invoiceninja") {
		inRoot := firstExisting("/var/www/invoiceninja", "/opt/invoiceninja")
		services = append(services, DiscoveredService{
			Name:        "Invoice Ninja",
			Type:        "app",
			SourcePaths: existingPaths(inRoot+"/storage", inRoot),
			PreScript: fmt.Sprintf(`#!/usr/bin/env bash
DB=$(grep "^DB_DATABASE" %s/.env 2>/dev/null | cut -d= -f2)
USER=$(grep "^DB_USERNAME" %s/.env 2>/dev/null | cut -d= -f2)
PASS=$(grep "^DB_PASSWORD" %s/.env 2>/dev/null | cut -d= -f2)
mysqldump -u"$USER" -p"$PASS" "$DB" > /tmp/backuptool-invoiceninja-db.sql 2>/dev/null || true`, inRoot, inRoot, inRoot),
			PostScript: `rm -f /tmp/backuptool-invoiceninja-db.sql`,
			Priority:   "critical",
		})
	}

	// Snipe-IT (asset management)
	if dirExists("/var/www/snipe-it") || dirExists("/opt/snipe-it") {
		siRoot := firstExisting("/var/www/snipe-it", "/opt/snipe-it")
		services = append(services, DiscoveredService{
			Name:        "Snipe-IT",
			Type:        "app",
			SourcePaths: existingPaths(siRoot+"/storage/app", siRoot+"/storage"),
			PreScript: fmt.Sprintf(`#!/usr/bin/env bash
DB=$(grep "^DB_DATABASE" %s/.env 2>/dev/null | cut -d= -f2)
USER=$(grep "^DB_USERNAME" %s/.env 2>/dev/null | cut -d= -f2)
PASS=$(grep "^DB_PASSWORD" %s/.env 2>/dev/null | cut -d= -f2)
mysqldump -u"$USER" -p"$PASS" "$DB" > /tmp/backuptool-snipeit-db.sql 2>/dev/null || true`, siRoot, siRoot, siRoot),
			PostScript: `rm -f /tmp/backuptool-snipeit-db.sql`,
			Priority:   "critical",
		})
	}

	// ── Dev tools / Code Hosting ──────────────────────────────────────────────

	// Forgejo (Gitea fork)
	if dirExists("/var/lib/forgejo") || dirExists("/opt/forgejo") || hasProc(procs, "forgejo") {
		forgejoPth := firstExisting("/var/lib/forgejo", "/opt/forgejo")
		services = append(services, DiscoveredService{
			Name:        "Forgejo",
			Type:        "app",
			SourcePaths: existingPaths(forgejoPth, "/etc/forgejo"),
			PreScript: `#!/usr/bin/env bash
forgejo dump -c /etc/forgejo/app.ini --tempdir /tmp/backuptool-forgejo-dump 2>/dev/null || true`,
			PostScript: `rm -rf /tmp/backuptool-forgejo-dump`,
			Priority:   "critical",
		})
	}

	// Weblate (translation platform)
	if dirExists("/var/lib/weblate") || dirExists("/opt/weblate") || hasProc(procs, "weblate") {
		services = append(services, DiscoveredService{
			Name:        "Weblate",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/weblate", "/opt/weblate/data"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U weblate weblate > /tmp/backuptool-weblate-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-weblate-db.sql`,
			Priority:   "recommended",
		})
	}

	// Headscale (self-hosted Tailscale)
	if hasProc(procs, "headscale") || dirExists("/var/lib/headscale") || dirExists("/etc/headscale") {
		services = append(services, DiscoveredService{
			Name:        "Headscale",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/headscale", "/etc/headscale"),
			Note:        "Database and private keys. Losing these breaks the mesh network.",
			Priority:    "critical",
		})
	}

	// Netdata
	if hasProc(procs, "netdata") || dirExists("/var/lib/netdata") {
		services = append(services, DiscoveredService{
			Name:        "Netdata",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/netdata", "/etc/netdata"),
			Priority:    "optional",
		})
	}

	// Plausible Analytics
	if dirExists("/opt/plausible") || dirExists("/var/lib/plausible") {
		services = append(services, DiscoveredService{
			Name:        "Plausible Analytics",
			Type:        "app",
			SourcePaths: existingPaths("/opt/plausible", "/var/lib/plausible"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U plausible plausible > /tmp/backuptool-plausible-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-plausible-db.sql`,
			Priority:   "recommended",
		})
	}

	// OwnCloud Infinite Scale (OCIS)
	if dirExists("/var/lib/ocis") || dirExists("/etc/ocis") || hasProc(procs, "ocis") {
		services = append(services, DiscoveredService{
			Name:        "ownCloud Infinite Scale (OCIS)",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/ocis", "/etc/ocis"),
			Note:        "All user files and metadata stored in the OCIS data directory.",
			Priority:    "critical",
		})
	}

	// Mealie (recipe manager)
	if dirExists("/app/data") && dirExists("/app/data/recipes") {
		services = append(services, DiscoveredService{
			Name:        "Mealie",
			Type:        "app",
			SourcePaths: []string{"/app/data"},
			Note:        "Recipes, meal plans, shopping lists and backups.",
			Priority:    "recommended",
		})
	}
	if d := firstExisting("/opt/mealie", "/var/lib/mealie"); d != "" {
		services = append(services, DiscoveredService{
			Name:        "Mealie",
			Type:        "app",
			SourcePaths: []string{d},
			Priority:    "recommended",
		})
	}

	// Zitadel (identity provider)
	if dirExists("/var/lib/zitadel") || hasProc(procs, "zitadel") {
		services = append(services, DiscoveredService{
			Name:        "Zitadel",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/zitadel", "/etc/zitadel"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U zitadel zitadel > /tmp/backuptool-zitadel-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-zitadel-db.sql`,
			Priority:   "critical",
		})
	}

	// Grist (spreadsheet / database hybrid)
	if dirExists("/opt/grist") || dirExists("/persist/grist") {
		services = append(services, DiscoveredService{
			Name:        "Grist",
			Type:        "app",
			SourcePaths: existingPaths("/opt/grist", "/persist/grist"),
			Priority:    "critical",
		})
	}

	// ── Media servers ─────────────────────────────────────────────────────────

	// Plex
	if hasProc(procs, "Plex Media Server") || dirExists("/var/lib/plexmediaserver") {
		services = append(services, DiscoveredService{
			Name:        "Plex Media Server",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/plexmediaserver/Library/Application Support/Plex Media Server"),
			Note:        "Metadata, database and preferences. Media files are separate.",
			Priority:    "recommended",
		})
	}

	// Jellyfin
	if hasProc(procs, "jellyfin") || dirExists("/var/lib/jellyfin") {
		services = append(services, DiscoveredService{
			Name:        "Jellyfin",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/jellyfin", "/etc/jellyfin"),
			Priority:    "recommended",
		})
	}

	// ── Game servers ──────────────────────────────────────────────────────────

	// Pterodactyl panel
	if dirExists("/var/www/pterodactyl") {
		services = append(services, DiscoveredService{
			Name:        "Pterodactyl Panel",
			Type:        "app",
			SourcePaths: existingPaths("/var/www/pterodactyl"),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction panel > /tmp/backuptool-pterodactyl-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-pterodactyl-db.sql`,
			Note:       "Panel files + DB. Wings node game data lives separately under /var/lib/pterodactyl on the daemon hosts.",
			Priority:   "critical",
		})
	}

	// Minecraft server
	if dirExists("/opt/minecraft") || dirExists("/home/minecraft") || dirExists("/var/games/minecraft") {
		mcRoot := firstExisting("/opt/minecraft", "/home/minecraft", "/var/games/minecraft")
		services = append(services, DiscoveredService{
			Name: "Minecraft Server",
			Type: "app",
			SourcePaths: existingPaths(
				mcRoot,
				filepath.Join(mcRoot, "world"),
				filepath.Join(mcRoot, "world_nether"),
				filepath.Join(mcRoot, "world_the_end"),
				filepath.Join(mcRoot, "plugins"),
				filepath.Join(mcRoot, "server.properties"),
			),
			Note:     "World data, plugins and server.properties. For consistency, run /save-off /save-all then /save-on inside the server console before backup.",
			Priority: "critical",
		})
	}

	// ── Automation & Low-code ─────────────────────────────────────────────────

	// n8n
	if hasProc(procs, "n8n") || dirExists("/home/node/.n8n") {
		n8nPath := firstExisting("/home/node/.n8n", "/var/lib/n8n", "/opt/n8n")
		services = append(services, DiscoveredService{
			Name:        "n8n",
			Type:        "app",
			SourcePaths: existingPaths(n8nPath),
			Note:        "Workflows, credentials and settings.",
			Priority:    "critical",
		})
	}

	// Netbox
	if dirExists("/opt/netbox") {
		services = append(services, DiscoveredService{
			Name:        "NetBox",
			Type:        "app",
			SourcePaths: existingPaths("/opt/netbox/netbox/media", "/opt/netbox/netbox/reports"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U netbox netbox > /tmp/backuptool-netbox-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-netbox-db.sql`,
			Priority:   "critical",
		})
	}

	// Gotify
	if hasProc(procs, "gotify") || dirExists("/var/lib/gotify") || dirExists("/app/data") {
		gPath := firstExisting("/var/lib/gotify", "/app/data")
		if gPath != "" {
			services = append(services, DiscoveredService{
				Name:        "Gotify",
				Type:        "app",
				SourcePaths: []string{gPath},
				Priority:    "recommended",
			})
		}
	}

	// ── Media / Content ───────────────────────────────────────────────────────

	// Navidrome
	if dirExists("/var/lib/navidrome") || dirExists("/opt/navidrome") {
		services = append(services, DiscoveredService{
			Name:        "Navidrome",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/navidrome", "/opt/navidrome"),
			Priority:    "recommended",
		})
	}

	// Audiobookshelf
	if dirExists("/var/lib/audiobookshelf") || dirExists("/opt/audiobookshelf") {
		services = append(services, DiscoveredService{
			Name:        "Audiobookshelf",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/audiobookshelf", "/opt/audiobookshelf", "/config/audiobookshelf"),
			Priority:    "recommended",
		})
	}

	// Kavita
	if dirExists("/opt/kavita") || dirExists("/kavita/config") {
		services = append(services, DiscoveredService{
			Name:        "Kavita",
			Type:        "app",
			SourcePaths: existingPaths("/opt/kavita", "/kavita/config"),
			Priority:    "recommended",
		})
	}

	// Komga
	if hasProc(procs, "komga") || dirExists("/opt/komga") || dirExists("/config/komga") {
		services = append(services, DiscoveredService{
			Name:        "Komga",
			Type:        "app",
			SourcePaths: existingPaths("/opt/komga", "/config/komga"),
			Priority:    "recommended",
		})
	}

	// Calibre-Web
	if hasProc(procs, "calibre-web") || dirExists("/var/lib/calibre-web") || dirExists("/opt/calibre-web") {
		services = append(services, DiscoveredService{
			Name:        "Calibre-Web",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/calibre-web", "/opt/calibre-web"),
			Priority:    "recommended",
		})
	}

	// Lychee (photo gallery)
	if dirExists("/var/www/lychee") || dirExists("/opt/lychee") {
		root := firstExisting("/var/www/lychee", "/opt/lychee")
		services = append(services, DiscoveredService{
			Name:        "Lychee",
			Type:        "app",
			SourcePaths: existingPaths(root, filepath.Join(root, "uploads"), filepath.Join(root, "public/uploads")),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction lychee > /tmp/backuptool-lychee-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-lychee-db.sql`,
			Priority:   "critical",
		})
	}

	// Photoview
	if dirExists("/var/lib/photoview") || dirExists("/opt/photoview") {
		services = append(services, DiscoveredService{
			Name:        "Photoview",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/photoview", "/opt/photoview"),
			Priority:    "critical",
		})
	}

	// Airsonic
	if dirExists("/var/airsonic") || dirExists("/var/lib/airsonic") {
		services = append(services, DiscoveredService{
			Name:        "Airsonic",
			Type:        "app",
			SourcePaths: existingPaths("/var/airsonic", "/var/lib/airsonic"),
			Priority:    "recommended",
		})
	}

	// OwnCast
	if hasProc(procs, "owncast") || dirExists("/opt/owncast") {
		services = append(services, DiscoveredService{
			Name:        "OwnCast",
			Type:        "app",
			SourcePaths: existingPaths("/opt/owncast/data", "/opt/owncast"),
			Priority:    "recommended",
		})
	}

	// Funkwhale
	if dirExists("/srv/funkwhale") {
		services = append(services, DiscoveredService{
			Name:        "Funkwhale",
			Type:        "app",
			SourcePaths: existingPaths("/srv/funkwhale/data", "/srv/funkwhale"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U funkwhale funkwhale > /tmp/backuptool-funkwhale-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-funkwhale-db.sql`,
			Priority:   "critical",
		})
	}

	// Castopod
	if dirExists("/var/www/castopod") {
		services = append(services, DiscoveredService{
			Name:        "Castopod",
			Type:        "app",
			SourcePaths: existingPaths("/var/www/castopod"),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction castopod > /tmp/backuptool-castopod-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-castopod-db.sql`,
			Priority:   "critical",
		})
	}

	// ── Fediverse / Social ────────────────────────────────────────────────────

	// Mastodon
	if dirExists("/home/mastodon/live") || dirExists("/opt/mastodon") {
		services = append(services, DiscoveredService{
			Name: "Mastodon",
			Type: "app",
			SourcePaths: existingPaths(
				"/home/mastodon/live/public/system",
				"/home/mastodon/live/.env.production",
				"/opt/mastodon",
			),
			PreScript: `#!/usr/bin/env bash
pg_dump -U mastodon mastodon_production > /tmp/backuptool-mastodon-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-mastodon-db.sql`,
			Note:       "Media, .env.production (secrets) and DB dump. Without the instance secrets, federation breaks.",
			Priority:   "critical",
		})
	}

	// PeerTube
	if dirExists("/var/www/peertube") {
		services = append(services, DiscoveredService{
			Name:        "PeerTube",
			Type:        "app",
			SourcePaths: existingPaths("/var/www/peertube/storage", "/var/www/peertube/config"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U peertube peertube_prod > /tmp/backuptool-peertube-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-peertube-db.sql`,
			Priority:   "critical",
		})
	}

	// Pixelfed
	if dirExists("/var/www/pixelfed") {
		services = append(services, DiscoveredService{
			Name:        "Pixelfed",
			Type:        "app",
			SourcePaths: existingPaths("/var/www/pixelfed/storage", "/var/www/pixelfed/.env"),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction pixelfed > /tmp/backuptool-pixelfed-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-pixelfed-db.sql`,
			Priority:   "critical",
		})
	}

	// Lemmy
	if dirExists("/srv/lemmy") || dirExists("/var/lib/lemmy") {
		services = append(services, DiscoveredService{
			Name:        "Lemmy",
			Type:        "app",
			SourcePaths: existingPaths("/srv/lemmy", "/var/lib/lemmy/pictrs", "/var/lib/lemmy"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U lemmy lemmy > /tmp/backuptool-lemmy-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-lemmy-db.sql`,
			Priority:   "critical",
		})
	}

	// Misskey / Calckey / Firefish
	if dirExists("/home/misskey/misskey") || dirExists("/opt/misskey") || dirExists("/opt/calckey") || dirExists("/opt/firefish") {
		services = append(services, DiscoveredService{
			Name:        "Misskey / Calckey / Firefish",
			Type:        "app",
			SourcePaths: existingPaths("/home/misskey/misskey", "/opt/misskey", "/opt/calckey", "/opt/firefish"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U misskey misskey > /tmp/backuptool-misskey-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-misskey-db.sql`,
			Priority:   "critical",
		})
	}

	// Pleroma / Akkoma
	if dirExists("/var/lib/pleroma") || dirExists("/opt/akkoma") {
		services = append(services, DiscoveredService{
			Name:        "Pleroma / Akkoma",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/pleroma", "/etc/pleroma", "/opt/akkoma"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U pleroma pleroma > /tmp/backuptool-pleroma-db.sql 2>/dev/null \
  || pg_dump -U akkoma akkoma > /tmp/backuptool-pleroma-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-pleroma-db.sql`,
			Priority:   "critical",
		})
	}

	// ── Communication / Collaboration ─────────────────────────────────────────

	// Discourse
	if dirExists("/var/discourse") {
		services = append(services, DiscoveredService{
			Name:        "Discourse",
			Type:        "app",
			SourcePaths: existingPaths("/var/discourse/shared"),
			Note:        "Shared volume contains uploads, backups and DB (standalone container).",
			Priority:    "critical",
		})
	}

	// Flarum
	if dirExists("/var/www/flarum") {
		services = append(services, DiscoveredService{
			Name:        "Flarum",
			Type:        "app",
			SourcePaths: existingPaths("/var/www/flarum"),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction flarum > /tmp/backuptool-flarum-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-flarum-db.sql`,
			Priority:   "critical",
		})
	}

	// Jitsi Meet
	if dirExists("/etc/jitsi") || hasProc(procs, "jicofo") {
		services = append(services, DiscoveredService{
			Name:        "Jitsi Meet",
			Type:        "app",
			SourcePaths: existingPaths("/etc/jitsi", "/etc/prosody"),
			Priority:    "recommended",
		})
	}

	// HedgeDoc
	if dirExists("/opt/hedgedoc") || dirExists("/var/lib/hedgedoc") {
		root := firstExisting("/opt/hedgedoc", "/var/lib/hedgedoc")
		services = append(services, DiscoveredService{
			Name:        "HedgeDoc",
			Type:        "app",
			SourcePaths: existingPaths(root, filepath.Join(root, "uploads")),
			PreScript: `#!/usr/bin/env bash
pg_dump -U hedgedoc hedgedoc > /tmp/backuptool-hedgedoc-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-hedgedoc-db.sql`,
			Priority:   "critical",
		})
	}

	// Etherpad
	if dirExists("/opt/etherpad-lite") || dirExists("/var/lib/etherpad") {
		services = append(services, DiscoveredService{
			Name:        "Etherpad",
			Type:        "app",
			SourcePaths: existingPaths("/opt/etherpad-lite/var", "/var/lib/etherpad"),
			Priority:    "critical",
		})
	}

	// CryptPad
	if dirExists("/opt/cryptpad") {
		services = append(services, DiscoveredService{
			Name:        "CryptPad",
			Type:        "app",
			SourcePaths: existingPaths("/opt/cryptpad/data", "/opt/cryptpad/datastore", "/opt/cryptpad/blob", "/opt/cryptpad/block"),
			Note:        "End-to-end encrypted — loss of data = loss of all documents.",
			Priority:    "critical",
		})
	}

	// ── RSS / Reading ─────────────────────────────────────────────────────────

	// Wallabag
	if dirExists("/var/www/wallabag") {
		services = append(services, DiscoveredService{
			Name:        "Wallabag",
			Type:        "app",
			SourcePaths: existingPaths("/var/www/wallabag/data", "/var/www/wallabag/app/config"),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction wallabag > /tmp/backuptool-wallabag-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-wallabag-db.sql`,
			Priority:   "critical",
		})
	}

	// FreshRSS
	if dirExists("/var/www/freshrss") || dirExists("/var/www/FreshRSS") {
		root := firstExisting("/var/www/freshrss", "/var/www/FreshRSS")
		services = append(services, DiscoveredService{
			Name:        "FreshRSS",
			Type:        "app",
			SourcePaths: existingPaths(root, filepath.Join(root, "data")),
			Priority:    "critical",
		})
	}

	// Miniflux
	if hasProc(procs, "miniflux") || dirExists("/etc/miniflux.conf") {
		services = append(services, DiscoveredService{
			Name:        "Miniflux",
			Type:        "app",
			SourcePaths: existingPaths("/etc/miniflux.conf"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U miniflux miniflux > /tmp/backuptool-miniflux-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-miniflux-db.sql`,
			Priority:   "critical",
		})
	}

	// Tiny Tiny RSS
	if dirExists("/var/www/tt-rss") {
		services = append(services, DiscoveredService{
			Name:        "Tiny Tiny RSS",
			Type:        "app",
			SourcePaths: existingPaths("/var/www/tt-rss"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U ttrss ttrss > /tmp/backuptool-ttrss-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-ttrss-db.sql`,
			Priority:   "recommended",
		})
	}

	// ── Finance / ERP / Productivity ──────────────────────────────────────────

	// Firefly III
	if dirExists("/var/www/firefly-iii") || dirExists("/opt/firefly-iii") {
		root := firstExisting("/var/www/firefly-iii", "/opt/firefly-iii")
		services = append(services, DiscoveredService{
			Name:        "Firefly III",
			Type:        "app",
			SourcePaths: existingPaths(root, filepath.Join(root, "storage")),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction firefly > /tmp/backuptool-firefly-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-firefly-db.sql`,
			Priority:   "critical",
		})
	}

	// Grocy
	if dirExists("/var/www/grocy") || dirExists("/opt/grocy") {
		root := firstExisting("/var/www/grocy", "/opt/grocy")
		services = append(services, DiscoveredService{
			Name:        "Grocy",
			Type:        "app",
			SourcePaths: existingPaths(root, filepath.Join(root, "data")),
			Priority:    "critical",
		})
	}

	// Actual Budget
	if dirExists("/opt/actual") || dirExists("/data/server-files") {
		services = append(services, DiscoveredService{
			Name:        "Actual Budget",
			Type:        "app",
			SourcePaths: existingPaths("/opt/actual", "/data/server-files", "/data/user-files"),
			Priority:    "critical",
		})
	}

	// Odoo
	if hasProc(procs, "odoo") || dirExists("/var/lib/odoo") {
		services = append(services, DiscoveredService{
			Name:        "Odoo",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/odoo", "/etc/odoo"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U odoo odoo > /tmp/backuptool-odoo-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-odoo-db.sql`,
			Priority:   "critical",
		})
	}

	// Kimai
	if dirExists("/var/www/kimai") {
		services = append(services, DiscoveredService{
			Name:        "Kimai",
			Type:        "app",
			SourcePaths: existingPaths("/var/www/kimai/var"),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction kimai > /tmp/backuptool-kimai-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-kimai-db.sql`,
			Priority:   "recommended",
		})
	}

	// Tandoor Recipes
	if dirExists("/opt/recipes") || dirExists("/var/lib/tandoor") {
		root := firstExisting("/opt/recipes", "/var/lib/tandoor")
		services = append(services, DiscoveredService{
			Name:        "Tandoor Recipes",
			Type:        "app",
			SourcePaths: existingPaths(root, filepath.Join(root, "mediafiles")),
			PreScript: `#!/usr/bin/env bash
pg_dump -U djangouser djangodb > /tmp/backuptool-tandoor-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-tandoor-db.sql`,
			Priority:   "recommended",
		})
	}

	// ── Security / Monitoring ─────────────────────────────────────────────────

	// Wazuh
	if hasProc(procs, "wazuh-manager") || dirExists("/var/ossec") {
		services = append(services, DiscoveredService{
			Name:        "Wazuh",
			Type:        "app",
			SourcePaths: existingPaths("/var/ossec/etc", "/var/ossec/logs", "/var/ossec/queue"),
			Priority:    "critical",
		})
	}

	// Graylog
	if hasProc(procs, "graylog") || dirExists("/etc/graylog") {
		services = append(services, DiscoveredService{
			Name:        "Graylog",
			Type:        "app",
			SourcePaths: existingPaths("/etc/graylog", "/var/lib/graylog-server"),
			Priority:    "critical",
		})
	}

	// Authelia
	if hasProc(procs, "authelia") || dirExists("/etc/authelia") {
		services = append(services, DiscoveredService{
			Name:        "Authelia",
			Type:        "app",
			SourcePaths: existingPaths("/etc/authelia", "/var/lib/authelia"),
			Note:        "Auth secrets / user DB. Loss locks users out of protected apps.",
			Priority:    "critical",
		})
	}

	// Greenbone / OpenVAS
	if hasProc(procs, "gvmd") || dirExists("/var/lib/gvm") {
		services = append(services, DiscoveredService{
			Name:        "Greenbone / OpenVAS",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/gvm", "/var/lib/openvas"),
			Priority:    "recommended",
		})
	}

	// LibreNMS
	if dirExists("/opt/librenms") {
		services = append(services, DiscoveredService{
			Name:        "LibreNMS",
			Type:        "app",
			SourcePaths: existingPaths("/opt/librenms/rrd", "/opt/librenms/config.php", "/opt/librenms/logs"),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction librenms > /tmp/backuptool-librenms-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-librenms-db.sql`,
			Priority:   "critical",
		})
	}

	// Checkmk
	if dirExists("/omd/sites") {
		services = append(services, DiscoveredService{
			Name:        "Checkmk",
			Type:        "app",
			SourcePaths: existingPaths("/omd/sites", "/etc/check_mk"),
			Priority:    "critical",
		})
	}

	// ── Network / DNS (self-hosted) ───────────────────────────────────────────

	// AdGuard Home
	if hasProc(procs, "AdGuardHome") || dirExists("/opt/AdGuardHome") {
		services = append(services, DiscoveredService{
			Name:        "AdGuard Home",
			Type:        "app",
			SourcePaths: existingPaths("/opt/AdGuardHome", "/var/lib/AdGuardHome"),
			Priority:    "critical",
		})
	}

	// Pi-hole
	if dirExists("/etc/pihole") {
		services = append(services, DiscoveredService{
			Name:        "Pi-hole",
			Type:        "app",
			SourcePaths: existingPaths("/etc/pihole"),
			Priority:    "critical",
		})
	}

	// Nginx Proxy Manager
	if dirExists("/data/nginx") || dirExists("/opt/nginx-proxy-manager") {
		services = append(services, DiscoveredService{
			Name:        "Nginx Proxy Manager",
			Type:        "app",
			SourcePaths: existingPaths("/data", "/opt/nginx-proxy-manager"),
			Note:        "Proxy hosts, SSL certs and admin DB live in /data.",
			Priority:    "critical",
		})
	}

	// Netmaker
	if hasProc(procs, "netmaker") || dirExists("/etc/netmaker") {
		services = append(services, DiscoveredService{
			Name:        "Netmaker",
			Type:        "app",
			SourcePaths: existingPaths("/etc/netmaker", "/root/netmaker"),
			Priority:    "critical",
		})
	}

	// Technitium DNS
	if hasProc(procs, "DnsServerApp") || dirExists("/etc/dns") || dirExists("/opt/technitium") {
		services = append(services, DiscoveredService{
			Name:        "Technitium DNS",
			Type:        "app",
			SourcePaths: existingPaths("/etc/dns", "/opt/technitium"),
			Priority:    "critical",
		})
	}

	// ── Remote Access ─────────────────────────────────────────────────────────

	// Apache Guacamole
	if dirExists("/etc/guacamole") || hasProc(procs, "guacd") {
		services = append(services, DiscoveredService{
			Name:        "Apache Guacamole",
			Type:        "app",
			SourcePaths: existingPaths("/etc/guacamole", "/var/lib/guacamole"),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction guacamole_db > /tmp/backuptool-guacamole-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-guacamole-db.sql`,
			Priority:   "critical",
		})
	}

	// Rustdesk
	if hasProc(procs, "hbbs") || dirExists("/var/lib/rustdesk-server") {
		services = append(services, DiscoveredService{
			Name:        "Rustdesk Server",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/rustdesk-server", "/root/.config/rustdesk"),
			Note:        "Server keys — losing them breaks all existing client pairings.",
			Priority:    "critical",
		})
	}

	// Teleport
	if hasProc(procs, "teleport") || dirExists("/var/lib/teleport") {
		services = append(services, DiscoveredService{
			Name:        "Teleport",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/teleport", "/etc/teleport.yaml"),
			Priority:    "critical",
		})
	}

	// MeshCentral
	if dirExists("/opt/meshcentral") || dirExists("/meshcentral-data") {
		services = append(services, DiscoveredService{
			Name:        "MeshCentral",
			Type:        "app",
			SourcePaths: existingPaths("/opt/meshcentral/meshcentral-data", "/meshcentral-data", "/meshcentral-files"),
			Priority:    "critical",
		})
	}

	// ── CI/CD / Development ───────────────────────────────────────────────────

	// Drone CI
	if hasProc(procs, "drone") || dirExists("/var/lib/drone") {
		services = append(services, DiscoveredService{
			Name:        "Drone CI",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/drone"),
			Priority:    "recommended",
		})
	}

	// Woodpecker CI
	if hasProc(procs, "woodpecker-server") || dirExists("/var/lib/woodpecker") {
		services = append(services, DiscoveredService{
			Name:        "Woodpecker CI",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/woodpecker"),
			Priority:    "recommended",
		})
	}

	// Gogs
	if dirExists("/var/lib/gogs") || dirExists("/home/git/gogs") {
		services = append(services, DiscoveredService{
			Name:        "Gogs",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/gogs", "/home/git/gogs", "/etc/gogs"),
			Priority:    "critical",
		})
	}

	// Gitbucket
	if dirExists("/root/.gitbucket") || dirExists("/var/lib/gitbucket") {
		services = append(services, DiscoveredService{
			Name:        "Gitbucket",
			Type:        "app",
			SourcePaths: existingPaths("/root/.gitbucket", "/var/lib/gitbucket"),
			Priority:    "critical",
		})
	}

	// Windmill
	if hasProc(procs, "windmill") || dirExists("/opt/windmill") {
		services = append(services, DiscoveredService{
			Name:        "Windmill",
			Type:        "app",
			SourcePaths: existingPaths("/opt/windmill"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U windmill windmill > /tmp/backuptool-windmill-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-windmill-db.sql`,
			Priority:   "critical",
		})
	}

	// ── Low-Code / Automation ─────────────────────────────────────────────────

	// NocoDB
	if dirExists("/usr/app/data") || dirExists("/var/lib/nocodb") {
		services = append(services, DiscoveredService{
			Name:        "NocoDB",
			Type:        "app",
			SourcePaths: existingPaths("/usr/app/data", "/var/lib/nocodb"),
			Priority:    "critical",
		})
	}

	// PocketBase
	if hasProc(procs, "pocketbase") || dirExists("/pb_data") || dirExists("/opt/pocketbase") {
		services = append(services, DiscoveredService{
			Name:        "PocketBase",
			Type:        "app",
			SourcePaths: existingPaths("/pb_data", "/opt/pocketbase/pb_data", "/opt/pocketbase"),
			Priority:    "critical",
		})
	}

	// Activepieces
	if dirExists("/opt/activepieces") || dirExists("/var/lib/activepieces") {
		services = append(services, DiscoveredService{
			Name:        "Activepieces",
			Type:        "app",
			SourcePaths: existingPaths("/opt/activepieces", "/var/lib/activepieces"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U activepieces activepieces > /tmp/backuptool-activepieces-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-activepieces-db.sql`,
			Priority:   "critical",
		})
	}

	// Node-RED
	if hasProc(procs, "node-red") || dirExists("/root/.node-red") || dirExists("/home/node-red/.node-red") {
		services = append(services, DiscoveredService{
			Name:        "Node-RED",
			Type:        "app",
			SourcePaths: existingPaths("/root/.node-red", "/home/node-red/.node-red"),
			Priority:    "recommended",
		})
	}

	// Stirling PDF
	if dirExists("/opt/stirling-pdf") || dirExists("/configs") {
		services = append(services, DiscoveredService{
			Name:        "Stirling PDF",
			Type:        "app",
			SourcePaths: existingPaths("/opt/stirling-pdf/configs", "/opt/stirling-pdf/customFiles", "/configs"),
			Priority:    "recommended",
		})
	}

	// ── Helpdesk / CRM ────────────────────────────────────────────────────────

	// Chatwoot
	if dirExists("/var/www/chatwoot") || dirExists("/opt/chatwoot") {
		root := firstExisting("/var/www/chatwoot", "/opt/chatwoot")
		services = append(services, DiscoveredService{
			Name:        "Chatwoot",
			Type:        "app",
			SourcePaths: existingPaths(root, filepath.Join(root, "storage")),
			PreScript: `#!/usr/bin/env bash
pg_dump -U chatwoot chatwoot_production > /tmp/backuptool-chatwoot-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-chatwoot-db.sql`,
			Priority:   "critical",
		})
	}

	// Zammad
	if dirExists("/opt/zammad") || dirExists("/var/lib/zammad") {
		services = append(services, DiscoveredService{
			Name:        "Zammad",
			Type:        "app",
			SourcePaths: existingPaths("/opt/zammad/storage", "/opt/zammad/config", "/var/lib/zammad"),
			PreScript: `#!/usr/bin/env bash
pg_dump -U zammad zammad_production > /tmp/backuptool-zammad-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-zammad-db.sql`,
			Priority:   "critical",
		})
	}

	// osTicket
	if dirExists("/var/www/osticket") || dirExists("/var/www/html/upload") {
		services = append(services, DiscoveredService{
			Name:        "osTicket",
			Type:        "app",
			SourcePaths: existingPaths("/var/www/osticket", "/var/www/html/upload"),
			PreScript: `#!/usr/bin/env bash
mysqldump --single-transaction osticket > /tmp/backuptool-osticket-db.sql 2>/dev/null || true`,
			PostScript: `rm -f /tmp/backuptool-osticket-db.sql`,
			Priority:   "critical",
		})
	}

	// ── Infrastructure tools ──────────────────────────────────────────────────

	// Consul
	if hasProc(procs, "consul") || dirExists("/var/lib/consul") {
		services = append(services, DiscoveredService{
			Name:        "Consul",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/consul", "/etc/consul.d"),
			Priority:    "recommended",
		})
	}

	// Nomad
	if hasProc(procs, "nomad") || dirExists("/var/lib/nomad") {
		services = append(services, DiscoveredService{
			Name:        "Nomad",
			Type:        "app",
			SourcePaths: existingPaths("/var/lib/nomad", "/etc/nomad.d"),
			Priority:    "recommended",
		})
	}

	// etcd
	if hasProc(procs, "etcd") || dirExists("/var/lib/etcd") {
		services = append(services, DiscoveredService{
			Name:        "etcd",
			Type:        "database",
			SourcePaths: existingPaths("/var/lib/etcd"),
			Note:        "etcd data directory. Use etcdctl snapshot for online backups.",
			Priority:    "critical",
		})
	}

	// Kubernetes
	if dirExists("/etc/kubernetes") || dirExists("/var/lib/kubelet") {
		services = append(services, DiscoveredService{
			Name:        "Kubernetes",
			Type:        "app",
			SourcePaths: existingPaths("/etc/kubernetes", "/var/lib/kubelet"),
			Note:        "Cluster configs and manifests. Consider also backing up etcd.",
			Priority:    "critical",
		})
	}

	// Ansible
	if dirExists("/etc/ansible") {
		services = append(services, DiscoveredService{
			Name:        "Ansible",
			Type:        "app",
			SourcePaths: existingPaths("/etc/ansible"),
			Priority:    "recommended",
		})
	}

	// ── SSL Certificates ─────────────────────────────────────────────────────

	if dirExists("/etc/letsencrypt") {
		services = append(services, DiscoveredService{
			Name:        "Let's Encrypt Certificates",
			Type:        "certs",
			SourcePaths: []string{"/etc/letsencrypt"},
			Note:        "Certificates and private keys. Losing these requires re-issuance.",
			Priority:    "critical",
		})
	}
	if dirExists("/etc/ssl/private") || dirExists("/etc/ssl/certs") {
		services = append(services, DiscoveredService{
			Name:        "SSL/TLS Certificates",
			Type:        "certs",
			SourcePaths: existingPaths("/etc/ssl/private", "/etc/ssl/certs"),
			Priority:    "critical",
		})
	}

	// ── System safety-net ─────────────────────────────────────────────────────
	// These are always backed up regardless of what other services are found.

	services = append(services, unixSafetyNet()...)

	// ── Large directory scan ──────────────────────────────────────────────────
	// Find big directories that aren't already covered by a specific service.

	services = append(services, largeDirectoryScan(services)...)

	return services
}

// unixSafetyNet returns the baseline set of paths that should always be
// backed up on any Unix/Linux system.
func unixSafetyNet() []DiscoveredService {
	var out []DiscoveredService

	// System configuration
	if dirExists("/etc") {
		out = append(out, DiscoveredService{
			Name:        "System Configuration (/etc)",
			Type:        "system",
			SourcePaths: []string{"/etc"},
			Note:        "All system-wide configuration files. Essential for disaster recovery.",
			Priority:    "critical",
		})
	}

	// User home directories
	homePaths := existingPaths("/home", "/root")
	if len(homePaths) > 0 {
		out = append(out, DiscoveredService{
			Name:        "User Home Directories",
			Type:        "system",
			SourcePaths: homePaths,
			Note:        "User data, dotfiles, SSH keys, application data in home dirs.",
			Priority:    "critical",
		})
	}

	// Web server roots (anything in /var/www not already covered)
	if dirExists("/var/www") {
		out = append(out, DiscoveredService{
			Name:        "Web Root (/var/www)",
			Type:        "system",
			SourcePaths: []string{"/var/www"},
			Note:        "All web application files served by nginx/apache.",
			Priority:    "recommended",
		})
	}

	// Custom application data
	for _, p := range []string{"/opt", "/srv", "/app", "/apps"} {
		if dirExists(p) {
			out = append(out, DiscoveredService{
				Name:        "Application Data (" + p + ")",
				Type:        "system",
				SourcePaths: []string{p},
				Priority:    "recommended",
			})
		}
	}

	// Crontabs
	cronPaths := existingPaths("/var/spool/cron", "/var/spool/cron/crontabs", "/etc/cron.d", "/etc/cron.daily", "/etc/cron.weekly")
	if len(cronPaths) > 0 {
		out = append(out, DiscoveredService{
			Name:        "Cron Jobs",
			Type:        "system",
			SourcePaths: cronPaths,
			Priority:    "recommended",
		})
	}

	// Systemd unit overrides / drop-ins
	if dirExists("/etc/systemd/system") {
		out = append(out, DiscoveredService{
			Name:        "Systemd Service Units",
			Type:        "system",
			SourcePaths: []string{"/etc/systemd/system"},
			Priority:    "recommended",
		})
	}

	return out
}

// ── Windows scan ─────────────────────────────────────────────────────────────

func scanWindows() []DiscoveredService {
	var services []DiscoveredService

	// User profile directories
	userProfile := os.Getenv("USERPROFILE")
	if userProfile == "" {
		userProfile = `C:\Users`
	}
	services = append(services, DiscoveredService{
		Name:        "User Profiles",
		Type:        "system",
		SourcePaths: []string{`C:\Users`},
		Priority:    "critical",
	})

	// Desktop / Documents / Downloads
	if userProfile != "" {
		services = append(services, DiscoveredService{
			Name:        "User Documents",
			Type:        "system",
			SourcePaths: existingPaths(
				filepath.Join(userProfile, "Documents"),
				filepath.Join(userProfile, "Desktop"),
				filepath.Join(userProfile, "Downloads"),
			),
			Priority: "recommended",
		})
	}

	// IIS web roots
	for _, p := range []string{`C:\inetpub\wwwroot`, `C:\inetpub`} {
		if dirExists(p) {
			services = append(services, DiscoveredService{
				Name: "IIS Web Root", Type: "app",
				SourcePaths: []string{p}, Priority: "critical",
			})
			break
		}
	}

	// SQL Server (detect data directory from registry or default path)
	sqlPaths := existingPaths(
		`C:\Program Files\Microsoft SQL Server`,
		`C:\Program Files (x86)\Microsoft SQL Server`,
	)
	if len(sqlPaths) > 0 {
		services = append(services, DiscoveredService{
			Name:        "Microsoft SQL Server",
			Type:        "database",
			SourcePaths: sqlPaths,
			Note:        "Ensure SQL Server VSS writer is enabled for consistent backups.",
			Priority:    "critical",
		})
	}

	// Program Files / ProgramData
	services = append(services, DiscoveredService{
		Name:        "Application Data (ProgramData)",
		Type:        "system",
		SourcePaths: existingPaths(`C:\ProgramData`),
		Priority:    "recommended",
	})

	return services
}

// largeDirectoryScan uses `du` to find directories that are larger than 500 MB
// under common roots (/var, /opt, /home, /srv, /app, /data, /mnt) and returns
// them as "optional" backup targets — but only if they are not already covered
// by paths from the known-service scan.
func largeDirectoryScan(known []DiscoveredService) []DiscoveredService {
	if runtime.GOOS != "linux" {
		return nil
	}

	// Build a set of path prefixes already covered by known services.
	covered := map[string]struct{}{}
	for _, svc := range known {
		for _, p := range svc.SourcePaths {
			covered[filepath.Clean(p)] = struct{}{}
		}
	}

	isCovered := func(p string) bool {
		clean := filepath.Clean(p)
		// Check if the path itself or any parent is already covered.
		for cp := range covered {
			if clean == cp || strings.HasPrefix(clean, cp+"/") {
				return true
			}
		}
		return false
	}

	// Scan roots with du --max-depth=1 to get direct child sizes in KB.
	roots := []string{"/var", "/opt", "/home", "/srv", "/app", "/data", "/mnt", "/media"}
	const minSizeKB = 512 * 1024 // 512 MB

	var out []DiscoveredService
	seen := map[string]struct{}{}

	for _, root := range roots {
		if !dirExists(root) {
			continue
		}
		raw, err := exec.Command("du", "--max-depth=1", "--block-size=1024", root).Output()
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(strings.NewReader(string(raw)))
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			parts := strings.Fields(line)
			if len(parts) < 2 {
				continue
			}
			var sizeKB int64
			fmt.Sscanf(parts[0], "%d", &sizeKB)
			dir := parts[1]
			if dir == root {
				continue // skip the root itself
			}
			if sizeKB < minSizeKB {
				continue
			}
			if isCovered(dir) {
				continue
			}
			if _, ok := seen[dir]; ok {
				continue
			}
			seen[dir] = struct{}{}
			sizeMB := sizeKB / 1024
			out = append(out, DiscoveredService{
				Name:        fmt.Sprintf("Large directory (%s)", dir),
				Type:        "system",
				SourcePaths: []string{dir},
				Note:        fmt.Sprintf("Directory is ~%d MB and not covered by any known service. Review and add to a backup job if it contains important data.", sizeMB),
				Priority:    "optional",
			})
		}
	}
	return out
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// runningProcesses returns a set of currently-running process names (basename only).
func runningProcesses() map[string]struct{} {
	procs := map[string]struct{}{}
	if runtime.GOOS == "windows" {
		return procs // not implemented; rely on directory detection instead
	}
	// Read /proc/*/comm (Linux) or use `ps` (macOS/BSD)
	if runtime.GOOS == "linux" {
		entries, _ := filepath.Glob("/proc/*/comm")
		for _, e := range entries {
			data, err := os.ReadFile(e)
			if err == nil {
				procs[strings.TrimSpace(string(data))] = struct{}{}
			}
		}
	} else {
		out, err := exec.Command("ps", "-eo", "comm").Output()
		if err == nil {
			sc := bufio.NewScanner(strings.NewReader(string(out)))
			for sc.Scan() {
				procs[strings.TrimSpace(sc.Text())] = struct{}{}
			}
		}
	}
	return procs
}

func hasProc(procs map[string]struct{}, name string) bool {
	_, ok := procs[name]
	return ok
}

func hasBin(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func dirExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

func firstExisting(paths ...string) string {
	for _, p := range paths {
		if dirExists(p) {
			return p
		}
	}
	return ""
}

func existingPaths(paths ...string) []string {
	var out []string
	for _, p := range paths {
		if dirExists(p) {
			out = append(out, p)
		}
	}
	return out
}

// redisDataDir tries to read the Redis data directory from its config file.
func redisDataDir() string {
	for _, cfgPath := range []string{"/etc/redis/redis.conf", "/etc/redis.conf", "/usr/local/etc/redis.conf"} {
		f, err := os.Open(cfgPath)
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if strings.HasPrefix(line, "dir ") {
				f.Close()
				return strings.TrimPrefix(line, "dir ")
			}
		}
		f.Close()
	}
	return ""
}

// readNextcloudDataDir reads the datadirectory from Nextcloud's config.php.
func readNextcloudDataDir(ncRoot string) string {
	cfgPath := filepath.Join(ncRoot, "config", "config.php")
	f, err := os.Open(cfgPath)
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.Contains(line, "'datadirectory'") {
			// e.g.  'datadirectory' => '/mnt/data/nextcloud',
			parts := strings.Split(line, "=>")
			if len(parts) == 2 {
				dir := strings.Trim(strings.TrimSpace(parts[1]), "', ")
				return dir
			}
		}
	}
	return ""
}

// dockerComposePaths finds directories that contain a docker-compose.yml file
// within a reasonable depth under /srv, /opt, /home, /var/www.
func dockerComposePaths() []string {
	var dirs []string
	seen := map[string]struct{}{}
	for _, root := range []string{"/srv", "/opt", "/home", "/var/www", "/app"} {
		found := findFiles(root, "docker-compose.yml", 3)
		found = append(found, findFiles(root, "compose.yml", 3)...)
		for _, f := range found {
			d := filepath.Dir(f)
			if _, ok := seen[d]; !ok {
				seen[d] = struct{}{}
				dirs = append(dirs, d)
			}
		}
	}
	return dirs
}

// findFiles recursively searches root for files named name up to maxDepth levels deep.
func findFiles(root, name string, maxDepth int) []string {
	var found []string
	if maxDepth <= 0 || !dirExists(root) {
		return found
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return found
	}
	for _, e := range entries {
		p := filepath.Join(root, e.Name())
		if !e.IsDir() && e.Name() == name {
			found = append(found, p)
		} else if e.IsDir() {
			found = append(found, findFiles(p, name, maxDepth-1)...)
		}
	}
	return found
}
