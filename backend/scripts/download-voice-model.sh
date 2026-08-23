#!/bin/sh
# Downloads the Vosk small-en-us speech recognition model for local STT (MYAG-134).
#
# Run once on the server host before `docker compose up`. The model is served at
#   /voice-model/vosk-model-small-en-us-0.15.tar.gz   (same-origin, HAI-hosted)
# and cached per-browser in IndexedDB after first download — no re-fetch after that.
# Audio and transcripts never leave the user's device.
#
# Model details
#   Name    : vosk-model-small-en-us-0.15
#   License : Apache-2.0  (https://alphacephei.com/vosk/models)
#   Source  : https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.tar.gz
#   Size    : ~40 MB
#   Accuracy: >95% on short command phrases (<20-word vocabulary)
#
# Integrity: after download, run:
#   sha256sum frontend/voice-model/vosk-model-small-en-us-0.15.tar.gz
# and cross-check against the alphacephei.com/vosk/models page checksum for this release.
#
# Requires: curl (present on Ubuntu 24.04 by default)

set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$REPO_ROOT/frontend/voice-model"
MODEL="vosk-model-small-en-us-0.15.tar.gz"
TARGET="$DEST/$MODEL"
URL="https://alphacephei.com/vosk/models/$MODEL"

mkdir -p "$DEST"

if [ -f "$TARGET" ]; then
    echo "Voice model already present at $TARGET"
    echo "To re-download, delete the file and run this script again."
    exit 0
fi

echo "Downloading $MODEL (~40 MB, one-time setup)..."
curl -L --fail --progress-bar -o "$TARGET" "$URL"
echo ""
echo "Voice model ready at $TARGET"
echo "Size: $(du -sh "$TARGET" | cut -f1)"
echo ""
echo "Verify integrity by checking the SHA-256 against alphacephei.com/vosk/models:"
echo "  sha256sum $TARGET"
echo ""
echo "Next: docker compose up --build"
echo "(model is served via the existing ./frontend:/usr/src/app/public volume mount)"
