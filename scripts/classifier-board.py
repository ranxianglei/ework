#!/usr/bin/env python3
"""2026-11-11 (owner policy: issue 根因归类): the root-cause classification board.

Consumes the classifier-worker's structured replies (fenced ```classifier-json
blocks) posted on the project's ANCHOR thread (GH issue, body contains
[no-dispatch]), merges them across rounds (latest object per issue number wins),
enriches every row with live CI / merge state straight from the mirror DB
(zero REST fan-out — the REST budget stays <=10 req/min, same discipline as
ework-status-board.py), renders a discussion board, and — when one root-cause
category covers >=2 open issues — creates (or updates) a [根因] aggregation
issue tagged root-cause-batch. The aggregation issue then flows through the
NORMAL dispatch pipeline (no special lane) and produces one root-cause PR with
a "Fixes #..." list; merging it closes the batch at once.

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
# [根因] aggregation issue that goes through the normal pipeline.
AGG_THRESHOLD = 2

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
        AND title NOT LIKE '[分类]%'""").fetchall()
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
    try:
        req = urllib.request.Request(
            DAEMON_STOP_URL,
            data=json.dumps({"issue_ids": list(nums)}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            print(f"classifier-board: stop-work -> {r.read().decode()[:200]}")
    except Exception as e:
        print(f"classifier-board: stop-work POST failed (non-fatal): {e}")
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
    """The daemon's dispatch gate skips titles matching /\bci\b/i — keep the
    word CI out of standalone aggregation-issue titles (table cells are fine)."""
    return re.sub(r"\bCI\b", "持续集成", cat or "")

def ensure_label():
    try:
        gh_rest(f"labels/{AGG_LABEL}")
        return
    except Exception:
        pass
    try:
        gh_rest(f"labels", {"name": AGG_LABEL, "color": "b4b4b4"}, method="POST")
    except Exception as e:
        print(f"classifier-board: label create failed (continuing): {e}")

def find_agg_issue(cat):
    want = f"[根因] {ci_safe_title(cat)}"
    try:
        items = gh_rest(f"issues?state=open&per_page=100&labels={AGG_LABEL}")
    except Exception as e:
        print(f"classifier-board: agg list failed: {e}")
        return None
    for it in items if isinstance(items, list) else []:
        t = (it.get("title") or "").split("：", 1)[0].split("(", 1)[0].strip()
        if t == want or (it.get("title") or "").startswith(want):
            return it
    return None

def up_num_of(n):
    row = mirror_row(n)
    return row[2] if row else None

def update_agg(merged, open_set):
    """Group open classified issues by category; ensure one [根因] issue per
    category with >=2 open members. Idempotent by title."""
    groups = {}
    for n, obj in merged.items():
        if n not in open_set:
            continue
        cat = (obj.get("category") or "").strip() or "(未分类)"
        groups.setdefault(cat, []).append(n)
    ensured = []
    for cat, nums in sorted(groups.items()):
        if len(nums) < AGG_THRESHOLD:
            continue
        nums = sorted(nums)
        want = f"[根因] {ci_safe_title(cat)}"
        st = load_state()
        known = (st.get("aggs") or {}).get(cat)
        it = None
        if known:
            try:
                it = gh_rest(f"issues/{known}")
                if (it.get("state") != "open") or not (it.get("title") or "").startswith("[根因]"):
                    it = None
            except Exception:
                it = None
        if it is None:
            it = find_agg_issue(cat)
        member_lines = []
        for n in nums:
            row = mirror_row(n)
            title = short(row[0] if row else obj_title(merged[n]), 40)
            up = up_num_of(n)
            rc = short(merged[n].get("root_cause", ""), 80)
            member_lines.append(f"- 镜像 #{n}" + (f"（GitHub #{up}）" if up else "") + f" — {title}\n  根因: {rc}")
        if it is None:
            body = (
                f"同一根本原因（**{cat}**）的 open issue 汇聚，由根因归类板自动维护（10min 刷新，勿手编）。\n\n"
                f"## 本批 issue\n" + "\n".join(member_lines) +
                "\n\n## 任务\n对本批 issue 做**一个**根本性修复 PR：\n"
                "- PR 描述里用 `Fixes #...` 逐个列出上面每一个 GitHub issue 号（没有 GitHub 号的写镜像号）\n"
                "- 若某个 issue 已有自己的 PR 且方向一致，cherry-pick 其 commit 并保留原作者署名（`-x`）；由你判断是否值得\n"
                "- 标签按本 PR 的 diff 独立判断（类别 + 优先级），不要抄任何来源 issue\n"
                "- 修完后回帖本线程：改了什么、为什么一次修了整批\n"
            )
            try:
                it = gh_rest("issues", {
                    "title": want + "（自动维护，勿手动关闭）",
                    "body": body,
                    "labels": [AGG_LABEL],
                }, method="POST")
                print(f"classifier-board: created agg issue #{it.get('number')} for category {cat!r} ({len(nums)} issues)")
            except Exception as e:
                print(f"classifier-board: agg create failed for {cat!r}: {e}")
                continue
            ensured.append(it.get("number"))
        else:
            body = (
                f"同一根本原因（**{cat}**）的 open issue 汇聚，由根因归类板自动维护（10min 刷新，勿手编）。\n\n"
                f"## 本批 issue\n" + "\n".join(member_lines) +
                "\n\n## 任务\n对本批 issue 做**一个**根本性修复 PR：\n"
                "- PR 描述里用 `Fixes #...` 逐个列出上面每一个 GitHub issue 号（没有 GitHub 号的写镜像号）\n"
                "- 若某个 issue 已有自己的 PR 且方向一致，cherry-pick 其 commit 并保留原作者署名（`-x`）；由你判断是否值得\n"
                "- 标签按本 PR 的 diff 独立判断（类别 + 优先级），不要抄任何来源 issue\n"
                "- 修完后回帖本线程：改了什么、为什么一次修了整批\n"
            )
            if (it.get("title") or "").split("（", 1)[0].strip() != want:
                it = dict(it, title=want + "（自动维护，勿手动关闭）")
            try:
                gh_rest(f"issues/{it['number']}", {"title": it.get("title"), "body": body}, method="PATCH")
                print(f"classifier-board: updated agg issue #{it['number']} for category {cat!r} ({len(nums)} issues)")
            except Exception as e:
                print(f"classifier-board: agg update failed #{it.get('number')}: {e}")
            ensured.append(it.get("number"))
    # prune state for closed/aggregated-away issues
    st = load_state()
    aggs = {}
    for cat, num in (st.get("aggs") or {}).items():
        if num in ensured:
            aggs[cat] = num
    save_state(dict(st, aggs=aggs))

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
            lines.append(f"≥{AGG_THRESHOLD} 个同根因 → 已有/将有 **[根因] {ci_safe_title(cat)}** 汇聚 issue 走正常流程出根本 PR（一个 PR 关一批）。")
        lines.append("")
    return "\n".join(lines)

def main():
    anchor = anchor_number()
    if not anchor:
        print("classifier-board: no anchor issue found in mirror — skipping")
        return
    st = load_state()
    merged = {}
    fetch_batch(merged, anchor, st)
    if not merged:
        print("classifier-board: no classifier-json found on anchor thread yet")
        # still (re)create the empty board so the owner can see it exists
    open_set = open_numbers()
    if merged:
        update_agg(merged, open_set)
    ensure_label()
    num = board_discussion_number(st)
    if num is None:
        num = create_board()
        save_state(dict(st, discussion=num))
    update_board(num, render(merged, open_set))
    write_suppression(merged, open_set)
    print(f"classifier-board: board #{num} updated ({len(merged)} classified, {len(open_set)} open)")

if __name__ == "__main__":
    main()
