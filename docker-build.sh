#!/bin/bash -ex

while [[ $# -gt 0 ]] ; do
  key="$1"
  case "$key" in
      -s|--scratch)
      scratch=1
      shift
      ;;
      *)
      break
      ;;    
  esac
done

cd $(dirname $0)
if [ -d ".deployer" ]; then
  (cd .deployer ; git pull )  
else
  git clone --depth=1 --single-branch git@github.com:dickmao/deployer.git .deployer
fi

if [ ! -z $(docker ps -aq --filter "name=scrapoxy") ]; then
  docker rm -f $(docker ps -aq --filter "name=scrapoxy")
fi

cat > ./Dockerfile.tmp <<EOF
FROM node:alpine
MAINTAINER dick <noreply@shunyet.com>
WORKDIR /app
RUN set -xe \
RUN apk --no-cache update && \
    apk --no-cache add python py-pip py-setuptools ca-certificates groff less curl && \
    pip --no-cache-dir install awscli && \
    rm -rf /var/cache/apk/*
COPY . .
RUN npm install -g .
EOF

.deployer/ecr-build-and-push.sh ./Dockerfile.tmp scrapoxy:latest

rm ./Dockerfile.tmp

