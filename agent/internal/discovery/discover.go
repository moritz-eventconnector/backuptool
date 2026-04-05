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

	// ── Docker ───────────────────────────────────────────────────────────────

	if hasBin("docker") && dirExists("/var/lib/docker") {
		services = append(services, DiscoveredService{
			Name:        "Docker Volumes",
			Type:        "docker",
			SourcePaths: []string{"/var/lib/docker/volumes"},
			PreScript: `#!/usr/bin/env bash
# Stop all running containers for consistent volume backup.
# Comment this out if you prefer a live (fuzzy) backup.
docker stop $(docker ps -q) 2>/dev/null || true`,
			PostScript: `docker start $(docker ps -aq) 2>/dev/null || true`,
			Note:       "Backs up all named Docker volumes. Containers are stopped during backup for consistency.",
			Priority:   "critical",
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

	// Keycloak
	if dirExists("/opt/keycloak") || hasProc(procs, "keycloak") {
		services = append(services, DiscoveredService{
			Name:        "Keycloak",
			Type:        "app",
			SourcePaths: existingPaths("/opt/keycloak/data", "/var/lib/keycloak"),
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
			Note:        "Includes docker-compose.yml, .env and all mail data.",
			Priority:    "critical",
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

	// Plane (project management)
	if dirExists("/opt/plane") {
		services = append(services, DiscoveredService{
			Name:        "Plane",
			Type:        "app",
			SourcePaths: existingPaths("/opt/plane"),
			Priority:    "critical",
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
