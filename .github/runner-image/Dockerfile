# Custom GitHub Actions runner image for Cycletron self-hosted CI.
#
# Bakes the Tauri/MIDI system dependencies so the ephemeral k8s runners don't
# apt-install them on every run (~2 min saved/run). The Rust toolchain and
# compiled artifacts are NOT baked here — they persist in the node-local
# hostPath cache the scale set mounts (CARGO_HOME / CARGO_TARGET_DIR /
# RUSTUP_HOME under /cache), which is the larger speedup.
#
# Build for amd64 (the cluster nodes) and push to a registry the cluster can
# pull from, then set the scale set's runner image to it. See README.md.
FROM ghcr.io/actions/actions-runner:latest

USER root

# Tauri (webkit/gtk/soup/appindicator/rsvg) + MIDI (alsa/udev) + Rust build
# prerequisites. Matches the apt step in .github/workflows/ci.yml so that CI is
# identical whether it lands here or on a GitHub-hosted runner.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config libssl-dev curl git file ca-certificates \
      libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
      libjavascriptcoregtk-4.1-dev libappindicator3-dev librsvg2-dev \
      libasound2-dev libudev-dev patchelf xdg-utils \
    && rm -rf /var/lib/apt/lists/*

USER runner
