#!/usr/bin/env python3
"""2026-11-11 (owner policy: issue 根因归类): the root-cause classification board.

Consumes the classifier-worker's structured replies (fenced ```classifier-json
blocks) posted on the project's ANCHOR thread (GH issue, body contains
[no-dispatch]), merges them across rounds (latest object per issue number wins),
enriches every row with live CI / merge state straight from the mirror DB
(zero REST fan-out — the REST budget stays <=10 req/min, same discipline as
ework-status-board.py), renders a discussion board, and — when one root-cause
category covers >=2 open issues — creates (or updates) a [Root Cause] aggregation
issue tagged root-cause-batch. The aggregation issue then flows through the
NORMAL dispatch pipeline (no special lane) and produces one root-cause PR with
a "Fixes #..." list; merging it closes the batch at once. Exception
(owner policy 2026-11-12): the tinyfix category gets NO aggregation issue —
its members are only suppressed (bot stopped), no ticket.

REST usage per run: anchor comments (1 page, newest first) + discussion
create/update (GQL, 2) + aggregation issues list/create/update (<= few).
All mirror data comes from the local sqlite DB.
"""
import json, os, re, sqlite3, sys, time, urllib.request, urllib.error

import fcntl
_lk = open("/var/lib/ework-web/share/board-classifier.lock", "w")
try:
    fcntl.flock(_lk, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    print("classifier-board: previous run still active, skipping")
    sys.exit(0)

REPO = "ranxianglei/billion-context"
PAT = open("/root/ework-gh-pat").read().strip()
PROXY = "http://192.168.10.157:20210" if False else "http://192.168.10.157:20176"
STATE = "/var/lib/ework-web/share/status-board-classifier.json"
DB = "/var/lib/ework-web/share/ework-web/ework.db"
BOARD_TITLE = "Issue 根因归类板（自动维护，勿手编）"
AGG_LABEL = "root-cause-batch"
# owner policy 2026-11-11: >=2 open issues of the same root cause get a
# [Root Cause] aggregation issue that goes through the normal pipeline.
AGG_THRESHOLD = 2
# owner policy 2026-11-12 (dedup rework): aggregation issues are identified by a
# STABLE TOKEN, never by title/regex matching. token == the category name
# (owner decision), embedded as an HTML comment in the issue body AND recorded
# in a sqlite DB (authoritative). Titles are English-only and purely cosmetic.
RCAGG_DB = "/var/lib/ework-web/share/rc-agg.db"
ABSORBED_LABEL = "已被收"
ABSORBED_COMMENT = (
    "（已收）本单已归入根因聚合 issue（token 见该单 body），机器人已停止在本单上的工作，"
    "修复走聚合 issue 统一出 PR；本单保留不关，修复验证后统一关闭。"
)

def rcagg_token(cat):
    return f"rcagg:{(cat or '').strip()}"

def rcagg_marker(cat):
    return f"<!-- {rcagg_token(cat)} -->"

def rcdb():
    c = sqlite3.connect(RCAGG_DB)
    c.execute("CREATE TABLE IF NOT EXISTS rc_agg ("
              "category TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, "
              "issue_number INTEGER NOT NULL, updated_at TEXT)")
    return c

def rc_lookup(cat):
    """Resolve the live aggregation issue for a category (else None). Chain:
    rc-agg.db number -> gh_rest verify -> body-marker scan of open labelled
    issues. Invariants:
    - confirmed CLOSED upstream -> record deleted, None returned, so a fully
      closed set gets a FRESH issue (owner policy: never reuse/reopen);
    - transient API failure (rate limit / network) -> DB number returned as an
      unverified dict so update_agg PATCHes it (repairing body/marker) instead
      of CREATE-duplicating while GitHub is down; the 2026-11-12 incident was
      exactly "dedup check blind -> duplicate batch", never repeat it via outage;
    - open but marker stripped from body -> same unverified repair path."""
    try:
        c = rcdb()
        row = c.execute("SELECT issue_number FROM rc_agg WHERE category=?", (cat,)).fetchone()
        c.close()
        if not row:
            return None
        number = row[0]
        try:
            it = gh_rest(f"issues/{number}")
        except Exception as e:
            print(f"classifier-board: agg verify failed for {cat!r} (#{number}): {e} -> trusting DB record (no duplicate create)")
            return {"number": number, "title": "", "body": "", "state": "open", "_unverified": True}
        if (it.get("state") or "") == "open" and rcagg_marker(cat) in (it.get("body") or ""):
            return it
        if (it.get("state") or "") == "open":
            # open but marker lost (body edited) — PATCH will restore it
            print(f"classifier-board: agg #{number} for {cat!r} lost its rcagg marker -> will repair via PATCH")
            return dict(it, _unverified=True)
        # closed upstream -> replace, never reopen
        c = rcdb()
        c.execute("DELETE FROM rc_agg WHERE category=?", (cat,))
        c.commit(); c.close()
        print(f"classifier-board: agg #{number} for {cat!r} closed upstream -> record dropped, fresh issue will be created")
        return None
    except Exception as e:
        print(f"classifier-board: rc_lookup failed for {cat!r}: {e}")
        return None

def rc_remember(cat, number):
    try:
        c = rcdb()
        c.execute("INSERT INTO rc_agg(category, token, issue_number, updated_at) VALUES(?,?,?,?) "
                  "ON CONFLICT(category) DO UPDATE SET token=excluded.token, "
                  "issue_number=excluded.issue_number, updated_at=excluded.updated_at",
                  (cat, rcagg_token(cat), number, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())))
        c.commit(); c.close()
    except Exception as e:
        print(f"classifier-board: rc_remember failed for {cat!r}: {e}")

def rc_dr_recover(open_labeled):
    """Disaster recovery: if the DB table is empty but labelled aggregation
    issues carry rcagg markers in their bodies, re-import them. Markers are
    authoritative; the scan only happens when the DB has nothing."""
    try:
        c = rcdb()
        n = c.execute("SELECT COUNT(*) FROM rc_agg").fetchone()[0]
        c.close()
        if n:
            return
    except Exception:
        pass
    for it in open_labeled:
        m = re.search(r"<!-- (rcagg:[^>]+?) -->", it.get("body") or "")
        if not m:
            continue
        cat = m.group(1)[len("rcagg:"):]
        try:
            rc_remember(cat, it.get("number"))
            print(f"classifier-board: DR-recovered {cat!r} -> #{it.get('number')} from body marker")
        except Exception:
            pass

def ensure_label(name, color="b4b4b4"):
    try:
        gh_rest(f"labels/{urllib.request.quote(name)}")
        return
    except Exception:
        pass
    try:
        gh_rest("labels", {"name": name, "color": color}, method="POST")
    except Exception as e:
        print(f"classifier-board: label create failed for {name!r} (continuing): {e}")

def issue_has_label(it, name):
    labels = it.get("labels")
    if isinstance(labels, list):
        return any((l.get("name") if isinstance(l, dict) else l) == name for l in labels)
    return name in (labels or "")

opener = urllib.request.build_opener(urllib.request.ProxyHandler({"https": PROXY}))

def gh_rest(path, payload=None, method=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/{path}",
        data=data, method=method or ("POST" if data else "GET"),
        headers={"Authorization": f"Bearer {PAT}", "User-Agent": "ework-classifier-board",
                 "Accept": "application/vnd.github+json"})
    if payload is not None:
        req.add_header("Content-Type", "application/json")
    return json.load(opener.open(req, timeout=30))

def gh_gql(query, variables):
    req = urllib.request.Request("https://api.github.com/graphql",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={"Authorization": f"Bearer {PAT}", "User-Agent": "ework-classifier-board",
                 "Content-Type": "application/json"})
    return json.load(opener.open(req, timeout=30))

def load_state():
    try:
        return json.load(open(STATE))
    except Exception:
        return {}

def save_state(st):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    tmp = STATE + ".tmp"
    json.dump(st, open(tmp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)

def anchor_number():
    st = load_state()
    if st.get("anchor"):
        return st["anchor"]
    # discover: first open issue titled with [分类] 根因归类扫描锚点
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    row = c.execute("""SELECT upstream_issue_number FROM issues
        WHERE project_id=(SELECT id FROM projects WHERE name='billion-context')
        AND state='open' AND title LIKE '[分类]%' AND title LIKE '%锚点%'
        ORDER BY number DESC LIMIT 1""").fetchone()
    c.close()
    if row and row[0]:
        save_state(dict(st, anchor=row[0]))
        return row[0]
    return None

def parse_classifier_json(text):
    """Extract every fenced ```classifier-json block and parse its array."""
    out = []
    for m in re.finditer(r"```classifier-json\s*(.*?)```", text or "", re.S):
        body = m.group(1).strip()
        try:
            arr = json.loads(body)
        except Exception:
            continue
        if isinstance(arr, dict):
            arr = [arr]
        if isinstance(arr, list):
            out.extend(o for o in arr if isinstance(o, dict) and isinstance(o.get("number"), int))
    return out

def fetch_batch(merged, anchor, st):
    """Pull anchor-thread comments until every open issue number already has an
    entry in `merged` (or the thread is exhausted). Pages of 50, newest first —
    so the first page alone already refreshes the latest batch."""
    cursor_seen = st.get("anchor_comment_id")
    page = 1
    refreshed = False
    while page <= 10:
        try:
            comments = gh_rest(f"issues/{anchor}/comments?per_page=50&page={page}")
        except Exception as e:
            print(f"classifier-board: comments page {page} failed: {e}")
            break
        if not isinstance(comments, list) or not comments:
            break
        for cm in comments:
            if cursor_seen and cm.get("id") == cursor_seen and refreshed:
                return
            for o in parse_classifier_json(cm.get("body", "")):
                n = o["number"]
                if n not in merged or (cm.get("created_at") or "") >= (merged[n].get("_at") or ""):
                    o["_at"] = cm.get("created_at") or ""
                    merged[n] = o
                    refreshed = True
        if all(x in merged for x in open_numbers()):
            break
        page += 1
    if cursor_seen and refreshed:
        save_state(dict(st, anchor_comment_id=cursor_seen))

def open_numbers():
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = c.execute("""SELECT number FROM issues
        WHERE project_id=(SELECT id FROM projects WHERE name='billion-context')
        AND state='open' AND title NOT LIKE '[PR]%' AND title NOT LIKE '[根因]%'
        AND title NOT LIKE '[分类]%' AND title NOT LIKE '[Root Cause]%'""").fetchall()
    c.close()
    return {n for (n,) in rows}

# Incorporated-issue auto-stop (owner policy 2026-11-12): absorbed issues run no
# bot work of their own. The daemon reads SUPPRESSION_PATH (per-event drop gate)
# and stop-work stops any live/queued work on each render (idempotent, silent).
SUPPRESSION_PATH = "/var/lib/ework-daemon/share/classifier/suppressed.json"
DAEMON_STOP_URL = "http://127.0.0.1:3101/api/admin/stop-work"

def incorporated_numbers(merged, open_set):
    """{mirror number: reason} for every open issue absorbed into a root-cause
    aggregation (category with >= AGG_THRESHOLD members) or classified tinyfix."""
    by_cat = {}
    for n, o in merged.items():
        if n not in open_set:
            continue
        cat = str(o.get("category") or "").strip()
        by_cat.setdefault(cat or "?", []).append(n)
    out = {}
    for cat, nums in by_cat.items():
        if cat == "tinyfix" or len(nums) >= AGG_THRESHOLD:
            for n in nums:
                out[str(n)] = "tinyfix" if cat == "tinyfix" else f"incorporated:{cat}"
    return out

def write_suppression(merged, open_set):
    nums = incorporated_numbers(merged, open_set)
    payload = {"updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "issues": nums}
    os.makedirs(os.path.dirname(SUPPRESSION_PATH), exist_ok=True)
    tmp = SUPPRESSION_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp, SUPPRESSION_PATH)
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                DAEMON_STOP_URL,
                data=json.dumps({"issue_ids": list(nums)}).encode(),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=60) as r:
                print(f"classifier-board: stop-work -> {r.read().decode()[:200]}")
            break
        except Exception as e:
            print(f"classifier-board: stop-work POST failed (attempt {attempt+1}/3): {e}")
            if attempt < 2:
                time.sleep(5 * (attempt + 1))
    print(f"classifier-board: suppression set = {len(nums)} issue(s) -> {SUPPRESSION_PATH}")

def mirror_row(n):
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    row = c.execute("""SELECT title, state, upstream_issue_number, upstream_ci_state,
        upstream_mergeable_state FROM issues
        WHERE project_id=(SELECT id FROM projects WHERE name='billion-context')
        AND number=?""", (n,)).fetchone()
    c.close()
    return row

def pr_row(upstream_num):
    """The mirror row of the PR for upstream PR number N (title '[PR]%')."""
    if not upstream_num:
        return None
    c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    row = c.execute("""SELECT upstream_ci_state, upstream_mergeable_state FROM issues
        WHERE project_id=(SELECT id FROM projects WHERE name='billion-context')
        AND upstream_issue_number=? AND title LIKE '[PR]%'
        ORDER BY number DESC LIMIT 1""", (int(upstream_num),)).fetchone()
    c.close()
    return row

def ci_state_cached(checks_json):
    try:
        d = json.loads(checks_json) if checks_json else None
        if not d:
            return ""
        checks = d.get("checks") or []
        if not checks:
            return ""
        if any(c.get("status") != "completed" for c in checks):
            return "⏳CI跑"
        fails = [c for c in checks if c.get("conclusion") == "failure"]
        return "🔴CI红" if fails else "✅CI绿"
    except Exception:
        return ""

MERGE_MAP = {"dirty": "⚠️冲突", "blocked": "", "behind": "⬇️落后",
             "unstable": "🔴CI红", "has_hooks": "", "unknown": "", "clean": "✅可合"}
CONF = {"high": "高", "medium": "中", "low": "低"}

def ci_merge_live(n, obj):
    """Prefer the mirror's live state (fresh); fall back to the classifier's
    snapshot for fields the mirror does not track."""
    row = mirror_row(n)
    title, state, up_num, ci_json, mstate = (row if row else ("", "open", None, "", ""))
    ci = ci_state_cached(ci_json)
    if not ci and isinstance(obj.get("ci_state"), str):
        ci = {"green": "✅CI绿", "red": "🔴CI红", "none": ""}.get(obj["ci_state"], "")
    merge = ""
    pr = obj.get("pr_number")
    if pr:
        prow = pr_row(pr)
        if prow:
            ci = ci or ci_state_cached(prow[0])
            merge = MERGE_MAP.get(prow[1] or "", "")
        else:
            merge = MERGE_MAP.get(obj.get("merge_state", ""), "")
    return title, state, ci, merge, pr

def short(t, n=34):
    t = re.sub(r"\s+", " ", (t or "").strip())
    return t[:n - 1] + "…" if len(t) > n else t

def ci_safe_title(cat):
    """The daemon dispatch gate skips titles matching /\bci\b/i. Standalone
    'ci' inside a category name would silently no-dispatch the aggregation
    issue (owner wants it dispatched), so defang it in the TITLE only; the
    token (body marker) always keeps the raw category name."""
    return re.sub(r"(?<![A-Za-z0-9_])ci(?![A-Za-z0-9_])", "c-i", cat or "", flags=re.I)

def agg_title(cat, n):
    # English-only titles (owner policy 2026-11-12); purely cosmetic.
    return f"[Root Cause] {ci_safe_title(cat)} ({n} items)"

def open_labeled_issues():
    """All open issues carrying the agg label (paged; >100 would silently
    drop tickets out of DR/fallback scans)."""
    items = []
    for page in range(1, 6):
        try:
            batch = gh_rest(f"issues?state=open&per_page=100&page={page}&labels={AGG_LABEL}")
        except Exception as e:
            print(f"classifier-board: labelled issue list page {page} failed: {e}")
            return items
        if not isinstance(batch, list) or not batch:
            break
        items.extend(batch)
        if len(batch) < 100:
            break
    return items

def up_num_of(n):
    row = mirror_row(n)
    return row[2] if row else None

def update_agg(merged, open_set):
    """Group open classified issues by category; ensure one aggregation issue
    per qualifying category. Dedup is by the rcagg token (DB -> body marker ->
    labelled scan), never by title."""
    groups = {}
    for n, obj in merged.items():
        if n not in open_set:
            continue
        cat = (obj.get("category") or "").strip() or "(未分类)"
        groups.setdefault(cat, []).append(n)
    labeled = open_labeled_issues()
    rc_dr_recover(labeled)
    ensured = {}
    for cat in sorted(groups):
        nums = sorted(groups[cat])
        if cat == "tinyfix":
            # 碎小修: no aggregation issue (owner policy 2026-11-12) — members are
            # already suppressed (bot stopped) by write_suppression; no ticket,
            # no label, no comment. Board still shows the tinyfix section.
            continue
        title = agg_title(cat, len(nums))
        it = rc_lookup(cat)
        member_lines = []
        for n in nums:
            row = mirror_row(n)
            title_m = short(row[0] if row else obj_title(merged[n]), 40)
            up = up_num_of(n)
            rc = short(merged[n].get("root_cause", ""), 80)
            member_lines.append(f"- 镜像 #{n}" + (f"（GitHub #{up}）" if up else "") + f" — {title_m}\n  根因: {rc}")
        body = (
            rcagg_marker(cat) + "\n"
            + f"同一根本原因（**{cat}**）的 open issue 汇聚，由根因归类板自动维护（10min 刷新，勿手编）。\n\n"
            + f"## Members ({len(nums)})\n" + "\n".join(member_lines) +
            "\n\n## Task\n"
            + "对本批 issue 做**一个**根本性修复 PR：\n"
            + "- PR 描述里用 `Fixes #...` 逐个列出上面每一个 GitHub issue 号（没有 GitHub 号的写镜像号）\n"
              + "- 若某个 issue 已有自己的 PR 且方向一致，cherry-pick 其 commit 并保留原作者署名（`-x`）；由你判断是否值得\n"
              + "- 标签按本 PR 的 diff 独立判断（类别 + 优先级），不要抄任何来源 issue\n"
              + "- 修完后回帖本线程：改了什么、为什么这样修\n"
            )
        if len(nums) < AGG_THRESHOLD:
            # below threshold: never create; but keep an existing ticket's body
            # fresh so a dispatched worker sees the true (shrunk) member list
            if it is not None:
                try:
                    gh_rest(f"issues/{it['number']}", {"title": title, "body": body}, method="PATCH")
                    print(f"classifier-board: refreshed (shrunken) agg #{it['number']} for {cat!r} ({len(nums)} items)")
                except Exception as e:
                    print(f"classifier-board: agg refresh failed #{it.get('number')}: {e}")
            continue
        if it is None:
            # fallback: scan labelled open issues for the body marker
            for cand in labeled:
                if rcagg_marker(cat) in (cand.get("body") or ""):
                    it = cand
                    break
        if it is None:
            try:
                ensure_label(AGG_LABEL)
                it = gh_rest("issues", {"title": title, "body": body, "labels": [AGG_LABEL]}, method="POST")
                print(f"classifier-board: created agg issue #{it.get('number')} for {cat!r} ({len(nums)} issues, token={rcagg_token(cat)})")
            except Exception as e:
                print(f"classifier-board: agg create failed for {cat!r}: {e}")
                continue
            rc_remember(cat, it.get("number"))
        else:
            if (it.get("title") or "") != title:
                it = dict(it, title=title)
            try:
                gh_rest(f"issues/{it['number']}", {"title": it.get("title"), "body": body}, method="PATCH")
                print(f"classifier-board: updated agg issue #{it['number']} for {cat!r} ({len(nums)} issues)")
            except Exception as e:
                print(f"classifier-board: agg update failed #{it.get('number')}: {e}")
            rc_remember(cat, it.get("number"))
        ensured[cat] = {"number": it.get("number"), "title": title}
    return ensured

def mark_members(agg_by_cat, merged, open_set):
    """Member issues of aggregated categories get the 已被收 label + ONE short
    comment (idempotent via state). MUST run after write_suppression: the
    daemon drop-gate has to be in place before the comment lands, or the
    comment would wake a worker on the member issue.
    agg_by_cat: {cat: {"number": <gh issue number>, "title": <str>}} from
    update_agg (avoids a second rc_lookup/REST round-trip per category)."""
    st = load_state()
    marked = dict(st.get("absorbed_marks") or {})
    newly = 0
    for cat, info in sorted(agg_by_cat.items()):
        num = info["number"]
        agg_title_txt = info.get("title") or f"#{num}"
        for n, obj in merged.items():
            if n not in open_set:
                continue
            if (obj.get("category") or "").strip() != cat:
                continue
            key = str(n)
            if key in marked:
                continue
            try:
                up = up_num_of(n)
                gh_issue = gh_rest(f"issues/{up}") if up else None
            except Exception as e:
                print(f"classifier-board: member fetch failed for mirror #{n}: {e}")
                continue
            if gh_issue is None:
                # member has no GitHub mirror number yet — defer to a later
                # round instead of crashing (mirror number may appear later)
                print(f"classifier-board: mirror #{n} has no GitHub number yet -> 已被收 mark deferred")
                continue
            if gh_issue.get("state") != "open":
                marked[key] = num
                continue
            gnum = gh_issue["number"]
            if not issue_has_label(gh_issue, ABSORBED_LABEL):
                try:
                    ensure_label(ABSORBED_LABEL, "d9d9d9")
                    gh_rest(f"issues/{gnum}/labels", {"labels": [ABSORBED_LABEL]}, method="POST")
                except Exception as e:
                    print(f"classifier-board: absorbed-label failed for GH #{gnum}: {e}")
            try:
                gh_rest(f"issues/{gnum}/comments", {"body": f"{ABSORBED_COMMENT}（聚合单：{agg_title_txt}，GitHub #{num}）"}, method="POST")
            except Exception as e:
                print(f"classifier-board: absorbed comment failed for GH #{gnum}: {e}")
            marked[key] = num
            newly += 1
            time.sleep(0.4)
    if newly:
        save_state(dict(st, absorbed_marks=marked))
        print(f"classifier-board: marked {newly} member(s) as 已被收 (label + comment)")

def obj_title(obj):
    return obj.get("title") or ""

def board_discussion_number(st):
    if st.get("discussion"):
        return st["discussion"]
    d = gh_gql("""query($q: String!) { search(query: $q, type: DISCUSSION, first: 5) {
        nodes { ... on Discussion { number title } } } }""",
        {"q": f"repo:{REPO} {BOARD_TITLE.replace('（',' ').replace('）',' ')} in:title"})
    for n in d["data"]["search"]["nodes"]:
        if BOARD_TITLE in (n.get("title") or ""):
            return n["number"]
    return None

def create_board():
    cats = gh_gql("""query($rid: ID!) { node(id: $rid) { ... on Repository {
        discussionCategories(first: 20) { nodes { id name } } } } }""",
        {"rid": gh_gql("query { repository(owner:\\\"ranxianglei\\\", name:\\\"billion-context\\\") { id } }", {})[
            "data"]["repository"]["id"]})
    nodes = cats["data"]["node"]["discussionCategories"]["nodes"]
    general = next((c["id"] for c in nodes if c["name"].lower() in ("general", "通用", "杂谈")), nodes[0]["id"])
    d = gh_gql("""mutation($rid: ID!, $cid: ID!, $title: String!, $body: String!) {
        createDiscussion(input: {repositoryId: $rid, categoryId: $cid, title: $title, body: $body}) {
            discussion { number } } }""",
        {"rid": gh_gql("query { repository(owner:\\\"ranxianglei\\\", name:\\\"billion-context\\\") { id } }", {})[
            "data"]["repository"]["id"], "cid": general, "title": BOARD_TITLE,
         "body": "初始化…（等待首轮根因归类结果）"})
    if "errors" in d or not d.get("data", {}).get("createDiscussion"):
        raise SystemExit(f"createDiscussion failed: {json.dumps(d)[:400]}")
    return d["data"]["createDiscussion"]["discussion"]["number"]

def update_board(number, body):
    d = gh_gql("""query($n: Int!) { repository(owner: "ranxianglei", name: "billion-context") {
        discussion(number: $n) { id } } }""", {"n": number})
    did = d["data"]["repository"]["discussion"]["id"]
    gh_gql("""mutation($id: ID!, $body: String!) {
        updateDiscussion(input: {discussionId: $id, body: $body}) { discussion { number } } }""",
        {"id": did, "body": body})

def render(merged, open_set):
    now = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())
    lines = [
        f"自动由根因归类 worker（4h 一批）+ 渲染脚本（10min）维护。**请勿手编**——手改会被下一轮覆盖。",
        "",
        f"_更新: {now} · 已归类 {len(merged)} · 当前 open 且已归类 {sum(1 for n in merged if n in open_set)}_",
        "",
    ]
    groups = {}
    for n, obj in merged.items():
        if n not in open_set:
            continue
        cat = (obj.get("category") or "").strip() or "(未分类)"
        groups.setdefault(cat, []).append(n)
    if not groups:
        lines.append("_（暂无归类结果——等首批 100 条分类完成）_")
        return "\n".join(lines)
    for cat in sorted(groups, key=lambda c: -len(groups[c])):
        nums = sorted(groups[cat])
        lines.append(f"## {cat}（{len(nums)}）")
        lines.append("")
        lines.append("| issue | 标题 | 根因 | PR/CI/合并 | 置信 |")
        lines.append("|---|---|---|---|---|")
        for n in nums:
            obj = merged[n]
            title, state, ci, merge, pr = ci_merge_live(n, obj)
            title = short(title or obj.get("title") or "", 36)
            rc = short(obj.get("root_cause", ""), 60) or "—"
            cell = " · ".join(x for x in [
                (f"PR #{pr}" if pr else ""), ci, merge] if x)
            lines.append(f"| #{n} | {title} | {rc} | {cell or '—'} | {CONF.get(obj.get('confidence',''), '—')} |")
        if len(nums) >= AGG_THRESHOLD:
            lines.append("")
            if cat == "tinyfix":
                lines.append("碎小修（tinyfix）：各单机器人已停，无聚合单。")
            else:
                lines.append(f"≥{AGG_THRESHOLD} 个同根因 → 已有/将有 **[Root Cause] {ci_safe_title(cat)}** 汇聚 issue 走正常流程出根本 PR（一个 PR 关一批）。")
        lines.append("")
    return "\n".join(lines)

def main():
    anchor = anchor_number()
    if not anchor:
        print("classifier-board: no anchor issue found in mirror — skipping")
        return
    st = load_state()
    # M2 guard: carry last round's classifications forward so a short/partial
    # anchor-thread scan (page cap, transient 403) can never silently drop an
    # issue out of the suppression gate (drop = bot wakes on absorbed member).
    # The cache is seeded INTO st before fetch_batch, because fetch_batch may
    # call save_state(st) for the cursor — a stale `st` without the cache would
    # clobber it.
    st = dict(st, merged_cache=dict(st.get("merged_cache") or {}))
    merged = dict(st["merged_cache"])
    fetch_batch(merged, anchor, st)
    save_state(dict(st, merged_cache=merged))
    if not merged:
        print("classifier-board: no classifier-json found on anchor thread yet — keeping previous suppression gate intact")
        return
    open_set = open_numbers()
    # ORDER MATTERS (owner policy 2026-11-12): stop the bots on absorbed
    # members FIRST (drop-gate + stop-work), only then (re)create aggregation
    # issues and post member marks — so no member comment can wake a worker.
    write_suppression(merged, open_set)
    agg_by_cat = {}
    if merged:
        agg_by_cat = update_agg(merged, open_set)
        mark_members(agg_by_cat, merged, open_set)
    ensure_label(AGG_LABEL)
    num = board_discussion_number(st)
    if num is None:
        num = create_board()
        save_state(dict(st, discussion=num))
    update_board(num, render(merged, open_set))
    print(f"classifier-board: board #{num} updated ({len(merged)} classified, {len(open_set)} open)")

if __name__ == "__main__":
    main()
