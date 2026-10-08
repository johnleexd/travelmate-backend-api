#!/bin/sh
set -eu

: "${TRAVELMATE_IMAGE:?Set TRAVELMATE_IMAGE to the release image digest or tag}"
DEPLOY_DIR=${TRAVELMATE_DEPLOY_DIR:-/root/travelmate-backend-api}
cd "$DEPLOY_DIR/docker"

docker compose version >/dev/null
docker compose -f docker-compose.yaml config --quiet

previous_container=$(docker compose -f docker-compose.yaml ps --quiet app)
previous_image=
if [ -n "$previous_container" ]; then
    previous_image=$(docker inspect --format '{{.Config.Image}}' "$previous_container")
fi

# Keep the current app running while pulling the release and applying migrations.
docker compose -f docker-compose.yaml pull app migrate
docker compose -f docker-compose.yaml run --rm --no-deps migrate

if docker compose -f docker-compose.yaml up --detach --no-deps --wait --wait-timeout 120 app; then
    echo 'TravelMate API deployed and healthy.'
else
    echo 'TravelMate API failed its health check.' >&2
    if [ -n "$previous_image" ] && [ "$previous_image" != "$TRAVELMATE_IMAGE" ]; then
        echo 'Restoring the previous application image; database migrations remain applied.' >&2
        TRAVELMATE_IMAGE=$previous_image
        export TRAVELMATE_IMAGE
        docker compose -f docker-compose.yaml up --detach --no-deps --wait --wait-timeout 120 app
    fi
    exit 1
fi
