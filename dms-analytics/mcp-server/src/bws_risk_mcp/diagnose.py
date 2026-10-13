"""Connection diagnostic for the BWS Risk Desk MCP server.

Run on the firm laptop to discover which API base path and which Windows
sign-in method reach the on-premises iManage server. Read-only: it only
sends GET requests to listing endpoints. Prints a report and, if it finds
a working combination, the config to save.

Usage:
    bws-risk-diagnose
    bws-risk-diagnose --base-url https://dms.byrnewallace.com
"""

from __future__ import annotations

import argparse
import json
import sys

import requests

from .config import Config, CONFIG_FILE

# Candidate base paths seen across on-prem iManage Work deployments.
CANDIDATE_PATHS = [
    "/work/api/v2/libraries",
    "/work/api/v1/libraries",
    "/api/v2/libraries",
    "/api/v1/libraries",
]

# Sign-in methods to try, best first.
CANDIDATE_AUTH = ["negotiate", "kerberos", "ntlm"]


def _build_auth(method: str):
    if method == "negotiate":
        try:
            from requests_negotiate_sspi import HttpNegotiateAuth
            return HttpNegotiateAuth()
        except ImportError:
            return None
    if method == "kerberos":
        try:
            from requests_kerberos import HTTPKerberosAuth, OPTIONAL
            return HTTPKerberosAuth(mutual_authentication=OPTIONAL)
        except ImportError:
            return None
    if method == "ntlm":
        import getpass
        import os
        from requests_ntlm import HttpNtlmAuth
        domain = os.environ.get("USERDOMAIN", "")
        user = os.environ.get("USERNAME", getpass.getuser())
        who = f"{domain}\\{user}" if domain else user
        return HttpNtlmAuth(who, "")
    return None


def _probe(base_url: str, path: str, method: str, verify: bool, timeout: int):
    auth = _build_auth(method)
    if auth is None:
        return {"auth": method, "path": path, "result": "auth-library-missing"}
    url = f"{base_url.rstrip('/')}{path}"
    try:
        resp = requests.get(
            url, auth=auth, timeout=timeout, verify=verify,
            headers={"Accept": "application/json"},
        )
    except requests.exceptions.SSLError as e:
        return {"auth": method, "path": path, "result": f"ssl-error: {e}"}
    except requests.exceptions.ConnectionError as e:
        return {"auth": method, "path": path, "result": f"no-connection: {e}"}
    except Exception as e:  # noqa: BLE001
        return {"auth": method, "path": path, "result": f"error: {type(e).__name__}: {e}"}

    out = {"auth": method, "path": path, "status_code": resp.status_code}
    if resp.status_code == 200:
        try:
            body = resp.json()
            n = len(body.get("data", body)) if isinstance(body, dict) else len(body)
            out["result"] = f"OK ({n} items)"
            out["working"] = True
        except ValueError:
            out["result"] = "200 but not JSON (probably a login page, not the API)"
    elif resp.status_code == 401:
        out["result"] = "401 unauthorized (sign-in method rejected)"
    elif resp.status_code == 404:
        out["result"] = "404 not found (wrong path)"
    else:
        out["result"] = f"HTTP {resp.status_code}"
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Diagnose iManage connectivity")
    ap.add_argument("--base-url", default=None, help="Override the server URL")
    ap.add_argument("--no-verify", action="store_true",
                    help="Skip TLS verification (internal CA)")
    args = ap.parse_args()

    cfg = Config.load()
    base_url = args.base_url or cfg.base_url
    verify = cfg.verify_ssl and not args.no_verify

    print(f"Diagnosing iManage at: {base_url}")
    print(f"TLS verification: {'on' if verify else 'OFF'}")
    print("-" * 60)

    results = []
    working = None
    for path in CANDIDATE_PATHS:
        for method in CANDIDATE_AUTH:
            r = _probe(base_url, path, method, verify, cfg.timeout_seconds)
            results.append(r)
            tag = "  WORKS ->" if r.get("working") else "          "
            print(f"{tag} {method:10s} {path:28s} {r['result']}")
            if r.get("working") and working is None:
                working = r

    print("-" * 60)
    if working:
        api_version = "v2" if "/v2/" in working["path"] else "v1"
        print(f"\nSUCCESS. Working combination:")
        print(f"  Sign-in : {working['auth']}")
        print(f"  Path    : {working['path']}")
        print(f"\nRecommended config (save to {CONFIG_FILE}):")
        rec = {
            "base_url": base_url,
            "api_version": api_version,
            "auth_method": working["auth"],
            "verify_ssl": verify,
            "timeout_seconds": cfg.timeout_seconds,
            "max_results": cfg.max_results,
        }
        print(json.dumps(rec, indent=2))
        print("\nWriting this config now...")
        new_cfg = Config(**rec)
        new_cfg.save()
        print(f"Saved. Restart Claude Desktop and test the connection.")
    else:
        print("\nNo working combination found. Most useful signals above:")
        print("  - all '404 not found'  -> the base URL or /work prefix is wrong;")
        print("    open iManage in your browser and note the real URL.")
        print("  - all '401 unauthorized' -> the API needs an OAuth token, not")
        print("    Windows sign-in; the app must be registered in iManage.")
        print("  - 'no-connection' -> not on the firm network/VPN, or wrong host.")
        print("  - 'ssl-error' -> internal CA; re-run with --no-verify.")
        sys.exit(1)


if __name__ == "__main__":
    main()
