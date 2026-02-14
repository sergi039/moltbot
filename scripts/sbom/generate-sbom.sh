#!/usr/bin/env bash
# Generate SBOM (Software Bill of Materials) in CycloneDX JSON format.
# Requires: @cyclonedx/cyclonedx-npm (installed as devDependency or via npx).
#
# Usage:
#   ./scripts/sbom/generate-sbom.sh [output-dir]
#
# Output: <output-dir>/sbom.cdx.json (CycloneDX JSON)

set -euo pipefail

OUTPUT_DIR="${1:-dist}"
SBOM_FILE="${OUTPUT_DIR}/sbom.cdx.json"

mkdir -p "$OUTPUT_DIR"

echo "Generating SBOM (CycloneDX JSON)..."

# Prefer local install, fall back to npx
if command -v cyclonedx-npm &>/dev/null; then
  cyclonedx-npm --output-file "$SBOM_FILE" --output-format JSON --spec-version 1.5 --omit dev
elif command -v npx &>/dev/null; then
  npx --yes @cyclonedx/cyclonedx-npm --output-file "$SBOM_FILE" --output-format JSON --spec-version 1.5 --omit dev
else
  echo "ERROR: cyclonedx-npm not found. Install @cyclonedx/cyclonedx-npm or ensure npx is available."
  exit 1
fi

# Validate output exists and is non-empty
if [ ! -s "$SBOM_FILE" ]; then
  echo "ERROR: SBOM generation produced empty output at $SBOM_FILE"
  exit 1
fi

COMPONENT_COUNT=$(python3 -c "
import json, sys
with open('$SBOM_FILE') as f:
    data = json.load(f)
count = len(data.get('components', []))
print(count)
" 2>/dev/null || echo "unknown")

echo "SBOM generated: $SBOM_FILE ($COMPONENT_COUNT components)"
