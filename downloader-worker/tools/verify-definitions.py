"""Run inside the candidate, offline, without touching a production instance."""
import json
import tempfile
import time
import sys
from pathlib import Path
from scanner import require_fresh_clamav_definitions, require_yara_rules, _scan_malware, _scan_yara, UnsafeFile


def verify(definitions_only=False):
    now = int(time.time())
    status = require_fresh_clamav_definitions(now=now)
    assert status["maxAgeSeconds"] == 604800, "definition_lifetime_changed"
    assert now - status["dailyDefinitionUnix"] < 5 * 86400, "candidate_too_old"
    assert all(0 < item["buildUnix"] <= now + 300 for item in status["databases"].values()), "invalid_definition_time"
    require_yara_rules()
    report = {"definitionUnix": status["dailyDefinitionUnix"], "verifiedAt": now, "maxAgeSeconds": 604800, "verified": True}
    if definitions_only:
        return report
    with tempfile.TemporaryDirectory(dir="/work") as root:
        clean = Path(root) / "clean.txt"
        clean.write_text("Downloader harmless definition update test", encoding="ascii")
        _scan_malware(clean)
        _scan_yara(clean)
        eicar = Path(root) / "eicar.txt"
        eicar.write_bytes(b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")
        try:
            _scan_malware(eicar)
        except UnsafeFile as error:
            assert str(error) == "malware_detected", "eicar_scan_error"
        else:
            raise AssertionError("eicar_not_detected")
    return report


if __name__ == "__main__":
    print(json.dumps(verify(definitions_only=sys.argv[1:] == ['--definitions-only'])))
