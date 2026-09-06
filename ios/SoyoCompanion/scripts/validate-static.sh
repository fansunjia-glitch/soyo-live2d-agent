#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$script_dir/.." && pwd)"
app_dir="$project_dir/SoyoCompanion"
test_dir="$project_dir/SoyoCompanionTests"
project_yml="$project_dir/project.yml"
info_plist="$app_dir/Info.plist"

for command_name in xcrun plutil python3 ruby; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "error: required command not found: $command_name" >&2
        exit 1
    fi
done

required_files=(
    "$project_yml"
    "$info_plist"
    "$app_dir/App/SoyoCompanionApp.swift"
    "$app_dir/App/AppModel.swift"
    "$app_dir/Models/ProtocolModels.swift"
    "$app_dir/Networking/DeviceWebSocketClient.swift"
    "$app_dir/Security/CommandSecurity.swift"
    "$test_dir/CommandSecurityTests.swift"
)
for required_file in "${required_files[@]}"; do
    if [[ ! -f "$required_file" ]]; then
        echo "error: missing required project file: $required_file" >&2
        exit 1
    fi
done

swift_files=()
while IFS= read -r swift_file; do
    swift_files+=("$swift_file")
done < <(find "$app_dir" "$test_dir" -type f -name '*.swift' -print | LC_ALL=C sort)

if [[ ${#swift_files[@]} -eq 0 ]]; then
    echo "error: no Swift sources found" >&2
    exit 1
fi
for swift_file in "${swift_files[@]}"; do
    xcrun swiftc -parse "$swift_file"
done
echo "ok: parsed ${#swift_files[@]} Swift source files"

plutil -lint "$info_plist"

python3 - "$info_plist" "$app_dir/Models/ProtocolModels.swift" <<'PY'
import plistlib
import sys
from pathlib import Path

plist_path = Path(sys.argv[1])
protocol_path = Path(sys.argv[2])

with plist_path.open("rb") as handle:
    plist = plistlib.load(handle)

ats = plist.get("NSAppTransportSecurity", {})
assert ats.get("NSAllowsArbitraryLoads") is False, "ATS must keep arbitrary loads disabled"
assert ats.get("NSAllowsLocalNetworking") is True, "local development networking declaration is missing"
for key in (
    "NSCameraUsageDescription",
    "NSLocationWhenInUseUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSLocalNetworkUsageDescription",
):
    assert isinstance(plist.get(key), str) and plist[key].strip(), f"missing {key}"

protocol_source = protocol_path.read_text(encoding="utf-8")
required_contract_markers = (
    "static let currentVersion = 1",
    "static let maximumCommandTTL: Int64 = 30_000",
    "static let maximumMessageBytes = 2_000_000",
    'static let jpegDataURLPrefix = "data:image/jpeg;base64,"',
    "let issuedAt: Int64",
    "let expiresAt: Int64",
    "let nonce: String",
    "let approvalPolicy: [String: Bool]",
    'type: "command_result"',
    'type: "approval_result"',
    'type: "screen_frame"',
)
missing = [marker for marker in required_contract_markers if marker not in protocol_source]
assert not missing, "protocol contract markers missing: " + ", ".join(missing)
print("ok: plist policy and protocol-v1 markers validated")
PY

ruby - "$project_yml" <<'RUBY'
require "yaml"

path = ARGV.fetch(0)
project = YAML.load_file(path)
raise "project.yml must contain a mapping" unless project.is_a?(Hash)
raise "unexpected project name" unless project["name"] == "SoyoCompanion"

targets = project.fetch("targets")
app = targets.fetch("SoyoCompanion")
tests = targets.fetch("SoyoCompanionTests")
raise "SoyoCompanion must be an iOS application" unless app["type"] == "application" && app["platform"] == "iOS"
raise "SoyoCompanionTests must be an iOS unit-test bundle" unless tests["type"] == "bundle.unit-test" && tests["platform"] == "iOS"

app_sources = app.fetch("sources").map { |source| source.is_a?(Hash) ? source["path"] : source }
test_sources = tests.fetch("sources").map { |source| source.is_a?(Hash) ? source["path"] : source }
raise "application source root is missing" unless app_sources.include?("SoyoCompanion")
raise "test source root is missing" unless test_sources.include?("SoyoCompanionTests")

dependencies = tests.fetch("dependencies").map { |dependency| dependency["target"] if dependency.is_a?(Hash) }
raise "test target must depend on SoyoCompanion" unless dependencies.include?("SoyoCompanion")

plist_setting = app.dig("settings", "base", "INFOPLIST_FILE")
raise "Info.plist path is inconsistent" unless plist_setting == "SoyoCompanion/Info.plist"
puts "ok: project.yml syntax and target structure validated"
RUBY

echo "Static validation passed (Swift parse only; iOS SDK type-check/build was not run)."
