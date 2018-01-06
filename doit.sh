#!/bin/sh -xe

finish() {
    if [ ! -z $sgid ]; then
        inprog=0
        while [ $inprog -lt 50 ] && ! aws ec2 delete-security-group --group-id $sgid ; do
            echo DELETE_IN_PROGRESS...
            let inprog=inprog+1
            sleep 10
        done
    fi
}

killchild() {
    trap '' TERM
    if [ ! -z $pid ]; then
        kill -TERM $pid
    fi
    false # -e makes it go to finish
}

trap finish EXIT
trap killchild TERM INT TERM HUP

vpc=$(curl -s http://169.254.169.254/latest/meta-data/network/interfaces/macs/$(curl -s http://169.254.169.254/latest/meta-data/mac)/vpc-id)

sgid=$(aws ec2 describe-security-groups --output text --filters Name=vpc-id,Values=$vpc Name=group-name,Values=forward-proxy | head -1 | awk '{ print $3 }')
if [ -z $sgid ] ; then
  sgid=$(aws ec2 create-security-group --description forward-proxy --group-name forward-proxy --vpc-id $vpc --output text)
  aws ec2 authorize-security-group-ingress --group-id $sgid --protocol tcp --port 3128 --cidr 0.0.0.0/0
fi

if ! aws ec2 describe-images --filter Name=name,Values=forward-proxy --output text | grep -q . ; then
  waitfor=$(aws ec2 copy-image --name forward-proxy --source-image-id ami-06220275 --source-region eu-west-1 --output text)
  while aws ec2 describe-images --image-ids $waitfor --output text | grep -q pending ; do 
    sleep 10
  done
fi

PROVIDERS_AWSEC2_INSTANCE_IMAGEID=$(aws ec2 describe-images --filter Name=name,Values=forward-proxy --output text | head -1 | awk '{ print $6 }' ) 
subnet=$(curl -s http://169.254.169.254/latest/meta-data/network/interfaces/macs/$(curl -s http://169.254.169.254/latest/meta-data/mac)/subnet-id)

cat > ./conf.json <<EOF
{
    "commander": {
        "password": "${COMMANDER_PASSWORD}"
    },
    "instance": {
        "port": 3128,
        "scaling": {
            "min": 1,
            "max": 2
        }
    },
    "providers": {
        "type": "awsec2",
        "awsec2": {
            "accessKeyId": "${AWS_ACCESS_KEY_ID}",
            "secretAccessKey": "${AWS_SECRET_ACCESS_KEY}",
            "region": "${AWS_DEFAULT_REGION}",
            "instance": {
                "InstanceType": "${PROVIDERS_AWSEC2_INSTANCE_INSTANCETYPE}",
                "ImageId": "${PROVIDERS_AWSEC2_INSTANCE_IMAGEID}",
                "SecurityGroupIds": [
                    "${sgid}"
                ],
                "SubnetId": "${subnet}"
            }
        }
    }
}
EOF

scrapoxy start conf.json -d &
pid=$!
wait "$pid"
