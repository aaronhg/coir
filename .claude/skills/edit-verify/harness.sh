#!/usr/bin/env bash
# coir edit — native-verification harness (sourceable). See SKILL.md.
#
# Verifies coir's prefab/scene edit engine against a LIVE Cocos Creator editor via
# the cocos-extension native-verify endpoint (reimport · readback · fixture I/O).
# It NEVER edits a real asset — every case runs on an isolated `__vy_*` fixture copy
# that is deleted afterward.
#
#   source .claude/skills/edit-verify/harness.sh
#   vy_init ../NewProject_386        # finds the endpoint whose open project matches
#   ... run cases ...
#   vy_cleanup                       # delete every __vy_* fixture (also run on trap)
#
# Requires: a running editor with the endpoint started (Coir ▸ native-verify: start),
# `curl`, `jq`, `shasum`, `node`.

# ── connection ──────────────────────────────────────────────────────────────
vy_init() {                                   # PROJ_DIR
  VY_PROJ="$(cd "$1" && pwd -P)" || { echo "✗ no such project dir: $1" >&2; return 1; }
  # the coir repo (has src/cli.js): preset VY_REPO, else the git toplevel, else $PWD.
  # (Run from the coir repo root; avoids BASH_SOURCE so it works under zsh too.)
  VY_REPO="${VY_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  [ -f "$VY_REPO/src/cli.js" ] || { echo "✗ VY_REPO has no src/cli.js: $VY_REPO (run from the coir repo, or set VY_REPO)" >&2; return 1; }
  local p r proj
  for p in $(seq "${VY_PORT_LO:-3789}" "${VY_PORT_HI:-3809}"); do
    r=$(curl -s -m 2 -X POST "http://127.0.0.1:$p/ready" -H 'content-type: application/json' -d '{}' 2>/dev/null)
    [ -z "$r" ] && continue
    proj=$(printf '%s' "$r" | sed 's/.*"project":"\([^"]*\)".*/\1/')
    if [ "$(cd "$proj" 2>/dev/null && pwd -P)" = "$VY_PROJ" ]; then
      VY_BASE="http://127.0.0.1:$p"
      # the endpoint requires X-Coir-Token on every route except /ready (which hands it out)
      VY_TOKEN=$(printf '%s' "$r" | sed 's/.*"token":"\([^"]*\)".*/\1/'); [ "$VY_TOKEN" = "$r" ] && VY_TOKEN=""
      echo "✓ endpoint :$p ($(printf '%s' "$r" | sed 's/.*"version":"\([^"]*\)".*/\1/')) matches $VY_PROJ"
      trap vy_cleanup EXIT
      return 0
    fi
  done
  echo "✗ no native-verify endpoint on :${VY_PORT_LO:-3789}-${VY_PORT_HI:-3809} matches $VY_PROJ" >&2
  echo "  open the project in Cocos Creator and start the endpoint (Coir ▸ native-verify: start)." >&2
  return 1
}

# ── primitives ──────────────────────────────────────────────────────────────
vy_co()   { node "$VY_REPO/src/cli.js" -C "$VY_PROJ" "$@"; }           # run coir CLI
vy_post() { curl -s -X POST "$VY_BASE/$1" -H 'content-type: application/json' ${VY_TOKEN:+-H "x-coir-token: $VY_TOKEN"} -d "$2"; }
vy_copy() {                                   # SRC_REL DST_BASE -> echoes new uuid
  # NOTE: the editor renames the copied prefab's ROOT node to DST_BASE — so every
  # selector against this fixture must use DST_BASE as the root (NOT the source root).
  vy_post fixture "{\"action\":\"delete\",\"url\":\"db://assets/$2.prefab\"}" >/dev/null
  vy_post fixture "{\"action\":\"copy\",\"src\":\"db://assets/$1\",\"dst\":\"db://assets/$2.prefab\"}" \
    | sed 's/.*"uuid":"\([^"]*\)".*/\1/'
}
vy_del()    { vy_post fixture "{\"action\":\"delete\",\"url\":\"db://assets/$1.prefab\"}" >/dev/null; }
vy_reimp()  { vy_post reimport "{\"url\":\"db://assets/$1.prefab\"}"; }                # reimport-BEFORE-read (asset-db caches)
vy_read()   { vy_post read "{\"uuid\":\"$1\",\"selectors\":$2}"; }                     # SELECTORS = a JSON array string
vy_cleanup(){ local f; for f in $(find "$VY_PROJ/assets" -maxdepth 1 -name '__vy_*.prefab' 2>/dev/null); do vy_del "$(basename "$f" .prefab)"; done; }  # find = no shell-glob no-match error (zsh-safe, idempotent)

# ── case runners (log PASS/FAIL) ────────────────────────────────────────────
# A refusal/guard or dry-run: coir's exit code must equal WANT and the fixture
# bytes must be UNCHANGED. Run on an already-copied fixture.
vy_refuse() {                                 # ID WANT_EXIT FIXTURE_BASE -- EDIT_ARGS...
  local id="$1" want="$2" f="$3"; shift 3; [ "$1" = "--" ] && shift
  local b=$(shasum "$VY_PROJ/assets/$f.prefab" 2>/dev/null | cut -d' ' -f1)
  vy_co edit "$f.prefab" "$@" >/dev/null 2>&1; local e=$?
  local a=$(shasum "$VY_PROJ/assets/$f.prefab" 2>/dev/null | cut -d' ' -f1)
  if [ "$e" = "$want" ] && [ "$b" = "$a" ]; then echo "  $id PASS (exit $e, unchanged)"
  else echo "  $id **FAIL** exit=$e want=$want $([ "$b" = "$a" ] && echo unchanged || echo CHANGED)"; fi
}
# A native value readback: after an edit+reimport, read SELECTOR and jq-check it.
# UUID is the fixture's (from vy_copy). CHECK is a jq filter returning true/false.
vy_assert() {                                 # ID UUID SELECTOR_JSON JQ_CHECK
  local id="$1" u="$2" sel="$3" chk="$4"
  local out=$(vy_read "$u" "$sel")
  if printf '%s' "$out" | jq -e "$chk" >/dev/null 2>&1; then echo "  $id PASS — $(printf '%s' "$out" | jq -c '.values')"
  else echo "  $id **FAIL** — $(printf '%s' "$out" | jq -c '.values // .')"; fi
}
