#!/usr/bin/env bash
#
# Create the instance, from AWS CloudShell. Paste this whole file in, or:
#
#   bash launch-ec2.sh
#
# CloudShell is already signed in as you, so there is no key to configure and
# nothing secret to paste anywhere. Everything it makes is named `lampcode`,
# and re-running reuses what exists rather than making a second copy — so a
# half-finished run is fixed by running it again.
#
# It prints the exact next command at the end. Nothing here is destructive.
set -euo pipefail

NAME=lampcode
# The Bedrock gateway this app calls lives in ap-southeast-2. Same region keeps
# the hop short and the account tidy.
REGION="${AWS_REGION:-ap-southeast-2}"
TYPE="${INSTANCE_TYPE:-t4g.small}"
DISK_GB=20

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mSTOP: %s\033[0m\n' "$*" >&2; exit 1; }

command -v aws >/dev/null || die "no aws CLI — are you in CloudShell?"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
say "Account ${ACCOUNT:0:4}****${ACCOUNT: -2}, region $REGION, type $TYPE"

# ── The image ────────────────────────────────────────────────────────────────
# Canonical publishes the current AMI id in SSM, so this always gets the latest
# patched 24.04 for arm64. A hardcoded ami-… goes stale and is wrong in every
# other region.
say "Finding the current Ubuntu 24.04 arm64 image"
AMI="$(aws ssm get-parameter --region "$REGION" \
  --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id \
  --query Parameter.Value --output text)"
[[ "$AMI" == ami-* ]] || die "could not resolve the Ubuntu AMI (got: $AMI)"
note "$AMI"

# ── The key ──────────────────────────────────────────────────────────────────
# Created here and left in CloudShell's home, which persists between sessions.
# AWS shows the private key ONCE, at creation — if this file is lost the only
# way back in is a new instance, so it is never overwritten silently.
if [[ -f "$HOME/$NAME.pem" ]]; then
  say "Key file already here: ~/$NAME.pem"
else
  if aws ec2 describe-key-pairs --region "$REGION" --key-names "$NAME" >/dev/null 2>&1; then
    die "a key pair named '$NAME' exists in AWS but ~/$NAME.pem is gone, and AWS cannot show it again.
     Delete it and re-run:  aws ec2 delete-key-pair --region $REGION --key-name $NAME"
  fi
  say "Creating the key pair"
  aws ec2 create-key-pair --region "$REGION" --key-name "$NAME" \
    --query KeyMaterial --output text > "$HOME/$NAME.pem"
  chmod 400 "$HOME/$NAME.pem"
  note "saved to ~/$NAME.pem — back this up"
fi

# ── Networking ───────────────────────────────────────────────────────────────
VPC="$(aws ec2 describe-vpcs --region "$REGION" \
  --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
[[ "$VPC" == vpc-* ]] || die "no default VPC in $REGION"

SG="$(aws ec2 describe-security-groups --region "$REGION" \
  --filters Name=group-name,Values="$NAME" Name=vpc-id,Values="$VPC" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)"
if [[ "$SG" == "None" || -z "$SG" ]]; then
  say "Creating the security group"
  SG="$(aws ec2 create-security-group --region "$REGION" --group-name "$NAME" \
    --description "Lampcode backend" --vpc-id "$VPC" --query GroupId --output text)"
fi
note "$SG"

# 80 is not optional even though the site runs on 443: Let's Encrypt verifies
# over port 80, and a closed 80 is the single most common reason the
# certificate never arrives.
#
# 22 is open to the internet because you will connect from CloudShell, whose
# address changes. Ubuntu's image accepts keys only — password login is off —
# so this is the normal shape, not a hole. To narrow it later:
#   aws ec2 revoke-security-group-ingress --region $REGION --group-id $SG \
#     --protocol tcp --port 22 --cidr 0.0.0.0/0
say "Opening 22, 80 and 443"
for PORT in 22 80 443; do
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" \
    --protocol tcp --port "$PORT" --cidr 0.0.0.0/0 >/dev/null 2>&1 \
    && note "$PORT opened" || note "$PORT already open"
done

# ── The instance ─────────────────────────────────────────────────────────────
EXISTING="$(aws ec2 describe-instances --region "$REGION" \
  --filters Name=tag:Name,Values="$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo None)"
if [[ "$EXISTING" != "None" && -n "$EXISTING" ]]; then
  say "An instance tagged '$NAME' already exists: $EXISTING"
  note "not creating a second one. To start over:"
  note "  aws ec2 terminate-instances --region $REGION --instance-ids $EXISTING"
  ID="$EXISTING"
else
  say "Launching $TYPE with ${DISK_GB}GB"
  ID="$(aws ec2 run-instances --region "$REGION" \
    --image-id "$AMI" --instance-type "$TYPE" --key-name "$NAME" \
    --security-group-ids "$SG" \
    --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$DISK_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
    --metadata-options "HttpTokens=optional" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)"
  note "$ID"
fi

say "Waiting for it to come up"
aws ec2 wait instance-running --region "$REGION" --instance-ids "$ID"
IP="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
[[ "$IP" != "None" && -n "$IP" ]] || die "the instance is running but has no public IP"

printf '\n\033[1;32m================================================\n'
printf '  Instance : %s\n' "$ID"
printf '  Public IP: %s\n' "$IP"
printf '  Backend  : https://%s.sslip.io   (once bootstrap runs)\n' "$IP"
printf '================================================\033[0m\n\n'
printf 'It takes ~40s before sshd answers. Then, from here:\n\n'
printf '  ssh -i ~/%s.pem -o StrictHostKeyChecking=accept-new ubuntu@%s\n\n' "$NAME" "$IP"
printf 'Send that Instance ID and IP back, and keep going with deploy/aws/README.md step 3.\n\n'
