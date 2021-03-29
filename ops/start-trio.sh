#!/usr/bin/env bash
set -e

stack="trio"
root=$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." >/dev/null 2>&1 && pwd )
project=$(grep -m 1 '"name":' "$root/package.json" | cut -d '"' -f 4)

# make sure a network for this project has been created
docker swarm init 2> /dev/null || true
docker network create --attachable --driver overlay "$project" 2> /dev/null || true

if grep -qs "$stack" <<<"$(docker stack ls --format '{{.Name}}')"
then echo "A $stack stack is already running" && exit 0;
fi

####################
## Load Config

if [[ ! -f "$root/node.config.json" ]]
then cp "$root/ops/config/node.default.json" "$root/node.config.json"
fi
if [[ ! -f "$root/router.config.json" ]]
then cp "$root/ops/config/router.default.json" "$root/router.config.json"
fi

config=$(
  cat "$root/node.config.json" "$root/router.config.json" \
  | jq -s '.[0] + .[1] + .[2] + .[3]'
)

function getConfig {
  value=$(echo "$config" | jq ".$1" | tr -d '"')
  if [[ "$value" == "null" ]]
  then echo ""
  else echo "$value"
  fi
}

messaging_url=$(getConfig messagingUrl)

chain_providers=$(echo "$config" | jq '.chainProviders' | tr -d '\n\r ')
default_providers=$(jq '.chainProviders' "$root/ops/config/node.default.json" | tr -d '\n\r ')

common="networks:
      - '$project'
    logging:
      driver: 'json-file'
      options:
          max-size: '100m'"

####################
## Start dependency stacks

if [[ "$chain_providers" == "$default_providers" ]]
then
  bash "$root/ops/start-chains.sh"
  config=$(
    echo "$config" '{"chainAddresses":'"$(cat "$root/.chaindata/chain-addresses.json")"'}' \
    | jq -s '.[0] + .[1]'
  )
fi

if [[ -z "$messaging_url" ]]
then bash "$root/ops/start-messaging.sh"
fi

echo
echo "Preparing to launch $stack stack"

########################################
## Node config

internal_node_port="8000"
internal_prisma_port="5555"

carol_node_port="8005"
carol_prisma="5555"
carol_mnemonic="owner warrior discover outer physical intact secret goose all photo napkin fall"
echo "$stack.carol will be exposed on *:$carol_node_port"

dave_node_port="8006"
dave_prisma="5556"
dave_mnemonic="woman benefit lawn ignore glove marriage crumble roast tool area cool payment"
echo "$stack.dave will be exposed on *:$dave_node_port"

roger_node_port="8007"
roger_prisma="5557"
roger_mnemonic="spice notable wealth rail voyage depth barely thumb skill rug panel blush"
echo "$stack.roger will be exposed on *:$roger_node_port"

config=$(echo "$config" '{"nodeUrl":"http://roger:'$internal_node_port'"}' | jq -s '.[0] + .[1]')

public_url="http://localhost:$roger_node_port"

node_image="image: '${project}_builder'
    entrypoint: 'bash modules/server-node/ops/entry.sh'
    volumes:
      - '$root:/root'
    tmpfs: /tmp"

node_env="environment:
      VECTOR_CONFIG: '$config'"

########################################
## Router config

router_port="8000"
router_public_port="8009"
echo "$stack.router will be exposed on *:$router_public_port"

router_image="image: '${project}_builder'
    entrypoint: 'bash modules/router/ops/entry.sh'
    volumes:
      - '$root:/root'
    ports:
      - '$router_public_port:$router_port'"

####################
# Observability tools config

grafana_image="grafana/grafana:latest"
bash "$root/ops/pull-images.sh" "$grafana_image" > /dev/null

prometheus_image="prom/prometheus:latest"
bash "$root/ops/pull-images.sh" "$prometheus_image" > /dev/null

cadvisor_image="gcr.io/google-containers/cadvisor:latest"
bash "$root/ops/pull-images.sh" "$cadvisor_image" > /dev/null

prometheus_services="prometheus:
    image: $prometheus_image
    $common
    ports:
      - 9090:9090
    command:
      - --config.file=/etc/prometheus/prometheus.yml
    volumes:
      - $root/ops/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
  cadvisor:
    $common
    image: $cadvisor_image
    ports:
      - 8081:8080
    volumes:
      - /:/rootfs:ro
      - /var/run:/var/run:rw
      - /sys:/sys:ro
      - /var/lib/docker/:/var/lib/docker:ro"

grafana_service="grafana:
    image: '$grafana_image'
    $common
    networks:
      - '$project'
    ports:
      - '3008:3000'
    volumes:
      - '$root/ops/grafana/grafana:/etc/grafana'
      - '$root/ops/grafana/dashboards:/etc/dashboards'"

observability_services="$prometheus_services
  $grafana_service"

####################
# Launch stack

docker_compose=$root/.${stack}.docker-compose.yml
rm -f "$docker_compose"
cat - > "$docker_compose" <<EOF
version: '3.4'

networks:
  $project:
    external: true

services:

  carol:
    $common
    $node_image
    $node_env
      VECTOR_MNEMONIC: '$carol_mnemonic'
    ports:
      - '$carol_node_port:$internal_node_port'
      - '$carol_prisma:$internal_prisma_port'

  dave:
    $common
    $node_image
    $node_env
      VECTOR_MNEMONIC: '$dave_mnemonic'
    ports:
      - '$dave_node_port:$internal_node_port'
      - '$dave_prisma:$internal_prisma_port'

  roger:
    $common
    $node_image
    $node_env
      VECTOR_MNEMONIC: '$roger_mnemonic'
    ports:
      - '$roger_node_port:$internal_node_port'
      - '$roger_prisma:$internal_prisma_port'

  router:
    $common
    $router_image
    environment:
      VECTOR_CONFIG: '$config'
      VECTOR_NODE_URL: 'http://roger:$internal_node_port'
      VECTOR_PORT: '$router_port'
      VECTOR_MNEMONIC: '$roger_mnemonic'

  $observability_services

EOF

docker stack deploy -c "$docker_compose" "$stack"

echo "The $stack stack has been deployed, waiting for $public_url to start responding.."
timeout=$(( $(date +%s) + 300 ))
while true
do
  res=$(curl -k -m 5 -s $public_url || true)
  if [[ -z "$res" || "$res" == "Waiting for proxy to wake up" ]]
  then
    if [[ "$(date +%s)" -gt "$timeout" ]]
    then echo "Timed out waiting for proxy to respond.." && exit
    else sleep 2
    fi
  else echo "Good Morning!" && exit;
  fi
done
