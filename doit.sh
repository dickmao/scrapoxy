#!/bin/sh -xe

vpc=$(curl -s http://169.254.169.254/latest/meta-data/network/interfaces/macs/$(curl -s http://169.254.169.254/latest/meta-data/mac)/vpc-id)

if ! aws ec2 describe-security-groups --output text --filters Name=vpc-id,Values=$vpc,Name=group-name,Values=forward-proxy | grep -q . ; then
  sgid=$(aws ec2 create-security-group --description forward-proxy --group-name forward-proxy --vpc-id $vpc --output text)
  aws ec2 authorize-security-group-ingress --group-id $sgid --protocol tcp --port 3128 --cidr 0.0.0.0/0
fi

if ! aws ec2 describe-images --filter Name=name,Values=forward-proxy --output text | grep -q . ; then
  waitfor=$(aws ec2 copy-image --name forward-proxy --source-image-id ami-06220275 --source-region eu-west-1 --output text)
  while aws ec2 describe-images --image-ids $waitfor --output text | grep -q pending ; do 
    sleep 10
  done
fi

PROVIDERS_AWSEC2_INSTANCE_IMAGEID=$(aws ec2 describe-images --filter Name=name,Values=forward-proxy --output text | head -1 | awk '{ print $6 }' ) scrapoxy start tools/docker/config.js -d
