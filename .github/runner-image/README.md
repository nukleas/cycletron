# Cycletron self-hosted runner image

Custom runner image for the `cycletron-runners` ARC scale set (home k3s cluster).
Bakes the Tauri/MIDI apt deps so ephemeral runners skip the ~2 min install each
run. See `Dockerfile` for what's in it and why the Rust toolchain is *not* baked
(it lives in the node-local hostPath cache instead).

## Build & publish (needs a registry credential — pick one)

The cluster nodes are **amd64**, so build for `linux/amd64`.

### Option A — GitHub Container Registry (public image, no pull secret)
Matches how the stock runner is pulled. Needs a PAT with `write:packages`.

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u nukleas --password-stdin
docker buildx build --platform linux/amd64 \
  -t ghcr.io/nukleas/cycletron-runner:latest \
  --push .github/runner-image
# make the package public once, in GitHub → Packages → cycletron-runner → visibility
```

### Option B — self-hosted gitea registry (no external creds)
Needs a gitea user token and the registry host reachable from your build host.

```bash
docker login <gitea-host> -u <user> -p <token>
docker buildx build --platform linux/amd64 \
  -t <gitea-host>/nukleas/cycletron-runner:latest --push .github/runner-image
# add an imagePullSecret to the arc-runners namespace and reference it in the
# scale set template if the registry is private.
```

## Point the scale set at the image

Edit the runner values (`cycletron-runners-values.yaml`) →
`template.spec.containers[runner].image` to the pushed tag, then:

```bash
helm upgrade cycletron-runners \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set \
  --version 0.14.2 --namespace arc-runners -f cycletron-runners-values.yaml
```

Because the deps are baked, the `System dependencies (Linux)` step in
`ci.yml` becomes a fast "already newest" no-op on these runners (and still
installs on GitHub-hosted fallback).
