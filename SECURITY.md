# Security Policy

## Scope

dsh-sentinel runs inside a DeepSeek Harness process and adds four HTTP routes under `/plugins/dsh-sentinel/*` on the web server. The security-relevant surfaces are:

- **Route trust fence** — browser-marked cross-site requests (a malicious page form-POSTing to localhost) and DNS-rebinding attempts (Host/Origin naming a DNS host) are rejected with 403. Headerless clients such as `curl` and CI jobs pass by design.
- **Webhook watch URLs** (`POST …/hook?id=…&s=…`) — anyone holding the full URL can fire that watch. Ids are per-session and full URLs are handed out only through the `sentinel_watch` tool; treat them as secrets.
- **`command` sensor** — executes its configured read-only shell line on the host at every probe. It originates from the harness's own trust domain (agent/user), the same boundary the host draws for its shell tools.
- **`notifyWebhookUrl` egress** — fire metadata is POSTed as JSON to the configured receiver; it never gates the in-harness wakeup.

## Reporting

Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Please do not open public issues for anything security-sensitive. Include the plugin version, the `dsh` host version, the route or surface involved, and a request shape or log excerpt if you have one.
