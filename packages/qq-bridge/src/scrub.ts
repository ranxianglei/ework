// Outbound text hygiene: never leak internal hostnames/IPs into QQ groups.
// IP ranges are always scrubbed (RFC1918); hostnames come from env so the
// published package carries no real infrastructure names (same policy as
// ework-mirror).

const IP_PATTERNS = [
  /192\.168\.\d{1,3}\.\d{1,3}/g,
  /10\.\d{1,3}\.\d{1,3}\.\d{1,3}/g,
  /172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}/g,
];

export function buildScrubber(hosts: string[]): (text: string) => string {
  const hostPatterns = hosts
    .map((h) => h.trim())
    .filter((h) => h.length > 0)
    .map((h) => ({ re: new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), h }));
  return (text: string): string => {
    let out = text;
    for (const p of IP_PATTERNS) out = out.replace(p, "[内网IP]");
    for (const { re, h } of hostPatterns) {
      if (h.includes(out)) continue;
      out = out.replace(re, "[内部主机]");
    }
    return out;
  };
}
