#!/usr/bin/env python3
"""EP-00.3 — a headless native-client fixture.

Stands in for a TV client that executes no downloaded content. It speaks only
HTTP + JSON, renders nothing, and asserts that a descriptor is *sufficient* to
render — which is the only thing a fixture can honestly prove about a protocol.

What it is not: evidence about any real client. See supported-client-matrix.md.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8199"
TOKEN = sys.argv[2]
TOKEN2 = sys.argv[3] if len(sys.argv) > 3 else None

results: list[tuple[str, bool, str]] = []


def call(path: str, payload=None, token: str | None = None, method: str | None = None):
    url = f"{BASE}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    request.add_header("Authorization", f"MediaBrowser Token={token or TOKEN}")
    if data:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as error:
        body = error.read()
        try:
            return error.code, json.loads(body or b"null")
        except json.JSONDecodeError:
            return error.code, {"raw": body[:200].decode("utf-8", "replace")}


def check(name: str, condition: bool, detail: str = "") -> None:
    results.append((name, condition, detail))
    print(f"  {'PASS' if condition else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


# 1. Negotiation, and the incompatible case as a DISTINCT state -----------------
_, modern = call("/Ep00Spike/Native/Negotiate", {
    "protocolMin": 1, "protocolMax": 2,
    "components": ["row", "detail-action", "badge", "form"],
    "inputModes": ["dpad"], "locale": "en-GB",
})
check("negotiates the highest common protocol", modern.get("protocol") == 2, f"got {modern.get('protocol')}")
check("echoes the client's input mode", modern.get("inputModes") == ["dpad"])

_, limited = call("/Ep00Spike/Native/Negotiate", {
    "protocolMin": 1, "protocolMax": 1, "components": ["row"], "inputModes": ["dpad"],
})
check("an older client still negotiates", limited.get("protocol") == 1)
check("unsupported components are named, not silently dropped",
      sorted(limited.get("componentsOmitted", [])) == ["badge", "detail-action", "form"])

_, future = call("/Ep00Spike/Native/Negotiate", {"protocolMin": 9, "protocolMax": 9, "components": ["row"]})
check("no protocol overlap is its own error code",
      future.get("error") == "protocol_incompatible", str(future.get("error")))

# 2. A descriptor is sufficient to render a paginated row ----------------------
_, page1 = call("/Ep00Spike/Native/Catalog", {"components": ["row"], "page": 1, "pageSize": 3})
row = next((c for c in page1["contributions"] if c["kind"] == "row"), None)
check("row descriptor present", row is not None)
check("row carries item REFERENCES only, never rendered content",
      all(set(i) == {"itemId", "label"} for i in row["items"]))
check("row is paginated and says whether more exists",
      row["page"] == 1 and len(row["items"]) == 3 and row["hasMore"] is True)

_, page3 = call("/Ep00Spike/Native/Catalog", {"components": ["row"], "page": 3, "pageSize": 3})
last = next(c for c in page3["contributions"] if c["kind"] == "row")
check("the final page reports no more", last["hasMore"] is False and len(last["items"]) == 1)

# 3. Graceful omission ---------------------------------------------------------
check("a client that cannot render an action never receives one",
      all(c["kind"] == "row" for c in page1["contributions"]))
check("omissions are reported with a reason",
      {o["kind"] for o in page1["omitted"]} == {"detail-action", "badge"}
      and all(o["reason"] == "component_not_supported_by_client" for o in page1["omitted"]))

# 4. A detail action carries confirmation and an opaque capability -------------
_, full = call("/Ep00Spike/Native/Catalog", {"components": ["row", "detail-action"], "pageSize": 3})
action = next(c for c in full["contributions"] if c["kind"] == "detail-action")
check("action declares a confirmation step the client renders natively",
      set(action["confirm"]) == {"title", "confirmLabel", "cancelLabel"})
check("action exposes an OPAQUE capability, never a provider method name",
      action["action"]["kind"] == "opaque" and "capability" in action["action"]
      and "method" not in json.dumps(action["action"]))

capability = action["action"]["capability"]

# 5. Every refusal is a distinct, actionable state -----------------------------
_, ok = call(f"/Ep00Spike/Native/Invoke?capability={urllib.parse.quote(capability)}", method="POST")
check("a valid capability is accepted once", ok.get("ok") is True, str(ok.get("error")))

_, replay = call(f"/Ep00Spike/Native/Invoke?capability={urllib.parse.quote(capability)}", method="POST")
check("replaying it is refused with its own code", replay.get("error") == "action_replayed", str(replay.get("error")))

_, missing = call("/Ep00Spike/Native/Invoke", method="POST")
check("a missing capability is its own code", missing.get("error") == "action_missing")

_, forged = call(f"/Ep00Spike/Native/Invoke?capability={urllib.parse.quote(capability[:-4] + 'dead')}", method="POST")
check("a forged signature is refused", forged.get("error") == "action_signature_invalid", str(forged.get("error")))

if TOKEN2:
    _, other = call("/Ep00Spike/Native/Catalog", {"components": ["detail-action"]}, token=TOKEN2)
    other_capability = next(c for c in other["contributions"] if c["kind"] == "detail-action")["action"]["capability"]
    _, crossed = call(f"/Ep00Spike/Native/Invoke?capability={urllib.parse.quote(other_capability)}", method="POST")
    check("another user's capability is refused, distinctly from expiry",
          crossed.get("error") == "action_wrong_user", str(crossed.get("error")))

_, fresh = call("/Ep00Spike/Native/Catalog", {"components": ["detail-action"]})
down_capability = next(c for c in fresh["contributions"] if c["kind"] == "detail-action")["action"]["capability"]
_, down = call(f"/Ep00Spike/Native/Invoke?capability={urllib.parse.quote(down_capability)}&providerDown=true", method="POST")
check("a provider outage is distinguishable from a permission problem",
      down.get("error") == "provider_unavailable", str(down.get("error")))

# 6. Platform absent -----------------------------------------------------------
status, _ = call("/Ep00Spike/Native/Catalog", {"components": ["row"]}, token="not-a-real-token")
check("an unauthenticated client gets 401, not a malformed catalog", status == 401, f"HTTP {status}")

print()
failed = [name for name, ok_, _ in results if not ok_]
print(json.dumps({
    "checks": len(results),
    "passed": len(results) - len(failed),
    "failed": failed,
}, indent=2))
sys.exit(1 if failed else 0)
