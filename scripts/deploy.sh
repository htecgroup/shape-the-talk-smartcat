#!/usr/bin/env bash
# Redeploy the current checkout to Azure Container Apps: build in ACR, then point the app at the new image.
# Secrets live on the container app and survive redeploys; this script never touches them.
set -euo pipefail

SUBSCRIPTION=099d83ee-3a96-4f7e-b5d3-d27d1628fac3   # HTEC_FDE_PROTOTYPING
RESOURCE_GROUP=rg-shape-the-talk
REGISTRY=crshapethetalk
APP=shape-the-talk
IMAGE=shape-the-talk

export PYTHONWARNINGS=ignore   # silence az CLI SyntaxWarnings
cd "$(dirname "$0")/.."
TAG=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain)" ]; then   # uncommitted changes: unique tag so a new revision rolls out
  TAG="$TAG-dirty-$(date +%Y%m%d%H%M%S)"
  echo "warning: uncommitted changes are included in image $TAG" >&2
fi

az acr build --subscription "$SUBSCRIPTION" -r "$REGISTRY" -t "$IMAGE:$TAG" -t "$IMAGE:latest" .
az containerapp update --subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP" -n "$APP" \
  --image "$REGISTRY.azurecr.io/$IMAGE:$TAG" --query properties.latestRevisionName -o tsv
echo "https://$(az containerapp show --subscription "$SUBSCRIPTION" -g "$RESOURCE_GROUP" -n "$APP" \
  --query properties.configuration.ingress.fqdn -o tsv)"
